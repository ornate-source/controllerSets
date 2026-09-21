import test from "node:test";
import assert from "node:assert";
import express from "express";
import { createRouter, errorHandler } from "../src/index.js";
import { createMockModel, objectId, withServer } from "./helpers/mockModel.js";

const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const buildApp = (options, model) => {
    const app = express();
    app.use(express.json());
    app.use("/items", createRouter({ model, logger: silentLogger, ...options }));
    app.use(errorHandler);
    return app;
};

test("Express Controller Sets - Smoke Test", async (t) => {
    const model = createMockModel();
    // `price` and `name` must be declared to be filterable/sortable — the whole
    // point of the 3.0 change is that undeclared fields are not reachable.
    const app = buildApp({ search: ["name", "description"], query: ["price", "name"] }, model);

    let createdId = "";

    await t.test("POST /items - creates a record", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "Test Item", description: "Hello World" }),
            });
            const body = await res.json();

            assert.strictEqual(res.status, 201);
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.data.name, "Test Item");
            createdId = body.data._id;
        });
    });

    await t.test("GET /items - lists records", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`);
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(body.data));
            assert.strictEqual(body.data.length, 1);
            assert.strictEqual(body.data[0].name, "Test Item");
        });
    });

    await t.test("GET /items/:id - gets a single record", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items/${createdId}`);
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.data.name, "Test Item");
        });
    });

    await t.test("GET /items/:id - rejects a malformed id", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items/not-an-object-id`);
            assert.strictEqual(res.status, 400);
            assert.strictEqual((await res.json()).error, "Invalid ID format.");
        });
    });

    await t.test("PATCH /items/:id - updates a record", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items/${createdId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "Updated Name" }),
            });
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.data.name, "Updated Name");
        });
    });

    await t.test("PATCH /items/:id - 404s on a missing record", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items/${objectId(999)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "ghost" }),
            });
            assert.strictEqual(res.status, 404);
        });
    });

    await t.test("GET /items?search= - searches records", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items?search=Updated`);
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.data.length, 1);
            assert.strictEqual(body.data[0].name, "Updated Name");
        });
    });

    await t.test("GET /items - filters by numeric range", async () => {
        model.seed([
            { _id: objectId(101), name: "Low", price: 15 },
            { _id: objectId(102), name: "Mid", price: 50 },
            { _id: objectId(103), name: "High", price: 120 },
        ]);

        await withServer(app, async (base) => {
            const within = await (await fetch(`${base}/items?rangeField=price&range=20-100`)).json();
            assert.deepStrictEqual(
                within.data.map((i) => i.price),
                [50],
            );

            const minOnly = await (await fetch(`${base}/items?rangeField=price&range=20-`)).json();
            assert.deepStrictEqual(minOnly.data.map((i) => i.price).sort((a, b) => a - b), [50, 120]);

            const maxOnly = await (await fetch(`${base}/items?rangeField=price&range=-80`)).json();
            assert.deepStrictEqual(maxOnly.data.map((i) => i.price).sort((a, b) => a - b), [15, 50]);
        });
    });

    await t.test("GET /items - filters by comparison operator", async () => {
        await withServer(app, async (base) => {
            const gt = await (
                await fetch(`${base}/items?compareField=price&compareValue=50&compareOperator=gt`)
            ).json();
            assert.deepStrictEqual(
                gt.data.map((i) => i.price),
                [120],
            );

            const gte = await (
                await fetch(`${base}/items?compareField=price&compareValue=50&compareOperator=gte`)
            ).json();
            assert.deepStrictEqual(gte.data.map((i) => i.price).sort((a, b) => a - b), [50, 120]);

            const ne = await (
                await fetch(`${base}/items?compareField=price&compareValue=50&compareOperator=ne`)
            ).json();
            assert.ok(!ne.data.map((i) => i.price).includes(50));
        });
    });

    await t.test("GET /items?sort=-name - sorts records", async () => {
        await withServer(app, async (base) => {
            await fetch(`${base}/items?sort=-name`);
            assert.deepStrictEqual(model.calls.lastSort, { name: -1 });
        });
    });

    await t.test("GET /items?page= - paginates", async () => {
        await withServer(app, async (base) => {
            const body = await (await fetch(`${base}/items?page=1&pageSize=2`)).json();

            assert.strictEqual(body.data.length, 2);
            assert.strictEqual(body.pagination.currentPage, 1);
            assert.strictEqual(body.pagination.pageSize, 2);
            assert.strictEqual(body.pagination.totalRecords, 4);
            assert.strictEqual(body.pagination.totalPages, 2);
        });
    });

    await t.test("DELETE /items/:id - deletes a record", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items/${createdId}`, { method: "DELETE" });
            assert.strictEqual(res.status, 200);
            assert.strictEqual((await res.json()).success, true);

            const after = await fetch(`${base}/items/${createdId}`);
            assert.strictEqual(after.status, 404);
        });
    });

    await t.test("DELETE /items/:id - 404s on a missing record", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items/${objectId(999)}`, { method: "DELETE" });
            assert.strictEqual(res.status, 404);
        });
    });

    await t.test("POST /items - returns JSON on validation failure", async () => {
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "TRIGGER_ERROR" }),
            });
            const body = await res.json();

            assert.strictEqual(res.status, 400);
            assert.strictEqual(body.success, false);
            assert.match(body.error, /Validation Error/);
        });
    });
});

// --- onGet hook -------------------------------------------------------------

test("onGet Hook - Conditional Populate & Select", async (t) => {
    await t.test("applies populates on list reads", async () => {
        const model = createMockModel().seed([{ _id: objectId(1), name: "Item 1" }]);
        const app = buildApp(
            { onGet: () => ({ populates: [{ path: "users.user", select: "name email" }] }) },
            model,
        );

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(model.calls.lastPopulate, [
                { path: "users.user", select: "name email" },
            ]);
        });
    });

    await t.test("applies selects on list reads", async () => {
        const model = createMockModel().seed([{ _id: objectId(1), name: "Item 1" }]);
        const app = buildApp({ onGet: () => ({ selects: "-users -password" }) }, model);

        await withServer(app, async (base) => {
            await fetch(`${base}/items`);
            assert.strictEqual(model.calls.lastSelect, "-users -password");
        });
    });

    await t.test("applies to getById", async () => {
        const id = "507f1f77bcf86cd799439011";
        const model = createMockModel().seed([{ _id: id, name: "Single Item" }]);
        const app = buildApp(
            { onGet: () => ({ populates: "category", selects: "-internalNotes" }) },
            model,
        );

        await withServer(app, async (base) => {
            const body = await (await fetch(`${base}/items/${id}`)).json();
            assert.strictEqual(body.data.name, "Single Item");
            assert.strictEqual(model.calls.lastPopulate, "category");
            assert.strictEqual(model.calls.lastSelect, "-internalNotes");
        });
    });

    await t.test("works without onGet (backward compatible)", async () => {
        const model = createMockModel().seed([{ _id: objectId(1), name: "Item 1" }]);
        const app = buildApp({ search: ["name"] }, model);

        await withServer(app, async (base) => {
            const body = await (await fetch(`${base}/items`)).json();
            assert.strictEqual(body.data.length, 1);
            assert.deepStrictEqual(model.calls.lastPopulate, []);
            assert.strictEqual(model.calls.lastSelect, "");
        });
    });

    await t.test("a throwing onGet degrades to safe defaults", async () => {
        const model = createMockModel().seed([{ _id: objectId(1), name: "Item 1" }]);
        const app = buildApp(
            {
                onGet: () => {
                    throw new Error("hook exploded");
                },
            },
            model,
        );

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(model.calls.lastPopulate, []);
        });
    });
});

// --- relational search ------------------------------------------------------

test("Relational search resolves nested paths at full depth", async () => {
    const { default: mongoose } = await import("mongoose");

    const authors = [
        { _id: objectId(11), profile: { name: "Ada" } },
        { _id: objectId(12), profile: { name: "Grace" } },
    ];
    // Minimal ref model: the controller calls find().select().limit().lean().
    let appliedLimit = null;
    const refModel = {
        find: (filters) => {
            const pattern = new RegExp(filters["profile.name"].$regex, "i");
            const matched = authors.filter((a) => pattern.test(a.profile.name));
            const q = {
                select: () => q,
                limit: (value) => {
                    appliedLimit = value;
                    return q;
                },
                lean: () => Promise.resolve(matched),
            };
            return q;
        },
    };

    const originalModel = mongoose.model;
    mongoose.model = (name) => (name === "Author" ? refModel : originalModel(name));

    try {
        const model = createMockModel({ refPaths: { author: "Author" } }).seed([
            { _id: objectId(1), author: objectId(11) },
        ]);
        const app = buildApp({ search: ["author.profile.name"] }, model);

        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items?s=Ada`);
            assert.strictEqual(res.status, 200);

            // Depth is preserved: 2.x truncated this to `profile` and searched the wrong field.
            assert.deepStrictEqual(model.calls.lastFilters.$or, [
                { author: { $in: [objectId(11)] } },
            ]);
            // The `$in` grows with the referenced collection, so it is capped.
            assert.strictEqual(appliedLimit, 1000);
        });
    } finally {
        mongoose.model = originalModel;
    }
});
