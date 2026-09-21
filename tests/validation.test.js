import test from "node:test";
import assert from "node:assert";
import express from "express";
import { ValidationError, createRouter, errorHandler } from "../src/index.js";
import { createMockModel, objectId, withServer } from "./helpers/mockModel.js";

// Custom write validation, and the boundary it runs inside. The field policy
// decides what a *client* may set; the hook decides whether the values make
// sense. These pin the order: a hook running first would be handed fields the
// policy was meant to strip.

const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const buildApp = (options = {}, model = createMockModel()) => {
    const app = express();
    app.use(express.json());
    app.use(
        "/items",
        createRouter({
            model,
            logger: silentLogger,
            allowedFields: ["name", "price"],
            ...options,
        }),
    );
    app.use(errorHandler);
    return { app, model };
};

const send = async (app, method, path, body) => {
    let out;
    await withServer(app, async (base) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        out = { status: res.status, body: await res.json() };
    });
    return out;
};

test("Custom write validation", async (t) => {
    await t.test("a validator can reject with a field map", async () => {
        const { app } = buildApp({
            validate: (payload) => {
                if (payload.price < 0) {
                    throw new ValidationError("Check the submitted values.", {
                        price: "must not be negative",
                    });
                }
            },
        });

        const res = await send(app, "POST", "/items", { name: "Lamp", price: -5 });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.success, false);
        assert.strictEqual(res.body.error, "Check the submitted values.");
        assert.deepStrictEqual(res.body.fields, { price: "must not be negative" });
    });

    await t.test("a passing validator lets the write through untouched", async () => {
        const { app, model } = buildApp({ validate: () => {} });

        const res = await send(app, "POST", "/items", { name: "Lamp", price: 10 });

        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.data.name, "Lamp");
        assert.strictEqual(model.store.size, 1);
    });

    await t.test("a returned object replaces the payload", async () => {
        const { app, model } = buildApp({
            // The shape a hook is actually for: normalising input and setting a
            // server-owned field the client may not touch.
            validate: (payload, ctx) => ({
                ...payload,
                name: payload.name.trim(),
                ownerId: ctx.req.headers["x-user-id"],
            }),
        });

        let out;
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-User-Id": "u-1" },
                body: JSON.stringify({ name: "  Lamp  ", price: 10 }),
            });
            out = { status: res.status, body: await res.json() };
        });

        assert.strictEqual(out.status, 201);
        assert.strictEqual(out.body.data.name, "Lamp");
        assert.strictEqual(out.body.data.ownerId, "u-1");
        assert.strictEqual(model.store.size, 1);
    });

    await t.test("a returned object still cannot smuggle in Mongo syntax", async () => {
        const { app } = buildApp({
            validate: (payload) => ({ ...payload, $set: { role: "admin" }, "a.b": 1 }),
        });

        const res = await send(app, "POST", "/items", { name: "Lamp" });

        assert.strictEqual(res.status, 201);
        assert.ok(!("$set" in res.body.data), "operator key must be stripped");
        assert.ok(!("a.b" in res.body.data), "dotted key must be stripped");
        assert.strictEqual(res.body.data.name, "Lamp");
    });

    await t.test("the hook receives only fields the policy already allowed", async () => {
        let seen = null;
        const { app } = buildApp({
            allowedFields: ["name"],
            validate: (payload) => {
                seen = { ...payload };
            },
        });

        await send(app, "POST", "/items", { name: "Lamp", role: "admin", price: 10 });

        assert.deepStrictEqual(seen, { name: "Lamp" });
    });

    await t.test("create and update validators can differ", async () => {
        const model = createMockModel();
        model.seed([{ _id: objectId(1), name: "Existing" }]);

        const calls = [];
        const { app } = buildApp(
            {
                validate: {
                    create: (payload) => {
                        calls.push("create");
                        if (!payload.name) throw new ValidationError("Name is required.");
                    },
                    update: (payload) => {
                        calls.push("update");
                        if (payload.name === "") throw new ValidationError("Name cannot be empty.");
                    },
                },
            },
            model,
        );

        const created = await send(app, "POST", "/items", { name: "New" });
        assert.strictEqual(created.status, 201);

        const patched = await send(app, "PATCH", `/items/${objectId(1)}`, { name: "" });
        assert.strictEqual(patched.status, 400);
        assert.strictEqual(patched.body.error, "Name cannot be empty.");

        assert.deepStrictEqual(calls, ["create", "update"]);
    });

    await t.test("the update hook knows which record it is validating", async () => {
        const model = createMockModel();
        model.seed([{ _id: objectId(7), name: "Existing" }]);

        let context = null;
        const { app } = buildApp(
            {
                validate: {
                    update: (payload, ctx) => {
                        context = { operation: ctx.operation, id: ctx.id, model: ctx.model === model };
                    },
                },
            },
            model,
        );

        await send(app, "PATCH", `/items/${objectId(7)}`, { name: "Renamed" });

        assert.deepStrictEqual(context, { operation: "update", id: objectId(7), model: true });
    });

    await t.test("an async validator is awaited", async () => {
        const { app } = buildApp({
            validate: async (payload) => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                if (payload.name === "taken") throw new ValidationError("Name is taken.");
            },
        });

        const rejected = await send(app, "POST", "/items", { name: "taken" });
        assert.strictEqual(rejected.status, 400);
        assert.strictEqual(rejected.body.error, "Name is taken.");

        const accepted = await send(app, "POST", "/items", { name: "free" });
        assert.strictEqual(accepted.status, 201);
    });

    await t.test("a validator can choose its own status code", async () => {
        const { app } = buildApp({
            validate: () => {
                throw new ValidationError("Not acceptable here.", undefined, 422);
            },
        });

        const res = await send(app, "POST", "/items", { name: "Lamp" });
        assert.strictEqual(res.status, 422);
        assert.strictEqual(res.body.error, "Not acceptable here.");
    });

    await t.test("an unexpected throw is a 500 that leaks nothing", async () => {
        const { app } = buildApp({
            validate: () => {
                throw new Error("connection string mongodb://user:pw@host/db");
            },
        });

        const res = await send(app, "POST", "/items", { name: "Lamp" });

        assert.strictEqual(res.status, 500);
        assert.strictEqual(res.body.error, "Internal Server Error");
        assert.ok(!JSON.stringify(res.body).includes("mongodb://"));
    });

    await t.test("returning a non-object is reported as the programming error it is", async () => {
        const { app } = buildApp({ validate: () => "looks fine to me" });

        const res = await send(app, "POST", "/items", { name: "Lamp" });

        assert.strictEqual(res.status, 500);
        assert.strictEqual(res.body.error, "Internal Server Error");
    });

    await t.test("no validator configured leaves behaviour unchanged", async () => {
        const { app } = buildApp();

        const created = await send(app, "POST", "/items", { name: "Lamp", role: "admin" });
        assert.strictEqual(created.status, 201);
        assert.strictEqual(created.body.data.role, undefined);

        const empty = await send(app, "POST", "/items", { role: "admin" });
        assert.strictEqual(empty.status, 400);
        assert.match(empty.body.error, /no writable fields/);
    });

    await t.test("Mongoose's own validators still run after the hook", async () => {
        // The mock raises a Mongoose-shaped ValidationError for this name.
        const { app } = buildApp({ validate: () => {}, allowedFields: ["name"] });

        const res = await send(app, "POST", "/items", { name: "TRIGGER_ERROR" });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /Validation Error: Name is required/);
        assert.deepStrictEqual(res.body.fields, { name: "Name is required" });
    });

    await t.test("a duplicate key reports the conflicting field", async () => {
        const { app } = buildApp({ allowedFields: ["name"] });

        const res = await send(app, "POST", "/items", { name: "TRIGGER_DUPLICATE" });

        assert.strictEqual(res.status, 409);
        assert.deepStrictEqual(res.body.fields, { name: "Already exists." });
    });
});

test("Prototype pollution", async (t) => {
    await t.test("__proto__ in a body cannot reach the payload's prototype", async () => {
        const { app, model } = buildApp({ allowedFields: ["name"] });

        let out;
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Hand-written JSON: JSON.parse makes __proto__ a real own property.
                body: String.raw`{"name":"Lamp","__proto__":{"isAdmin":true},"constructor":{"x":1}}`,
            });
            out = { status: res.status, body: await res.json() };
        });

        assert.strictEqual(out.status, 201);

        const stored = [...model.store.values()][0];
        assert.strictEqual(Object.getPrototypeOf(stored), Object.prototype);
        assert.strictEqual(stored.isAdmin, undefined);
        assert.ok(!Object.hasOwn(stored, "constructor"));
        assert.strictEqual({}.isAdmin, undefined, "global Object.prototype must be untouched");
    });

    await t.test("a nested __proto__ is rejected with the rest of the value", async () => {
        const { app, model } = buildApp({ allowedFields: ["name", "meta"] });

        await withServer(app, async (base) => {
            await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: String.raw`{"name":"Lamp","meta":{"__proto__":{"isAdmin":true}}}`,
            });
        });

        const stored = [...model.store.values()][0];
        assert.strictEqual(stored.meta, undefined, "value containing __proto__ must be dropped");
    });

    await t.test("__proto__ is not a filterable field", async () => {
        const { app } = buildApp({
            query: ["name"],
            filterableFields: ["name"],
        });

        let status;
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "QUERY",
                headers: { "Content-Type": "application/json" },
                body: String.raw`{"filter":{"__proto__":{"gt":1}}}`,
            });
            status = res.status;
        });

        assert.strictEqual(status, 400);
    });
});
