import test from "node:test";
import assert from "node:assert";
import express from "express";
import { createRouter, errorHandler } from "../src/index.js";
import { createMockModel, objectId, withServer } from "./helpers/mockModel.js";

/**
 * The options that decide what a read costs.
 *
 * A list endpoint's worst case is not the documents it returns — it is the count
 * query beside them and the time the database is willing to spend. These pin
 * both, and that the caps cannot be widened from outside.
 */

const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const seed = (count) =>
    createMockModel().seed(
        Array.from({ length: count }, (_, i) => ({
            _id: objectId(i + 1),
            name: `item-${String(i).padStart(3, "0")}`,
            price: i,
            // A string field, so a query-string filter matches without the
            // schema casting a real Mongoose model would do for us.
            tag: i % 5 === 0 ? "featured" : "plain",
        })),
    );

const buildApp = (options = {}, model = seed(25)) => {
    const app = express();
    app.use(express.json());
    app.use(
        "/items",
        createRouter({
            model,
            logger: silentLogger,
            query: ["price", "tag"],
            sortableFields: ["price", "name"],
            ...options,
        }),
    );
    app.use(errorHandler);
    return { app, model };
};

const get = async (app, path) => {
    let out;
    await withServer(app, async (base) => {
        const res = await fetch(`${base}${path}`);
        out = { status: res.status, body: await res.json() };
    });
    return out;
};

test("Read cost controls", async (t) => {
    await t.test("countStrategy defaults to an exact count", async () => {
        const { app, model } = buildApp();
        const res = await get(app, "/items?page=1&pageSize=5");

        assert.strictEqual(res.body.pagination.totalRecords, 25);
        assert.strictEqual(model.calls.counts.exact, 1);
        assert.strictEqual(model.calls.counts.estimated, 0);
    });

    await t.test("'estimated' skips the counting scan on an unfiltered page", async () => {
        const { app, model } = buildApp({ countStrategy: "estimated" });
        const res = await get(app, "/items?page=1&pageSize=5");

        assert.strictEqual(res.body.pagination.totalRecords, 25);
        assert.strictEqual(model.calls.counts.estimated, 1);
        assert.strictEqual(model.calls.counts.exact, 0, "metadata is enough without a filter");
    });

    await t.test("'estimated' falls back to an exact count once a filter applies", async () => {
        const { app, model } = buildApp({ countStrategy: "estimated" });
        // An estimate cannot see a filter, so a filtered page must still count.
        const res = await get(app, "/items?tag=featured&page=1&pageSize=5");

        assert.strictEqual(res.body.pagination.totalRecords, 5);
        assert.strictEqual(model.calls.counts.exact, 1);
        assert.strictEqual(model.calls.counts.estimated, 0);
    });

    await t.test("'none' answers hasMore without counting at all", async () => {
        const { app, model } = buildApp({ countStrategy: "none" });

        const first = await get(app, "/items?page=1&pageSize=5&sort=price");
        assert.deepStrictEqual(first.body.pagination, {
            currentPage: 1,
            pageSize: 5,
            hasMore: true,
        });
        assert.strictEqual(first.body.data.length, 5, "the probe document is not returned");
        assert.deepStrictEqual(
            first.body.data.map((d) => d.price),
            [0, 1, 2, 3, 4],
        );

        const last = await get(app, "/items?page=5&pageSize=5&sort=price");
        assert.strictEqual(last.body.pagination.hasMore, false);
        assert.strictEqual(last.body.data.length, 5);

        assert.deepStrictEqual(model.calls.counts, { exact: 0, estimated: 0 });
    });

    await t.test("maxTimeMS is applied to reads and to the count beside them", async () => {
        const { app, model } = buildApp({ maxTimeMS: 250 });

        await get(app, "/items?page=1&pageSize=5");
        assert.strictEqual(model.calls.lastMaxTimeMS, 250);

        await get(app, `/items/${objectId(1)}`);
        assert.strictEqual(model.calls.lastMaxTimeMS, 250);
    });

    await t.test("maxTimeMS is off unless configured", async () => {
        const { app, model } = buildApp();
        await get(app, "/items");

        assert.strictEqual(model.calls.lastMaxTimeMS, null);
    });

    await t.test("an invalid maxTimeMS is ignored rather than passed through", async () => {
        const { app, model } = buildApp({ maxTimeMS: -1 });
        await get(app, "/items");

        assert.strictEqual(model.calls.lastMaxTimeMS, null);
    });

    await t.test("an unknown countStrategy falls back to exact", async () => {
        const { app, model } = buildApp({ countStrategy: "cheap-please" });
        const res = await get(app, "/items?page=1");

        assert.strictEqual(res.body.pagination.totalRecords, 25);
        assert.strictEqual(model.calls.counts.exact, 1);
    });

    await t.test("defaultPageSize sets the page size when the client omits one", async () => {
        const { app } = buildApp({ defaultPageSize: 3 });
        const res = await get(app, "/items?page=1");

        assert.strictEqual(res.body.pagination.pageSize, 3);
        assert.strictEqual(res.body.data.length, 3);
    });

    await t.test("defaultPageSize is still bounded by maxLimit", async () => {
        const { app } = buildApp({ defaultPageSize: 500, maxLimit: 4 });
        const res = await get(app, "/items?page=1");

        assert.strictEqual(res.body.pagination.pageSize, 4);
    });

    await t.test("maxPage refuses a deep page rather than serving a scan", async () => {
        const { app, model } = buildApp({ maxPage: 3 });

        const allowed = await get(app, "/items?page=3&pageSize=5");
        assert.strictEqual(allowed.status, 200);

        const refused = await get(app, "/items?page=4&pageSize=5");
        assert.strictEqual(refused.status, 400);
        assert.match(refused.body.error, /beyond the maximum of 3/);

        // Refused before the database was asked anything.
        assert.strictEqual(model.calls.counts.exact, 1, "only the allowed page counted");
    });

    await t.test("maxPage is off by default, and applies to QUERY too", async () => {
        const { app } = buildApp();
        const deep = await get(app, "/items?page=100000");
        assert.strictEqual(deep.status, 200);

        const { app: capped } = buildApp({ maxPage: 2 });
        let out;
        await withServer(capped, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "QUERY",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ page: 9 }),
            });
            out = { status: res.status, body: await res.json() };
        });

        assert.strictEqual(out.status, 400);
        assert.match(out.body.error, /beyond the maximum of 2/);
    });

    await t.test("the QUERY route inherits every one of these caps", async () => {
        const { app, model } = buildApp({ countStrategy: "none", maxTimeMS: 100, maxLimit: 6 });

        let out;
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "QUERY",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ page: 1, pageSize: 500, sort: "price" }),
            });
            out = { status: res.status, body: await res.json() };
        });

        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.body.pagination.pageSize, 6);
        assert.strictEqual(out.body.pagination.hasMore, true);
        assert.strictEqual(model.calls.lastMaxTimeMS, 100);
        assert.deepStrictEqual(model.calls.counts, { exact: 0, estimated: 0 });
    });
});
