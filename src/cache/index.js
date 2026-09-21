import { createHash, randomBytes } from "node:crypto";
import { createRedisCacheStore } from "./stores.js";

// Response caching for the read routes.
//
// Reads (GET /, QUERY /, GET /:id) are served from the cache when they can be,
// and stored after a successful database read. Writes invalidate by replacing a
// per-model version token that is part of every key: one SET orphans every
// cached response for that model — across all routers on it — and the orphans
// expire on their own. No SCAN, no key lists.
//
// The token is random, not a counter. A counter that Redis evicts under memory
// pressure restarts at 1 and resurrects old entries; a random token that goes
// missing is simply replaced, and the worst case is a cache miss.
//
// The cache is an accelerator, never a dependency. Every call is raced against
// a short timeout, and any failure falls through to the database: a Redis that
// is down, slow or unreachable makes responses slower, never wrong or broken.

const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_PREFIX = "cs:";
const DEFAULT_TIMEOUT_MS = 150;
const WARN_INTERVAL_MS = 30_000;
// The version token outlives any entry; if it expires anyway, a new one is made.
const VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const newVersion = () => randomBytes(6).toString("base64url");

const envFlag = (name) => {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) return undefined;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    throw new Error(`${name} must be true or false, not '${process.env[name]}'.`);
};

const envInt = (name) => {
    const raw = process.env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive whole number of seconds, not '${raw}'.`);
    }
    return value;
};

/** JSON with object keys sorted, so `?a=1&b=2` and `?b=2&a=1` share a key. */
const stableStringify = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
};

const isStore = (store) =>
    store && ["get", "set"].every((method) => typeof store[method] === "function");

// Once per process per interval: a Redis outage should be one line every thirty
// seconds, not one per request.
let lastWarnAt = 0;

export const resolveCache = (option, { model, logger }) => {
    if (option === undefined || option === null || option === false) return null;

    // A switch for operators: turn caching off everywhere without a deploy.
    if (envFlag("CACHE_ENABLED") === false) return null;

    if (option !== true && (typeof option !== "object" || Array.isArray(option))) {
        throw new Error("ControllerSets: 'cache' must be true or an options object.");
    }
    const settings = option === true ? {} : option;

    const ttl = settings.ttl ?? envInt("CACHE_TTL") ?? DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 1) {
        throw new Error("ControllerSets: 'cache.ttl' must be a positive whole number of seconds.");
    }

    const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const prefix = settings.prefix ?? process.env.CACHE_PREFIX ?? DEFAULT_PREFIX;

    // Per-user by default: a guarded router's responses often depend on who is
    // asking, and serving one user's page to another is the one mistake a cache
    // must never make. Shared data behind a guard can opt out with `vary: () => ''`.
    const vary = settings.vary ?? ((req) => req.auth?.userId ?? "");
    if (typeof vary !== "function") {
        throw new Error("ControllerSets: 'cache.vary' must be a function of the request.");
    }

    let store;
    if (settings.store) {
        if (!isStore(settings.store)) {
            throw new Error("ControllerSets: 'cache.store' needs get and set methods.");
        }
        store = settings.store;
    } else if (settings.client) {
        store = createRedisCacheStore({ client: settings.client });
    } else {
        const url = settings.url ?? process.env.REDIS_URL;
        if (!url) {
            throw new Error(
                "ControllerSets: caching needs a Redis URL — set REDIS_URL, or pass cache.url, cache.client or cache.store.",
            );
        }
        store = createRedisCacheStore({ url, logger });
        // Connect now, so a bad URL or missing library shows up at startup.
        store.ready.catch((err) =>
            logger.error(`[ControllerSets] Cache disabled until Redis is reachable: ${err.message}`),
        );
    }

    const modelName = model.collection?.collectionName ?? model.modelName ?? "model";
    const modelKey = `${prefix}${modelName}`;
    const versionKey = `${modelKey}:version`;

    const guard = (operation) => {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs);
        });
        return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
    };

    const unavailable = (err) => {
        const now = Date.now();
        if (now - lastWarnAt < WARN_INTERVAL_MS) return;
        lastWarnAt = now;
        logger.warn(`[ControllerSets] Cache unavailable (${err.message}); serving from the database.`);
    };

    // Everything a response can depend on goes into the key: the router it was
    // served by, the parsed query (after your middleware ran), the id, the QUERY
    // body, and whatever `vary` says. Built from `req.query`, not the raw URL,
    // so a middleware that pins a filter is part of the key.
    const keyFor = (kind, version, req) => {
        const digest = createHash("sha1")
            .update(
                stableStringify({
                    r: settings.namespace ?? req.baseUrl ?? "",
                    q: req.query ?? {},
                    i: req.params?.id,
                    b: kind === "query" ? req.body : undefined,
                    v: String(vary(req) ?? ""),
                }),
            )
            .digest("base64url");
        return `${modelKey}:v${version}:${kind}:${digest}`;
    };

    /** Wraps a read handler: serve from cache, or read and remember. */
    const read = (kind, run) => async (req, res) => {
        let key = null;
        try {
            let version = await guard(() => store.get(versionKey));
            if (version === null || version === undefined) {
                version = newVersion();
                await guard(() => store.set(versionKey, version, VERSION_TTL_SECONDS));
            }
            key = keyFor(kind, version, req);
            const hit = await guard(() => store.get(key));
            if (hit !== null && hit !== undefined) {
                res.setHeader("X-Cache", "HIT");
                return res.status(200).type("application/json").send(hit);
            }
        } catch (err) {
            unavailable(err);
            key = null;
        }

        if (key) {
            res.setHeader("X-Cache", "MISS");
            const send = res.json;
            res.json = function json(body) {
                res.json = send;
                // Only complete successes are worth keeping; errors must be re-asked.
                if (res.statusCode === 200 && body?.success === true) {
                    guard(() => store.set(key, JSON.stringify(body), ttl)).catch(unavailable);
                }
                return send.call(this, body);
            };
        }
        return run(req, res);
    };

    const invalidate = () => guard(() => store.set(versionKey, newVersion(), VERSION_TTL_SECONDS));

    /**
     * Wraps a write handler: on success, invalidate *before* the response goes
     * out, so a client that reads straight after its own write sees it.
     */
    const write = (run) => async (req, res) => {
        const send = res.json;
        res.json = function json(body) {
            res.json = send;
            if (res.statusCode < 200 || res.statusCode >= 300) return send.call(this, body);
            invalidate()
                .catch(unavailable)
                .finally(() => send.call(res, body));
            return res;
        };
        return run(req, res);
    };

    return Object.freeze({ ttl, prefix, store, read, write, invalidate });
};
