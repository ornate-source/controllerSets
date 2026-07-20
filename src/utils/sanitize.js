/**
 * Input sanitization helpers.
 *
 * Everything in this module exists for one reason: values arriving on `req.query`
 * and `req.body` are attacker-controlled, and MongoDB gives special meaning to
 * `$`-prefixed keys and `.` separators. Treating either as inert data is how a
 * filter becomes an operator and a body field becomes a privilege escalation.
 */

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** Depth cap for the recursive key scan. Refuse to vouch for what we did not inspect. */
const MAX_SCAN_DEPTH = 8;

/** Never writable by a client, regardless of the configured field policy. */
export const IMMUTABLE_FIELDS = ["_id", "__v", "createdAt", "updatedAt"];

/**
 * Error carrying an HTTP status. `expose` marks a message as deliberately
 * authored for the client, which lets the error handler distinguish it from an
 * internal failure whose message may leak infrastructure detail.
 */
export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "HttpError";
        this.status = status;
        this.expose = true;
    }
}

/**
 * Escapes regex metacharacters so user input matches literally.
 * Without this, `(a+)+$` becomes a catastrophic-backtracking pattern executed
 * inside mongod — a database-tier denial of service from a single GET.
 */
export const escapeRegex = (value) => String(value).replace(REGEX_SPECIALS, "\\$&");

/**
 * A key is unsafe if Mongo would read it as something other than a plain field:
 * `$` introduces an operator, `.` traverses into a subdocument.
 */
export const isUnsafeKey = (key) =>
    typeof key !== "string" || key.startsWith("$") || key.includes(".");

/** Recursively reports whether any key in a value would be interpreted by Mongo. */
export const hasUnsafeKeysDeep = (value, depth = 0) => {
    if (depth > MAX_SCAN_DEPTH) return true;
    if (Array.isArray(value)) return value.some((item) => hasUnsafeKeysDeep(item, depth + 1));
    if (value === null || typeof value !== "object") return false;
    if (value instanceof Date) return false;

    for (const [key, child] of Object.entries(value)) {
        if (isUnsafeKey(key)) return true;
        if (hasUnsafeKeysDeep(child, depth + 1)) return true;
    }
    return false;
};

/**
 * Coerces an allowlisted query-string value into something safe to hand Mongo.
 *
 * Express 5 defaults to the `simple` query parser, under which `?a[$ne]=b` yields
 * the literal key `"a[$ne]"` and never reaches here as an object. But the host app
 * may set `query parser: 'extended'`, which this library cannot control — so the
 * value is validated regardless of how it was parsed.
 *
 * Repeated params (`?tag=a&tag=b`) arrive as arrays and are treated as `$in`,
 * which is what callers expect. Raw Mongo would read them as array equality.
 */
export const sanitizeFilterValue = (value, field) => {
    if (value === undefined || value === null) return undefined;

    if (Array.isArray(value)) {
        if (value.some((item) => item !== null && typeof item === "object")) {
            throw new HttpError(400, `Invalid value for filter '${field}'.`);
        }
        return value.length > 0 ? { $in: value } : undefined;
    }

    if (typeof value === "object") {
        throw new HttpError(400, `Invalid value for filter '${field}'.`);
    }

    return value;
};

/**
 * Normalizes `allowedFields` / `blockedFields` into a per-verb policy.
 * Each option accepts either a flat array (applied to both verbs) or
 * `{ create, update }` for per-verb control.
 */
export const resolveFieldPolicy = (allowedFields, blockedFields) => {
    const forVerb = (option, verb) => {
        if (!option) return undefined;
        if (Array.isArray(option)) return option;
        return Array.isArray(option[verb]) ? option[verb] : undefined;
    };

    return {
        create: {
            allow: forVerb(allowedFields, "create"),
            block: forVerb(blockedFields, "create"),
        },
        update: {
            allow: forVerb(allowedFields, "update"),
            block: forVerb(blockedFields, "update"),
        },
        configured: Boolean(allowedFields || blockedFields),
    };
};

/**
 * Filters a request body down to the fields a client is permitted to write.
 *
 * Mongoose's `strict` mode is not a substitute for this: it drops keys the schema
 * does not define, which means it discards harmless typos and faithfully persists
 * `{ role: "admin" }`.
 */
export const pickWritable = (body, rules) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};

    const out = {};
    for (const [key, value] of Object.entries(body)) {
        if (isUnsafeKey(key)) continue;
        if (IMMUTABLE_FIELDS.includes(key)) continue;
        if (rules.allow && !rules.allow.includes(key)) continue;
        if (rules.block && rules.block.includes(key)) continue;
        if (hasUnsafeKeysDeep(value)) continue;
        out[key] = value;
    }
    return out;
};
