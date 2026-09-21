// Values on `req.query` and `req.body` are attacker-controlled, and MongoDB gives
// `$` and `.` special meaning — treating either as inert data is how a filter
// becomes an operator and a body field becomes privilege escalation.

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const MAX_SCAN_DEPTH = 8;

/** Never writable by a client, regardless of the configured field policy. */
export const IMMUTABLE_FIELDS = ["_id", "__v", "createdAt", "updatedAt"];

// `JSON.parse` makes `__proto__` a real own property, so `{"__proto__": {…}}`
// survives a naive key copy and re-points the payload's prototype on assignment.
export const POLLUTING_KEYS = ["__proto__", "constructor", "prototype"];

const POLLUTING = new Set(POLLUTING_KEYS);

/**
 * An HTTP status with a message written for the client — `expose` is what tells
 * the error handler it is safe to return. `headers` carries any header that
 * belongs with the status.
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

/** A rejected body with optional per-field messages — what a `validate` hook throws. */
export class ValidationError extends HttpError {
    constructor(message, fields, status = 400) {
        super(status, message);
        this.name = "ValidationError";
        if (fields && typeof fields === "object") this.fields = fields;
    }
}

/**
 * Escapes regex metacharacters so user input matches literally. Without this,
 * `(a+)+$` is a catastrophic-backtracking pattern executed inside mongod.
 */
export const escapeRegex = (value) => String(value).replace(REGEX_SPECIALS, "\\$&");

// `$` introduces a Mongo operator, `.` traverses into a subdocument, and the
// polluting keys reach the prototype chain. None of them are field names.
export const isUnsafeKey = (key) =>
    typeof key !== "string" ||
    key.startsWith("$") ||
    key.includes(".") ||
    POLLUTING.has(key);

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

// Express 5's `simple` parser turns `?a[$ne]=b` into the literal key `"a[$ne]"`,
// but the host app may switch to `extended` — so values are checked either way.
// Repeated params (`?tag=a&tag=b`) become `$in`, which is what callers expect.
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

// For objects the *server* built, such as a `validate` hook's return value: no
// allowlist, since server code may set fields a client cannot.
export const sanitizeAssignable = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (isUnsafeKey(key)) continue;
        out[key] = entry;
    }
    return out;
};

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

// Mongoose's `strict` mode is no substitute: it drops keys the schema does not
// define, which discards harmless typos and faithfully persists `{ role: "admin" }`.
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

// Deliberately un-prefixed: this table is the only thing that turns a word into a
// Mongo operator, so a literal `$` key fails the lookup instead of executing.
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

// One `filter` entry → one clause: a scalar (equality), a list (`in`), or a flat
// object of allowlisted operators. Anything else is a 400.
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
