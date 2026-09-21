import test from "node:test";
import assert from "node:assert";
import express from "express";
import mongoose from "mongoose";
import {
    createMemoryCacheStore,
    createRedisCacheStore,
    createRouter,
    errorHandler,
    isQueryMethodSupported,
} from "../src/index.js";
import { withServer } from "./helpers/mockModel.js";

// Response caching. No Redis server needed: the memory store stands in for it,
// and the Redis adapter is exercised against client-shaped fakes.

let MongoMemoryServer;
try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
} catch {
    MongoMemoryServer = null;
}

const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const withEnv = (vars, fn) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
};

/* ------------------------------------------------------------------ *
 * Stores
 * ------------------------------------------------------------------ */

test("memory store: get, set with expiry, LRU bound", async () => {
    const store = createMemoryCacheStore({ maxEntries: 2 });
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
        await store.set("a", "1", 10);
        assert.strictEqual(await store.get("a"), "1");
        now += 11_000;
        assert.strictEqual(await store.get("a"), null, "expired");

        await store.set("v", "keep", 60);
        await store.set("x", "1", 60);
        await store.get("v");                      // touch: v is now most recent
        await store.set("y", "2", 60);
        assert.strictEqual(store.size, 2, "bounded");
        assert.strictEqual(await store.get("x"), null, "least recently used went first");
        assert.strictEqual(await store.get("v"), "keep");
    } finally {
        Date.now = realNow;
    }
});

test("redis adapter speaks both ioredis and node-redis", async () => {
    const calls = [];
    const ioredisLike = {
        status: "ready",
        get: async (k) => (calls.push(["get", k]), "v"),
        set: async (...args) => calls.push(["set", ...args]),
    };
    const nodeRedisLike = { ...ioredisLike, isOpen: true };

    const a = createRedisCacheStore({ client: ioredisLike });
    await a.set("k", "val", 30);
    assert.deepStrictEqual(calls.pop(), ["set", "k", "val", "EX", 30]);
    assert.strictEqual(await a.get("k"), "v");

    const b = createRedisCacheStore({ client: nodeRedisLike });
    await b.set("k", "val", 30);
    assert.deepStrictEqual(calls.pop(), ["set", "k", "val", { EX: 30 }]);
});

test("cache configuration is checked at startup", () => {
    const model = { modelName: "Thing", collection: { collectionName: "things" } };
    const build = (cache) => createRouter({ model, cache, allowedFields: [], logger: silentLogger });

    withEnv({ REDIS_URL: undefined, CACHE_ENABLED: undefined }, () => {
        assert.throws(() => build(true), /REDIS_URL/);
        assert.throws(() => build({ store: { get() {} } }), /get and set/);
        assert.throws(() => build({ store: createMemoryCacheStore(), ttl: 0 }), /ttl/);
        assert.throws(() => build({ store: createMemoryCacheStore(), vary: "user" }), /vary/);
        assert.throws(() => build("yes"), /true or an options object/);
        assert.doesNotThrow(() => build(false));
    });

    withEnv({ CACHE_ENABLED: "false", REDIS_URL: undefined }, () => {
        assert.doesNotThrow(() => build(true), "the kill switch wins over missing config");
    });
    withEnv({ CACHE_TTL: "soon" }, () => {
        assert.throws(() => build({ store: createMemoryCacheStore() }), /CACHE_TTL/);
    });
});

/* ------------------------------------------------------------------ *
 * Behaviour
 * ------------------------------------------------------------------ */

test(
    "Response cache",
    { skip: MongoMemoryServer ? false : "mongodb-memory-server not installed" },
    async (t) => {
        const mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());
        t.after(async () => {
            await mongoose.disconnect();
            await mongod.stop();
        });

        const Item = mongoose.model(
            "CacheItem",
            new mongoose.Schema({ name: String, secret: String, ownerId: String }, { timestamps: true }),
        );

        const call = async (base, method, path, body, headers = {}) => {
            const res = await fetch(`${base}${path}`, {
                method,
                headers: { "Content-Type": "application/json", ...headers },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: res.status, cache: res.headers.get("x-cache"), body: await res.json() };
        };

        const appWith = (mount) => {
            const app = express();
            app.use(express.json());
            mount(app);
            app.use(errorHandler);
            return app;
        };

        await t.test("a repeated read is served from the cache", async () => {
            await Item.deleteMany({});
            const store = createMemoryCacheStore();
            const app = appWith((a) =>
                a.use("/items", createRouter({ model: Item, cache: { store }, allowedFields: ["name"], logger: silentLogger })),
            );

            await withServer(app, async (base) => {
                const created = await call(base, "POST", "/items", { name: "one" });
                const id = created.body.data._id;

                const first = await call(base, "GET", "/items");
                const second = await call(base, "GET", "/items");
                assert.strictEqual(first.cache, "MISS");
                assert.strictEqual(second.cache, "HIT");
                assert.deepStrictEqual(second.body, first.body);

                assert.strictEqual((await call(base, "GET", `/items/${id}`)).cache, "MISS");
                assert.strictEqual((await call(base, "GET", `/items/${id}`)).cache, "HIT");

                // Same parameters in another order: same entry.
                await call(base, "GET", "/items?page=1&pageSize=5");
                assert.strictEqual((await call(base, "GET", "/items?pageSize=5&page=1")).cache, "HIT");
            });
        });

        await t.test("a write is visible to the very next read", async () => {
            await Item.deleteMany({});
            const store = createMemoryCacheStore();
            const app = appWith((a) =>
                a.use("/items", createRouter({ model: Item, cache: { store }, allowedFields: ["name"], logger: silentLogger })),
            );

            await withServer(app, async (base) => {
                await call(base, "GET", "/items");
                assert.strictEqual((await call(base, "GET", "/items")).cache, "HIT");

                const created = await call(base, "POST", "/items", { name: "new" });
                const after = await call(base, "GET", "/items");
                assert.strictEqual(after.cache, "MISS");
                assert.strictEqual(after.body.data.length, 1);

                const id = created.body.data._id;
                await call(base, "GET", `/items/${id}`);
                await call(base, "PATCH", `/items/${id}`, { name: "renamed" });
                assert.strictEqual((await call(base, "GET", `/items/${id}`)).body.data.name, "renamed");

                await call(base, "DELETE", `/items/${id}`);
                assert.strictEqual((await call(base, "GET", `/items/${id}`)).status, 404);
            });
        });

        await t.test("a write through one router refreshes every router on the model", async () => {
            await Item.deleteMany({});
            const store = createMemoryCacheStore();
            const app = appWith((a) => {
                a.use("/public", createRouter({ model: Item, cache: { store }, allowedFields: [], logger: silentLogger }));
                a.use("/admin", createRouter({ model: Item, cache: { store }, allowedFields: ["name"], logger: silentLogger }));
            });

            await withServer(app, async (base) => {
                await call(base, "GET", "/public");
                assert.strictEqual((await call(base, "GET", "/public")).cache, "HIT");

                await call(base, "POST", "/admin", { name: "added by admin" });
                const pub = await call(base, "GET", "/public");
                assert.strictEqual(pub.cache, "MISS");
                assert.strictEqual(pub.body.data.length, 1);
            });
        });

        await t.test("routers with different output never share entries", async () => {
            await Item.deleteMany({});
            await Item.create({ name: "a", secret: "s3cr3t" });
            const store = createMemoryCacheStore();
            const app = appWith((a) => {
                a.use("/public", createRouter({
                    model: Item, cache: { store }, allowedFields: [], logger: silentLogger,
                    onGet: () => ({ selects: "-secret" }),
                }));
                a.use("/admin", createRouter({ model: Item, cache: { store }, allowedFields: [], logger: silentLogger }));
            });

            await withServer(app, async (base) => {
                await call(base, "GET", "/admin");
                const pub = await call(base, "GET", "/public");
                assert.strictEqual(pub.cache, "MISS");
                assert.strictEqual(pub.body.data[0].secret, undefined);
            });
        });

        await t.test("signed-in users each get their own entries", async () => {
            await Item.deleteMany({});
            await Item.create([{ name: "a", ownerId: "u1" }, { name: "b", ownerId: "u2" }]);
            const store = createMemoryCacheStore();

            // Stand-ins for requireAuth and a per-user scoping middleware.
            const fakeAuth = (req, res, next) => {
                req.auth = { userId: req.headers["x-user"] };
                next();
            };
            const onlyMine = (req, res, next) => {
                Object.defineProperty(req, "query", {
                    value: { ...req.query, ownerId: req.auth.userId },
                    writable: true, configurable: true, enumerable: true,
                });
                next();
            };

            const app = appWith((a) =>
                a.use("/mine", createRouter({
                    model: Item, cache: { store }, query: ["ownerId"], allowedFields: [], enableQuery: false,
                    middlewares: [fakeAuth, onlyMine], logger: silentLogger,
                })),
            );

            await withServer(app, async (base) => {
                const u1 = await call(base, "GET", "/mine", undefined, { "x-user": "u1" });
                const u2 = await call(base, "GET", "/mine", undefined, { "x-user": "u2" });
                assert.strictEqual(u2.cache, "MISS", "u2 must not receive u1's cached page");
                assert.deepStrictEqual(u1.body.data.map((d) => d.name), ["a"]);
                assert.deepStrictEqual(u2.body.data.map((d) => d.name), ["b"]);
                assert.strictEqual((await call(base, "GET", "/mine", undefined, { "x-user": "u1" })).cache, "HIT");
            });
        });

        await t.test("losing the version key causes a miss, never stale data", async () => {
            await Item.deleteMany({});
            const store = createMemoryCacheStore();
            const app = appWith((a) =>
                a.use("/items", createRouter({ model: Item, cache: { store }, allowedFields: ["name"], logger: silentLogger })),
            );
            const versionKey = "cs:" + Item.collection.collectionName + ":version";

            await withServer(app, async (base) => {
                await call(base, "GET", "/items");                      // cached: empty list
                await call(base, "POST", "/items", { name: "added" });  // new version
                await store.set(versionKey, "x", -1);                   // Redis evicts the version key
                const res = await call(base, "GET", "/items");
                assert.strictEqual(res.body.data.length, 1, "the old empty list must not come back");
            });
        });

        await t.test("errors are never cached", async () => {
            await Item.deleteMany({});
            const store = createMemoryCacheStore();
            const app = appWith((a) =>
                a.use("/items", createRouter({ model: Item, cache: { store }, allowedFields: [], logger: silentLogger })),
            );

            await withServer(app, async (base) => {
                const missing = new mongoose.Types.ObjectId().toString();
                await call(base, "GET", `/items/${missing}`);
                assert.strictEqual((await call(base, "GET", `/items/${missing}`)).cache, "MISS");
                await call(base, "GET", "/items?sort=nope");
                assert.strictEqual((await call(base, "GET", "/items?sort=nope")).status, 400);
                assert.strictEqual(store.size, 1, "nothing stored but the version key");
            });
        });

        await t.test("QUERY reads are keyed by their body", { skip: !isQueryMethodSupported() }, async () => {
            await Item.deleteMany({});
            await Item.create([{ name: "a" }, { name: "b" }]);
            const store = createMemoryCacheStore();
            const app = appWith((a) =>
                a.use("/items", createRouter({
                    model: Item, cache: { store }, filterableFields: ["name"], allowedFields: [], logger: silentLogger,
                })),
            );

            await withServer(app, async (base) => {
                const a1 = await call(base, "QUERY", "/items", { filter: { name: "a" } });
                const b1 = await call(base, "QUERY", "/items", { filter: { name: "b" } });
                assert.strictEqual(b1.cache, "MISS");
                assert.strictEqual(b1.body.data[0].name, "b");
                assert.strictEqual((await call(base, "QUERY", "/items", { filter: { name: "a" } })).cache, "HIT");
                assert.strictEqual(a1.body.data[0].name, "a");
            });
        });

        await t.test("a failing or hanging cache falls back to the database", async () => {
            await Item.deleteMany({});
            await Item.create({ name: "still served" });

            const failing = {
                get: async () => { throw new Error("ECONNREFUSED"); },
                set: async () => { throw new Error("ECONNREFUSED"); },
            };
            const hanging = { get: () => new Promise(() => {}), set: () => new Promise(() => {}) };

            const app = appWith((a) => {
                a.use("/failing", createRouter({ model: Item, cache: { store: failing }, allowedFields: ["name"], logger: silentLogger }));
                a.use("/hanging", createRouter({ model: Item, cache: { store: hanging, timeoutMs: 50 }, allowedFields: ["name"], logger: silentLogger }));
            });

            await withServer(app, async (base) => {
                const f = await call(base, "GET", "/failing");
                assert.strictEqual(f.status, 200);
                assert.strictEqual(f.cache, null);
                assert.strictEqual(f.body.data[0].name, "still served");

                const started = Date.now();
                const h = await call(base, "GET", "/hanging");
                assert.strictEqual(h.status, 200);
                assert.ok(Date.now() - started < 1000, "bounded by timeoutMs, not left waiting");

                const w = await call(base, "POST", "/hanging", { name: "written anyway" });
                assert.strictEqual(w.status, 201);
            });
        });

        await t.test("REDIS_URL without a client library: logged, and served from the database", async () => {
            const errors = [];
            const logger = { ...silentLogger, error: (m) => errors.push(m) };
            const router = withEnv({ REDIS_URL: "redis://127.0.0.1:6399" }, () =>
                createRouter({ model: Item, cache: true, allowedFields: [], logger }),
            );
            await withServer(appWith((a) => a.use("/items", router)), async (base) => {
                const res = await call(base, "GET", "/items");
                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.cache, null);
            });
            assert.ok(errors.some((m) => /npm install ioredis/.test(m)), errors.join("\n"));
        });

        await t.test("CACHE_ENABLED=false turns caching off", async () => {
            const store = createMemoryCacheStore();
            const router = withEnv({ CACHE_ENABLED: "false" }, () =>
                createRouter({ model: Item, cache: { store }, allowedFields: [], logger: silentLogger }),
            );
            await withServer(appWith((a) => a.use("/items", router)), async (base) => {
                await call(base, "GET", "/items");
                assert.strictEqual((await call(base, "GET", "/items")).cache, null);
            });
        });

        await t.test("invalidateCache() drops entries after an outside change", async () => {
            await Item.deleteMany({});
            const store = createMemoryCacheStore();
            const router = createRouter({ model: Item, cache: { store }, allowedFields: [], logger: silentLogger });

            await withServer(appWith((a) => a.use("/items", router)), async (base) => {
                await call(base, "GET", "/items");
                await Item.create({ name: "inserted directly" });
                assert.strictEqual((await call(base, "GET", "/items")).body.data.length, 0, "stale until told");

                await router.invalidateCache();
                const fresh = await call(base, "GET", "/items");
                assert.strictEqual(fresh.cache, "MISS");
                assert.strictEqual(fresh.body.data.length, 1);
            });
        });
    },
);
