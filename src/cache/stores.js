// Where cached responses live.
//
// A store is two async operations, and nothing else:
//
//     get(key)                 → string | null
//     set(key, value, seconds) → void
//
// Redis is the one that matters in production. The memory store exists for
// development and tests, and anything else (Memcached, a managed cache) is one
// small object away.

/* ------------------------------------------------------------------ *
 * Redis
 * ------------------------------------------------------------------ */

// node-redis exposes `isOpen`; ioredis exposes a `status` string. Their `set`
// signatures differ, which is the whole reason for the adapter.
const isNodeRedis = (client) => typeof client?.isOpen === "boolean";

const adapt = (client) => ({
    get: (key) => client.get(key),
    set: isNodeRedis(client)
        ? (key, value, seconds) => client.set(key, value, { EX: seconds })
        : (key, value, seconds) => client.set(key, value, "EX", seconds),
});

/**
 * Opens a client for a URL with whichever Redis library the app has installed.
 *
 * Both are configured to fail fast while disconnected rather than queue: a
 * queued command is a request left waiting on a cache that may never answer.
 */
const connect = async (url, logger) => {
    let ioredis;
    try {
        ioredis = await import("ioredis");
    } catch {
        // Fall through to node-redis.
    }

    if (ioredis) {
        const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
        const client = new Redis(url, {
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
        });
        // An EventEmitter 'error' with no listener takes the process down.
        client.on("error", (err) => logger.warn(`[ControllerSets] Redis: ${err.message}`));
        return client;
    }

    let redis;
    try {
        redis = await import("redis");
    } catch {
        throw new Error(
            "Caching needs a Redis client library. Install one: npm install ioredis (or: npm install redis).",
        );
    }

    const client = redis.createClient({
        url,
        disableOfflineQueue: true,
        socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
    });
    client.on("error", (err) => logger.warn(`[ControllerSets] Redis: ${err.message}`));
    await client.connect();
    return client;
};

// One connection per URL for the whole process, however many routers cache.
const connections = new Map();
const RETRY_AFTER_MS = 5000;

/**
 * The shared connection for a URL. A failed attempt is forgotten after a short
 * pause, so a Redis that comes back (or a library installed later) is picked up
 * without a restart — and a Redis that stays down costs one attempt per pause,
 * not one per request.
 */
const connectionFor = (url, logger) => {
    const existing = connections.get(url);
    if (existing && !(existing.failedAt && Date.now() - existing.failedAt >= RETRY_AFTER_MS)) {
        return existing.promise;
    }

    const entry = { promise: connect(url, logger), failedAt: null };
    entry.promise.catch(() => {
        entry.failedAt = Date.now();
    });
    connections.set(url, entry);
    return entry.promise;
};

/**
 * A store backed by Redis.
 *
 * Give it a `url` and it connects (once per URL, shared); give it a `client`
 * you already have — ioredis or node-redis — and it uses that one.
 */
export const createRedisCacheStore = ({ url, client, logger = console } = {}) => {
    if (client) return adapt(client);
    if (!url) throw new Error("createRedisCacheStore needs a 'url' or a 'client'.");

    const ready = connectionFor(url, logger);
    const current = async () => adapt(await connectionFor(url, logger));

    return {
        ready,
        get: async (key) => (await current()).get(key),
        set: async (key, value, seconds) => (await current()).set(key, value, seconds),
    };
};

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

/**
 * An in-process store: no server, nothing to install.
 *
 * For development and tests. Each process has its own copy, so behind a load
 * balancer instances would disagree — use Redis there.
 */
export const createMemoryCacheStore = ({ maxEntries = 1000 } = {}) => {
    const entries = new Map();

    const live = (key) => {
        const entry = entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            entries.delete(key);
            return undefined;
        }
        return entry;
    };

    const put = (key, value, expiresAt) => {
        // Re-inserting moves the key to the end, which makes the Map an LRU.
        entries.delete(key);
        entries.set(key, { value, expiresAt });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    };

    return {
        get: async (key) => {
            const entry = live(key);
            if (!entry) return null;
            put(key, entry.value, entry.expiresAt);
            return entry.value;
        },
        set: async (key, value, seconds) => put(key, value, Date.now() + seconds * 1000),
        /** Test helper: how many entries are held. */
        get size() {
            return entries.size;
        },
    };
};
