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
 * Keys that reach an object's prototype chain rather than its own data.
 *
 * `JSON.parse` creates `__proto__` as a real own property, so a body of
 * `{"__proto__": {"isAdmin": true}}` survives a naive key copy and re-points the
 * payload's prototype on assignment. These are never field names.
 */
export const POLLUTING_KEYS = ["__proto__", "constructor", "prototype"];

const POLLUTING = new Set(POLLUTING_KEYS);

/**
 * Error carrying an HTTP status. `expose` marks a message as deliberately
 * authored for the client, which lets the error handler distinguish it from an
 * internal failure whose message may leak infrastructure detail.
 *
 * `headers` carries response headers that belong with the status — a 415 that
 * names the format it wanted, for instance — so the handler that renders the
 * error does not need to know why.
 */
export class HttpError extends Error {
    constructor(status, message, { headers } = {}) {
        super(message);
        this.name = "HttpError";
        this.status = status;
        this.expose = true;
        if (headers) this.headers = headers;
    }
}

/**
 * A rejected request body, optionally with per-field messages.
 *
 * This is what a custom `validate` hook throws. It is deliberately separate from
 * Mongoose's own `ValidationError`: that one carries an `errors` map of
 * `ValidatorError` objects, while this one carries plain strings the API author
 * wrote for the client.
 */
export class ValidationError extends HttpError {
    constructor(message, fields, status = 400) {
        super(status, message);
        this.name = "ValidationError";
        if (fields && typeof fields === "object") this.fields = fields;
    }
}

/**
 * Escapes regex metacharacters so user input matches literally.
 * Without this, `(a+)+$` becomes a catastrophic-backtracking pattern executed
 * inside mongod — a database-tier denial of service from a single GET.
 */
export const escapeRegex = (value) => String(value).replace(REGEX_SPECIALS, "\\$&");

/**
 * A key is unsafe if it would be read as something other than a plain field:
 * `$` introduces a Mongo operator, `.` traverses into a subdocument, and
 * `__proto__` / `constructor` / `prototype` reach the prototype chain.
 */
export const isUnsafeKey = (key) =>
    typeof key !== "string" ||
    key.startsWith("$") ||
    key.includes(".") ||
    POLLUTING.has(key);

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
 * Strips keys that are syntax rather than data from an object the *server* built
 * — the return value of a `validate` hook, for example.
 *
 * Unlike `pickWritable` this applies no allowlist: code running on the server is
 * trusted to set fields a client may not. It is only the keys that can change an
 * object's shape or meaning that are refused, because no legitimate hook needs
 * them.
 */
export const sanitizeAssignable = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (isUnsafeKey(key)) continue;
        out[key] = entry;
    }
    return out;
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

/**
 * Operators a client may use inside a QUERY request body.
 *
 * The keys are deliberately un-prefixed: a client never writes `$gte`, it writes
 * `gte`, and this table is the only thing that can turn a word into a Mongo
 * operator. A body that contains a literal `$` key is therefore never one
 * operator away from being executed — it fails the lookup and is rejected.
 */
export const QUERY_FILTER_OPERATORS = Object.freeze({
    eq: "$eq",
    ne: "$ne",
    gt: "$gt",
    gte: "$gte",
    lt: "$lt",
    lte: "$lte",
    in: "$in",
    nin: "$nin",
});

/** Operators taking a list rather than a single value. */
const LIST_OPERATORS = new Set(["in", "nin"]);

/** Upper bound on `in` / `nin` list length. An unbounded list is an unbounded query. */
export const MAX_FILTER_LIST_LENGTH = 100;

const isScalar = (value) =>
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";

const requireScalar = (value, field, operator) => {
    if (!isScalar(value)) {
        throw new HttpError(400, `Operator '${operator}' on '${field}' expects a single value.`);
    }
    return value;
};

const assertScalarList = (value, field, operator) => {
    if (!Array.isArray(value)) {
        throw new HttpError(400, `Operator '${operator}' on '${field}' expects a list.`);
    }
    if (value.length === 0) {
        throw new HttpError(400, `Operator '${operator}' on '${field}' expects a non-empty list.`);
    }
    if (value.length > MAX_FILTER_LIST_LENGTH) {
        throw new HttpError(
            400,
            `Operator '${operator}' on '${field}' exceeds ${MAX_FILTER_LIST_LENGTH} values.`,
        );
    }
    if (!value.every(isScalar)) {
        throw new HttpError(400, `Operator '${operator}' on '${field}' expects scalar values.`);
    }
    return value;
};

/**
 * Translates one entry of a QUERY body's `filter` object into a Mongo clause.
 *
 * Accepts a scalar (equality), a list (treated as `in`, matching how repeated
 * query-string params behave), or a flat object of allowlisted operators.
 * Anything else — nested objects, functions, `$`-prefixed keys, mixed shapes —
 * is a 400 rather than something to interpret generously.
 */
export const sanitizeStructuredFilter = (value, field) => {
    if (value === undefined) return undefined;

    if (isScalar(value)) return value;

    if (Array.isArray(value)) {
        return { $in: assertScalarList(value, field, "in") };
    }

    if (typeof value !== "object" || value instanceof Date) {
        throw new HttpError(400, `Invalid value for filter '${field}'.`);
    }

    const entries = Object.entries(value);
    if (entries.length === 0) {
        throw new HttpError(400, `Filter '${field}' has no conditions.`);
    }

    const clause = {};
    for (const [operator, operand] of entries) {
        const mongoOp = Object.hasOwn(QUERY_FILTER_OPERATORS, operator)
            ? QUERY_FILTER_OPERATORS[operator]
            : undefined;

        if (!mongoOp) {
            throw new HttpError(
                400,
                `Unknown operator '${operator}' on '${field}'. Allowed: ` +
                    `${Object.keys(QUERY_FILTER_OPERATORS).join(", ")}.`,
            );
        }

        clause[mongoOp] = LIST_OPERATORS.has(operator)
            ? assertScalarList(operand, field, operator)
            : requireScalar(operand, field, operator);
    }

    return clause;
};
