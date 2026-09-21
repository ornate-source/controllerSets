import test from "node:test";
import assert from "node:assert";
import express from "express";
import mongoose from "mongoose";
import { createRouter, errorHandler, isQueryMethodSupported } from "../src/index.js";
import { withServer } from "./helpers/mockModel.js";

// Keyset pagination against a real MongoDB. A mock cannot prove the thing that
// matters here — that every document is returned exactly once while walking a
// collection whose sort key has duplicates — because that depends on how the
// driver orders and compares, not on how we build the filter.

let MongoMemoryServer;
try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
} catch {
    MongoMemoryServer = null;
}

const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

test(
    "Cursor pagination",
    { skip: MongoMemoryServer ? false : "mongodb-memory-server not installed" },
    async (t) => {
        const mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());

        t.after(async () => {
            await mongoose.disconnect();
            await mongod.stop();
        });

        const Item = mongoose.model(
            "CursorItem",
            new mongoose.Schema({ name: String, bucket: Number, tag: String }),
        );

        // 200 documents across 8 buckets: every sort value is shared by ~25
        // records, which is exactly where a tiebreaker-less cursor loses rows.
        const TOTAL = 200;
        await Item.create(
            Array.from({ length: TOTAL }, (_, i) => ({
                name: `item-${String(i).padStart(3, "0")}`,
                bucket: i % 8,
                tag: i % 2 === 0 ? "even" : "odd",
            })),
        );

        const buildApp = (options = {}) => {
            const app = express();
            app.use(express.json());
            app.use(
                "/items",
                createRouter({
                    model: Item,
                    logger: silentLogger,
                    pagination: "cursor",
                    query: ["tag", "bucket"],
                    filterableFields: ["tag", "bucket"],
                    sortableFields: ["bucket", "name"],
                    defaultPageSize: 25,
                    ...options,
                }),
            );
            app.use(errorHandler);
            return app;
        };

        /** Walks every page, returning the documents seen and the page count. */
        const walk = async (base, path, { pageSize = 25, limitPages = 100 } = {}) => {
            const seen = [];
            let cursor = null;
            let pages = 0;

            for (; pages < limitPages; pages += 1) {
                const url = new URL(`${base}${path}`);
                url.searchParams.set("pageSize", String(pageSize));
                if (cursor) url.searchParams.set("cursor", cursor);

                const res = await fetch(url);
                const body = await res.json();
                assert.strictEqual(res.status, 200, JSON.stringify(body));

                seen.push(...body.data);
                if (!body.pagination.hasMore) {
                    assert.strictEqual(body.pagination.nextCursor, null);
                    pages += 1;
                    break;
                }
                assert.ok(body.pagination.nextCursor, "hasMore must come with a cursor");
                cursor = body.pagination.nextCursor;
            }

            return { seen, pages };
        };

        await t.test("walks the whole collection exactly once", async () => {
            await withServer(buildApp(), async (base) => {
                const { seen, pages } = await walk(base, "/items");

                assert.strictEqual(seen.length, TOTAL);
                assert.strictEqual(pages, 8);
                assert.strictEqual(new Set(seen.map((d) => d._id)).size, TOTAL);
            });
        });

        await t.test("loses nothing when the sort key is full of duplicates", async () => {
            // 200 records over 8 distinct `bucket` values. Without the `_id`
            // tiebreaker this silently drops or repeats rows at every boundary.
            await withServer(buildApp({ orderBy: "bucket" }), async (base) => {
                const { seen } = await walk(base, "/items", { pageSize: 7 });

                assert.strictEqual(seen.length, TOTAL);
                assert.strictEqual(new Set(seen.map((d) => d._id)).size, TOTAL);

                const buckets = seen.map((d) => d.bucket);
                assert.deepStrictEqual(
                    buckets,
                    [...buckets].sort((a, b) => a - b),
                    "order must hold across page boundaries",
                );
            });
        });

        await t.test("holds its order descending too", async () => {
            await withServer(buildApp({ orderBy: "-bucket" }), async (base) => {
                const { seen } = await walk(base, "/items", { pageSize: 30 });

                assert.strictEqual(seen.length, TOTAL);
                const buckets = seen.map((d) => d.bucket);
                assert.deepStrictEqual(buckets, [...buckets].sort((a, b) => b - a));
            });
        });

        await t.test("filters and search apply to every page", async () => {
            await withServer(buildApp(), async (base) => {
                const { seen } = await walk(base, "/items?tag=even", { pageSize: 10 });

                assert.strictEqual(seen.length, TOTAL / 2);
                assert.ok(seen.every((d) => d.tag === "even"));
            });
        });

        await t.test("never uses skip, whatever the page", async () => {
            await withServer(buildApp(), async (base) => {
                // A deep page in cursor mode is one index seek, so it stays fast
                // and, unlike offset paging, needs no maxPage guard.
                const { seen } = await walk(base, "/items", { pageSize: 5 });
                assert.strictEqual(seen.length, TOTAL);
            });
        });

        await t.test("a cursor keeps working as records are inserted behind it", async () => {
            await withServer(buildApp({ orderBy: "name" }), async (base) => {
                const first = await (await fetch(`${base}/items?pageSize=10`)).json();
                assert.strictEqual(first.data.length, 10);

                // An insert that sorts *before* the cursor shifts every offset by
                // one — the classic way page 2 of an offset scan repeats a row.
                const inserted = await Item.create({ name: "item-000-inserted", bucket: 0 });

                const second = await (
                    await fetch(`${base}/items?pageSize=10&cursor=${first.pagination.nextCursor}`)
                ).json();

                const overlap = second.data.filter((d) =>
                    first.data.some((f) => f._id === d._id),
                );
                assert.deepStrictEqual(overlap, [], "a keyset page cannot repeat a row");

                await Item.findByIdAndDelete(inserted._id);
            });
        });

        await t.test("QUERY paginates by cursor through the same code path", { skip: !isQueryMethodSupported() && "this runtime has no HTTP QUERY method" }, async () => {
            await withServer(buildApp(), async (base) => {
                const send = (body) =>
                    fetch(`${base}/items`, {
                        method: "QUERY",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                    });

                const first = await (await send({ pageSize: 15, sort: "name" })).json();
                assert.strictEqual(first.data.length, 15);
                assert.strictEqual(first.pagination.hasMore, true);

                const second = await (
                    await send({ pageSize: 15, sort: "name", cursor: first.pagination.nextCursor })
                ).json();

                assert.strictEqual(second.data.length, 15);
                assert.strictEqual(
                    new Set([...first.data, ...second.data].map((d) => d._id)).size,
                    30,
                );
            });
        });

        await t.test("a cursor from another sort order is refused", async () => {
            await withServer(buildApp(), async (base) => {
                const byName = await (await fetch(`${base}/items?pageSize=5&sort=name`)).json();

                const res = await fetch(
                    `${base}/items?pageSize=5&sort=bucket&cursor=${byName.pagination.nextCursor}`,
                );
                const body = await res.json();

                assert.strictEqual(res.status, 400);
                assert.match(body.error, /different sort order/);
            });
        });

        await t.test("a malformed cursor is a 400, not a stack trace", async () => {
            await withServer(buildApp(), async (base) => {
                for (const token of ["not-base64!!", "", Buffer.from("{}").toString("base64url")]) {
                    const res = await fetch(
                        `${base}/items?cursor=${encodeURIComponent(token)}&pageSize=5`,
                    );
                    // An empty cursor is simply the first page.
                    assert.strictEqual(res.status, token === "" ? 200 : 400, token);
                }
            });
        });

        await t.test("a cursor whose record was deleted says so", async () => {
            await withServer(buildApp({ orderBy: "name" }), async (base) => {
                const doomed = await Item.create({ name: "item-zzz-doomed", bucket: 9 });
                const page = await (
                    await fetch(`${base}/items?pageSize=1&sort=name&cursor=`)
                ).json();
                assert.ok(page.pagination.nextCursor);

                // Anchor the next page on a record, then remove it.
                const anchored = await (
                    await fetch(`${base}/items?pageSize=1&sort=name`)
                ).json();
                const cursor = anchored.pagination.nextCursor;
                await Item.findByIdAndDelete(anchored.data[0]._id);

                const res = await fetch(`${base}/items?pageSize=1&sort=name&cursor=${cursor}`);
                const body = await res.json();

                assert.strictEqual(res.status, 400);
                assert.match(body.error, /no longer exists/);

                await Item.create(anchored.data[0]);
                await Item.findByIdAndDelete(doomed._id);
            });
        });

        await t.test("offset paging is refused in cursor mode, and vice versa", async () => {
            await withServer(buildApp(), async (base) => {
                const res = await fetch(`${base}/items?page=2`);
                assert.strictEqual(res.status, 400);
                assert.match((await res.json()).error, /paginates by cursor/);
            });

            await withServer(buildApp({ pagination: "offset" }), async (base) => {
                const res = await fetch(`${base}/items?cursor=abc`);
                assert.strictEqual(res.status, 400);
                assert.match((await res.json()).error, /paginates by page/);
            });
        });

        await t.test("pageSize is still capped by maxLimit", async () => {
            await withServer(buildApp({ maxLimit: 12 }), async (base) => {
                const body = await (await fetch(`${base}/items?pageSize=500`)).json();

                assert.strictEqual(body.pagination.pageSize, 12);
                assert.strictEqual(body.data.length, 12);
            });
        });

        await t.test("offset mode is untouched by any of this", async () => {
            await withServer(buildApp({ pagination: "offset" }), async (base) => {
                const body = await (await fetch(`${base}/items?page=2&pageSize=25`)).json();

                assert.strictEqual(body.pagination.currentPage, 2);
                assert.strictEqual(body.pagination.totalRecords, TOTAL);
                assert.strictEqual(body.pagination.totalPages, 8);
                assert.strictEqual(body.data.length, 25);
            });
        });
    },
);
