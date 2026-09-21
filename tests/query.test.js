import test from "node:test";
import assert from "node:assert";
import express from "express";
import {
    createRouter,
    errorHandler,
    isQueryMethodSupported,
} from "../src/index.js";
import { createMockModel, objectId, withServer } from "./helpers/mockModel.js";

// HTTP QUERY — a safe, idempotent read whose parameters live in the body. The
// point is not that the body is read, but that it is read under the same rules
// as the query string: allowlisted fields, escaped terms, capped pages, and no
// path from a JSON key to a Mongo operator.

const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const seedItems = (model) =>
    model.seed([
        { _id: objectId(1), name: "Desk lamp", price: 40, category: "home", tag: "sale" },
        { _id: objectId(2), name: "Office chair", price: 220, category: "home", tag: "new" },
        { _id: objectId(3), name: "Notebook (a+b)", price: 5, category: "paper", tag: "sale" },
        { _id: objectId(4), name: "Monitor", price: 300, category: "tech", tag: "new" },
    ]);

const buildApp = (
    options = {},
    model = seedItems(createMockModel()),
    { json = true, jsonOptions } = {},
) => {
    const app = express();
    if (json) app.use(express.json(jsonOptions));
    app.use(
        "/items",
        createRouter({
            model,
            logger: silentLogger,
            query: ["category", "tag"],
            filterableFields: ["category", "tag", "price"],
            sortableFields: ["price", "name"],
            search: ["name"],
            ...options,
        }),
    );
    app.use(errorHandler);
    return { app, model };
};

/** One QUERY request. `body: undefined` sends no body at all. */
const sendQuery = (base, path, body, headers = {}) =>
    fetch(`${base}${path}`, {
        method: "QUERY",
        headers:
            body === undefined
                ? headers
                : { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

const queryJson = async (app, body, path = "/items", headers) => {
    let out;
    await withServer(app, async (base) => {
        const res = await sendQuery(base, path, body, headers);
        out = { status: res.status, body: await res.json().catch(() => null) };
    });
    return out;
};

test("HTTP QUERY", { skip: isQueryMethodSupported() ? false : "runtime has no QUERY method" }, async (t) => {
    await t.test("runtime support is detected", () => {
        assert.strictEqual(isQueryMethodSupported(), true);
    });

    await t.test("a bodyless QUERY lists everything, like GET", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, undefined);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.length, 4);
    });

    await t.test("an empty body is an unfiltered list", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, {});

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.length, 4);
    });

    await t.test("equality filters narrow the list", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { filter: { category: "home" } });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(
            res.body.data.map((d) => d.name).sort(),
            ["Desk lamp", "Office chair"],
        );
    });

    await t.test("a list value becomes $in", async () => {
        const { app, model } = buildApp();
        const res = await queryJson(app, { filter: { category: ["home", "tech"] } });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(model.calls.lastFilters, { category: { $in: ["home", "tech"] } });
        assert.strictEqual(res.body.data.length, 3);
    });

    await t.test("operators are translated from the un-prefixed table", async () => {
        const { app, model } = buildApp();
        const res = await queryJson(app, {
            filter: { price: { gte: 40, lt: 300 }, tag: { ne: "new" } },
        });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(model.calls.lastFilters, {
            price: { $gte: 40, $lt: 300 },
            tag: { $ne: "new" },
        });
        assert.deepStrictEqual(res.body.data.map((d) => d.name), ["Desk lamp"]);
    });

    await t.test("nin excludes values", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { filter: { category: { nin: ["home", "paper"] } } });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.data.map((d) => d.name), ["Monitor"]);
    });

    await t.test("an unknown operator is rejected", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { filter: { price: { $gte: 40 } } });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /Unknown operator '\$gte'/);
    });

    await t.test("a Mongo operator as a field name is rejected", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { filter: { $where: "1 == 1" } });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /not filterable/);
    });

    await t.test("a dotted path is rejected", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { filter: { "price.$gt": 1 } });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /not filterable/);
    });

    await t.test("an undeclared field is rejected", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { filter: { passwordResetToken: "a" } });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /'passwordResetToken' is not filterable/);
    });

    await t.test("the allowlist holds even in legacyMode", async () => {
        const { app } = buildApp({ legacyMode: true });
        const res = await queryJson(app, { filter: { secret: "a" } });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /not filterable/);
    });

    await t.test("nested objects and empty conditions are rejected", async () => {
        const { app } = buildApp();

        const nested = await queryJson(app, { filter: { price: { gte: { a: 1 } } } });
        assert.strictEqual(nested.status, 400);

        const empty = await queryJson(app, { filter: { price: {} } });
        assert.strictEqual(empty.status, 400);

        const emptyList = await queryJson(app, { filter: { category: [] } });
        assert.strictEqual(emptyList.status, 400);

        const badFilter = await queryJson(app, { filter: ["category"] });
        assert.strictEqual(badFilter.status, 400);
    });

    await t.test("an over-long in list is rejected", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, {
            filter: { category: { in: Array.from({ length: 101 }, (_, i) => `c${i}`) } },
        });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /exceeds 100 values/);
    });

    await t.test("search terms are escaped, not executed", async () => {
        const { app, model } = buildApp();
        const res = await queryJson(app, { search: "(a+b)" });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(model.calls.lastFilters.$or, [
            { name: { $regex: "\\(a\\+b\\)", $options: "i" } },
        ]);
        assert.deepStrictEqual(res.body.data.map((d) => d.name), ["Notebook (a+b)"]);
    });

    await t.test("an over-long search term is rejected", async () => {
        const { app } = buildApp({ maxSearchLength: 8 });
        const res = await queryJson(app, { search: "123456789" });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /exceeds 8 characters/);
    });

    await t.test("sort is allowlisted", async () => {
        const { app } = buildApp();

        const ok = await queryJson(app, { sort: "-price" });
        assert.strictEqual(ok.status, 200);
        assert.deepStrictEqual(ok.body.data.map((d) => d.price), [300, 220, 40, 5]);

        const denied = await queryJson(app, { sort: "createdBy" });
        assert.strictEqual(denied.status, 400);
        assert.match(denied.body.error, /'createdBy' is not sortable/);
    });

    await t.test("sort accepts several keys", async () => {
        const { app, model } = buildApp();
        const res = await queryJson(app, { sort: ["name", "-price"] });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(model.calls.lastSort, { name: 1, price: -1 });
    });

    await t.test("too many sort keys are rejected", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { sort: ["price", "name", "price", "name", "price", "name"] });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /at most 5 fields/);
    });

    await t.test("orderBy still applies when the body omits sort", async () => {
        const { app, model } = buildApp({ orderBy: "-price" });
        const res = await queryJson(app, {});

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(model.calls.lastSort, { price: -1 });
    });

    await t.test("pagination returns the same envelope as GET", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { page: 2, pageSize: 2, sort: "price" });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body.pagination, {
            currentPage: 2,
            pageSize: 2,
            totalPages: 2,
            totalRecords: 4,
        });
        assert.deepStrictEqual(res.body.data.map((d) => d.price), [220, 300]);
    });

    await t.test("pageSize alone implies the first page", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { pageSize: 1 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.pagination.currentPage, 1);
        assert.strictEqual(res.body.data.length, 1);
    });

    await t.test("pageSize cannot exceed maxLimit", async () => {
        const { app } = buildApp({ maxLimit: 2 });
        const res = await queryJson(app, { page: 1, pageSize: 500 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.pagination.pageSize, 2);
        assert.strictEqual(res.body.data.length, 2);
    });

    await t.test("limit is capped at maxLimit", async () => {
        const { app, model } = buildApp({ maxLimit: 3 });
        const res = await queryJson(app, { limit: 100 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(model.calls.lastLimit, 3);
        assert.strictEqual(res.body.data.length, 3);
    });

    await t.test("an unpaginated QUERY is capped even without limit", async () => {
        const { app, model } = buildApp({ maxLimit: 2 });
        const res = await queryJson(app, {});

        assert.strictEqual(res.status, 200);
        assert.strictEqual(model.calls.lastLimit, 2);
    });

    await t.test("limit combined with paging is rejected", async () => {
        const { app } = buildApp();

        for (const body of [{ page: 1, limit: 10 }, { pageSize: 5, limit: 10 }]) {
            const res = await queryJson(app, body);
            assert.strictEqual(res.status, 400, JSON.stringify(body));
            assert.match(res.body.error, /'limit' or 'page'\/'pageSize'/);
        }
    });

    await t.test("page must be a positive integer", async () => {
        const { app } = buildApp();

        for (const page of ["2", 0, -1, 1.5]) {
            const res = await queryJson(app, { page });
            assert.strictEqual(res.status, 400, `page=${JSON.stringify(page)}`);
            assert.match(res.body.error, /'page' must be a positive integer/);
        }
    });

    await t.test("an unknown body key is rejected rather than ignored", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { filters: { category: "home" } });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /Unknown key 'filters'/);
    });

    await t.test("a non-object body is rejected", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, [{ filter: {} }]);

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /must be a JSON object/);
    });

    await t.test("a non-JSON body is a 415", async () => {
        const { app } = buildApp();
        let status;
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "QUERY",
                headers: { "Content-Type": "text/plain" },
                body: "category=home",
            });
            status = res.status;
        });

        assert.strictEqual(status, 415);
    });

    await t.test("a JSON suffix type is served when the parser handles it", async () => {
        const { app } = buildApp({}, seedItems(createMockModel()), {
            jsonOptions: { type: ["application/json", "application/*+json"] },
        });
        const res = await queryJson(app, { filter: { category: "tech" } }, "/items", {
            "Content-Type": "application/vnd.api+json",
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.data.length, 1);
    });

    await t.test("a suffix type the parser ignores says so, rather than reading everything", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, { filter: { category: "tech" } }, "/items", {
            "Content-Type": "application/vnd.api+json",
        });

        assert.strictEqual(res.status, 415);
        assert.match(res.body.error, /not parsed/);
    });

    await t.test("a missing JSON parser is a 415, not a silent full read", async () => {
        const { app } = buildApp({}, seedItems(createMockModel()), { json: false });
        const res = await queryJson(app, { filter: { category: "home" } });

        assert.strictEqual(res.status, 415);
        assert.match(res.body.error, /not parsed/);
    });

    await t.test("onGet still shapes the response", async () => {
        const { app, model } = buildApp({
            onGet: () => ({ populates: ["category"], selects: "name price" }),
        });
        const res = await queryJson(app, { filter: { category: "home" } });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(model.calls.lastPopulate, ["category"]);
        assert.strictEqual(model.calls.lastSelect, "name price");
    });

    await t.test("OPTIONS advertises QUERY and the query format it accepts", async () => {
        const { app } = buildApp();
        let headers;
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, { method: "OPTIONS" });
            headers = {
                allow: res.headers.get("allow") ?? "",
                acceptQuery: res.headers.get("accept-query"),
            };
        });

        assert.match(headers.allow, /QUERY/);
        // RFC 10008 §4 — a client can discover the format without guessing.
        assert.strictEqual(headers.acceptQuery, "application/json");
    });

    await t.test("a 415 carries Accept-Query", async () => {
        const { app } = buildApp();
        let acceptQuery;
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items`, {
                method: "QUERY",
                headers: { "Content-Type": "text/plain" },
                body: "category=home",
            });
            acceptQuery = res.headers.get("accept-query");
        });

        assert.strictEqual(acceptQuery, "application/json");
    });

    await t.test("QUERY is a collection method only", async () => {
        const { app } = buildApp();
        const res = await queryJson(app, {}, `/items/${objectId(1)}`);

        assert.strictEqual(res.status, 404);
    });

    await t.test("enableQuery: false leaves the route unmounted", async () => {
        const { app } = buildApp({ enableQuery: false });
        const res = await queryJson(app, {});

        assert.strictEqual(res.status, 404);
    });

    await t.test("QUERY never reaches the upload middleware on an upload router", async () => {
        const model = seedItems(createMockModel());
        const app = express();
        app.use(express.json());
        app.use(
            "/files",
            createRouter({
                model,
                logger: silentLogger,
                query: ["category"],
                filterableFields: ["category"],
                // A bucket is never configured here: reaching the upload path would throw.
                upload: { acl: "private" },
            }),
        );
        app.use(errorHandler);

        let out;
        await withServer(app, async (base) => {
            const res = await sendQuery(base, "/files", { filter: { category: "tech" } });
            out = { status: res.status, body: await res.json() };
        });

        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(out.body.data.map((d) => d.name), ["Monitor"]);
    });

    await t.test("GET is unchanged by the refactor", async () => {
        const { app } = buildApp({ orderBy: "-price" });
        await withServer(app, async (base) => {
            const res = await fetch(`${base}/items?category=home&sort=price&page=1&pageSize=1`);
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.data.length, 1);
            assert.strictEqual(body.data[0].name, "Desk lamp");
            assert.strictEqual(body.pagination.totalRecords, 2);
        });
    });
});
