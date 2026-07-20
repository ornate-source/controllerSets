import test from "node:test";
import assert from "node:assert";
import express from "express";
import { createRouter, errorHandler } from "../src/index.js";
import { createMockModel, objectId, withServer } from "./helpers/mockModel.js";

const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const buildApp = (routerOptions, model) => {
    const app = express();
    app.use(express.json());
    app.use("/items", createRouter({ model, logger: silentLogger, ...routerOptions }));
    app.use(errorHandler);
    return app;
};

// --- C2: arbitrary field-name injection -------------------------------------

test("C2: compareField cannot reach fields outside the allowlist", async (t) => {
    const model = createMockModel().seed([
        { _id: objectId(1), name: "a", price: 10, passwordResetToken: "secret-token" },
    ]);
    const app = buildApp({ query: ["price"] }, model);

    await t.test("rejects a non-allowlisted field", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(
                `${base}/items?compareField=passwordResetToken&compareOperator=gt&compareValue=a`,
            );
            const body = await res.json();

            assert.strictEqual(res.status, 400);
            assert.match(body.error, /not filterable/);
            // The critical assertion: the secret field never reached the query.
            assert.strictEqual(model.calls.lastFilters, null);
        });
    });

    await t.test("allows an allowlisted field", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items?compareField=price&compareOperator=gt&compareValue=5`);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(model.calls.lastFilters.price, { $gt: 5 });
        });
    });
});

test("C2: rangeField and sort are gated the same way", async (t) => {
    const model = createMockModel().seed([{ _id: objectId(1), name: "a", price: 10 }]);
    const app = buildApp({ query: ["price"] }, model);

    await t.test("rangeField outside the allowlist is rejected", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items?rangeField=salary&range=1-999999`);
            assert.strictEqual(res.status, 400);
        });
    });

    await t.test("sort outside the allowlist is rejected", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items?sort=-internalScore`);
            assert.strictEqual((await res.json()).error, "Field 'internalScore' is not sortable.");
            assert.strictEqual(res.status, 400);
        });
    });

    await t.test("configured orderBy is always permitted", async () => {
        const ordered = createMockModel().seed([{ _id: objectId(1), createdAt: 1 }]);
        const app2 = buildApp({ orderBy: "-createdAt" }, ordered);
        await withServer(app2, async (base) => {
            const res = await fetch(`${base}/items`);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(ordered.calls.lastSort, { createdAt: -1 });
        });
    });
});

// --- H1: ReDoS via unescaped regex ------------------------------------------

test("H1: search terms are escaped before reaching $regex", async (t) => {
    const model = createMockModel().seed([{ _id: objectId(1), name: "hello" }]);
    const app = buildApp({ search: ["name"] }, model);

    await t.test("catastrophic-backtracking payload is neutralised", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items?s=${encodeURIComponent("(a+)+$")}`);
            assert.strictEqual(res.status, 200);

            const pattern = model.calls.lastFilters.$or[0].name.$regex;
            assert.strictEqual(pattern, "\\(a\\+\\)\\+\\$");
            // Escaped, so it is a literal string match rather than a pattern.
            assert.ok(!new RegExp(pattern).test("aaaaaaaaaa"));
        });
    });

    await t.test("wildcard payload cannot match everything", async () => {
        await withServer(app, async (base) => {
            await fetch(`${base}/items?s=${encodeURIComponent(".*")}`);
            assert.strictEqual(model.calls.lastFilters.$or[0].name.$regex, "\\.\\*");
        });
    });

    await t.test("over-long search terms are rejected", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items?s=${"x".repeat(200)}`);
            assert.strictEqual(res.status, 400);
        });
    });

    await t.test("allowRawRegex opts back in explicitly", async () => {
        const raw = createMockModel().seed([{ _id: objectId(1), name: "hello" }]);
        const app2 = buildApp({ search: ["name"], allowRawRegex: true }, raw);
        await withServer(app2, async (base) => {
            await fetch(`${base}/items?s=${encodeURIComponent("^hel")}`);
            assert.strictEqual(raw.calls.lastFilters.$or[0].name.$regex, "^hel");
        });
    });
});

// --- C1: mass assignment ----------------------------------------------------

test("C1: allowedFields confines what a client may write", async (t) => {
    await t.test("create drops fields outside the allowlist", async () => {
        const model = createMockModel();
        const app = buildApp({ allowedFields: ["name", "email"] }, model);

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "Mallory", email: "m@x.io", role: "admin", isAdmin: true }),
            });
            const body = await res.json();

            assert.strictEqual(res.status, 201);
            assert.strictEqual(body.data.name, "Mallory");
            assert.strictEqual(body.data.role, undefined);
            assert.strictEqual(body.data.isAdmin, undefined);
        });
    });

    await t.test("update drops fields outside the allowlist", async () => {
        const model = createMockModel().seed([{ _id: objectId(7), name: "old", role: "user" }]);
        const app = buildApp({ allowedFields: ["name"] }, model);

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items/${objectId(7)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "new", role: "admin" }),
            });

            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(model.calls.lastUpdate, { $set: { name: "new" } });
            assert.strictEqual(model.store.get(objectId(7)).role, "user");
        });
    });

    await t.test("blockedFields subtracts from an otherwise open body", async () => {
        const model = createMockModel();
        const app = buildApp({ blockedFields: ["role"] }, model);

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "x", role: "admin" }),
            });
            const body = await res.json();
            assert.strictEqual(body.data.role, undefined);
            assert.strictEqual(body.data.name, "x");
        });
    });

    await t.test("immutable and operator keys are always stripped", async () => {
        const model = createMockModel().seed([{ _id: objectId(9), name: "keep" }]);
        const app = buildApp({}, model);

        await withServer(app, async (base) => {
            await fetch(`${base}/items/${objectId(9)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: "changed",
                    _id: objectId(1),
                    __v: 99,
                    $inc: { credits: 1000 },
                    "profile.role": "admin",
                    nested: { $ne: 1 },
                }),
            });

            assert.deepStrictEqual(model.calls.lastUpdate, { $set: { name: "changed" } });
        });
    });

    await t.test("a body with nothing writable is a 400, not a silent no-op", async () => {
        const model = createMockModel();
        const app = buildApp({ allowedFields: ["name"] }, model);

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: "admin" }),
            });
            assert.strictEqual(res.status, 400);
        });
    });
});

// --- H3: operator injection through filter values ---------------------------

test("H3: object-valued filters are rejected regardless of query parser", async () => {
    const model = createMockModel().seed([{ _id: objectId(1), status: "archived" }]);
    const app = express();
    app.use(express.json());
    // Simulate a host app that opted into the extended parser, under which
    // ?status[$ne]=archived parses into a nested object.
    app.set("query parser", "extended");
    app.use("/items", createRouter({ model, query: ["status"], logger: silentLogger }));
    app.use(errorHandler);

    await withServer(app, async (base) => {
        const res = await fetch(`${base}/items?status[$ne]=archived`);
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /Invalid value for filter 'status'/);
    });
});

test("H3: repeated params become $in rather than array equality", async () => {
    const model = createMockModel().seed([
        { _id: objectId(1), tag: "a" },
        { _id: objectId(2), tag: "b" },
        { _id: objectId(3), tag: "c" },
    ]);
    const app = buildApp({ query: ["tag"] }, model);

    await withServer(app, async (base) => {
        const res = await fetch(`${base}/items?tag=a&tag=b`);
        const body = await res.json();
        assert.deepStrictEqual(model.calls.lastFilters.tag, { $in: ["a", "b"] });
        assert.strictEqual(body.data.length, 2);
    });
});

// --- H2: unbounded reads ----------------------------------------------------

test("H2: an unpaginated list is still capped", async (t) => {
    const many = Array.from({ length: 500 }, (_, i) => ({ _id: objectId(i + 1), n: i }));

    await t.test("defaults to maxLimit", async () => {
        const model = createMockModel().seed(many);
        const app = buildApp({}, model);
        await withServer(app, async (base) => {
            const body = await (await fetch(`${base}/items`)).json();
            assert.strictEqual(body.data.length, 100);
            assert.strictEqual(model.calls.lastLimit, 100);
        });
    });

    await t.test("honours a configured maxLimit", async () => {
        const model = createMockModel().seed(many);
        const app = buildApp({ maxLimit: 25 }, model);
        await withServer(app, async (base) => {
            const body = await (await fetch(`${base}/items`)).json();
            assert.strictEqual(body.data.length, 25);
        });
    });

    await t.test("pageSize cannot exceed maxLimit", async () => {
        const model = createMockModel().seed(many);
        const app = buildApp({ maxLimit: 25 }, model);
        await withServer(app, async (base) => {
            const body = await (await fetch(`${base}/items?page=1&pageSize=1000`)).json();
            assert.strictEqual(body.pagination.pageSize, 25);
            assert.strictEqual(body.data.length, 25);
        });
    });
});

// --- M2: error handler ------------------------------------------------------

test("M2: internal error details are not returned to the client", async (t) => {
    await t.test("5xx messages are genericised", async () => {
        const model = createMockModel();
        model.find = () => {
            throw new Error("connect ECONNREFUSED mongodb://admin:hunter2@10.0.0.5:27017");
        };
        const app = buildApp({}, model);

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`);
            const body = await res.json();

            assert.strictEqual(res.status, 500);
            assert.strictEqual(body.error, "Internal Server Error");
            assert.ok(!JSON.stringify(body).includes("hunter2"));
            assert.ok(body.requestId);
        });
    });

    await t.test("duplicate keys map to 409", async () => {
        const model = createMockModel();
        const app = buildApp({}, model);

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "TRIGGER_DUPLICATE" }),
            });
            const body = await res.json();

            assert.strictEqual(res.status, 409);
            assert.match(body.error, /Duplicate value for: name/);
        });
    });

    await t.test("deliberate 4xx messages survive", async () => {
        const model = createMockModel();
        const app = buildApp({}, model);

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "TRIGGER_ERROR" }),
            });
            const body = await res.json();

            assert.strictEqual(res.status, 400);
            assert.match(body.error, /Validation Error/);
        });
    });
});

// --- legacyMode escape hatch ------------------------------------------------

test("legacyMode restores 2.x behaviour for staged migrations", async () => {
    const model = createMockModel().seed([{ _id: objectId(1), secret: "x" }]);
    const app = buildApp({ legacyMode: true, search: ["name"] }, model);

    await withServer(app, async (base) => {
        const res = await fetch(`${base}/items?compareField=secret&compareOperator=ne&compareValue=y`);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(model.calls.lastFilters.secret, { $ne: "y" });

        await fetch(`${base}/items?s=${encodeURIComponent("^a")}`);
        assert.strictEqual(model.calls.lastFilters.$or[0].name.$regex, "^a");
    });
});
