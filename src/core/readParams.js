import {
    HttpError,
    isUnsafeKey,
    sanitizeFilterValue,
    sanitizeStructuredFilter,
} from "../utils/sanitize.js";

/**
 * Request → read parameters.
 *
 * Everything here is pure: it takes what the client sent plus the frozen config
 * and returns a Mongo filter, a sort spec or a page window. Nothing touches the
 * database, the response, or `this`. That is what lets `GET /` and `QUERY /`
 * share one set of rules instead of two implementations that drift apart.
 */

/** Keys a QUERY request body may contain. Anything else is a typo or an attempt. */
export const QUERY_BODY_KEYS = ["filter", "search", "sort", "page", "pageSize", "limit"];

/** Upper bound on sort keys in one QUERY body. */
export const MAX_SORT_KEYS = 5;

/** Operators `?compareOperator=` understands. */
const COMPARE_OPERATORS = { gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte", ne: "$ne", eq: "$eq" };

/** `"-createdAt"` -> `{ createdAt: -1 }`. */
export const sortSpecFor = (field) => {
    const descending = field.startsWith("-");
    const key = descending ? field.slice(1) : field;
    return { [key]: descending ? -1 : 1 };
};

/**
 * `legacyMode` waives the allowlist on the query string, because 2.x had none and
 * the flag exists to keep those deployments running. It is never waived for a
 * QUERY body: that route is new, so there is no old behaviour to preserve.
 */
const assertAllowed = (field, allowset, capability, { waive = false } = {}) => {
    if (waive) return field;
    if (typeof field !== "string" || !allowset.has(field)) {
        throw new HttpError(400, `Field '${field}' is not ${capability}.`);
    }
    return field;
};

/** The author's own `orderBy`, which is never checked against the allowlist. */
export const defaultSort = (config) => (config.defaultSort ? { ...config.defaultSort } : {});

/** Shared by `?s=` and a QUERY body's `search`, so both obey the same cap. */
export const normalizeSearchTerm = (term, config) => {
    if (term === undefined || term === null || term === "") return null;
    if (typeof term !== "string") {
        throw new HttpError(400, "Search term must be a string.");
    }
    if (term.length > config.maxSearchLength) {
        throw new HttpError(400, `Search term exceeds ${config.maxSearchLength} characters.`);
    }
    return term;
};

export const searchTermFromQueryString = (query, config) =>
    normalizeSearchTerm(query.s ?? query.search, config);

/* ------------------------------------------------------------------ *
 * Query string
 * ------------------------------------------------------------------ */

const parseRange = (raw) => {
    if (typeof raw !== "string") return null;
    const parts = raw.split("-");
    if (parts.length !== 2) return null;

    const range = {};
    const min = Number(parts[0].trim());
    const max = Number(parts[1].trim());

    if (parts[0].trim() !== "" && !Number.isNaN(min)) range.$gte = min;
    if (parts[1].trim() !== "" && !Number.isNaN(max)) range.$lte = max;

    return Object.keys(range).length > 0 ? range : null;
};

const parseCompare = (query) => {
    const mongoOp = COMPARE_OPERATORS[query.compareOperator || "eq"];
    if (!mongoOp) return undefined;

    const raw = query.compareValue;
    if (typeof raw === "object" && raw !== null) {
        throw new HttpError(400, "Invalid compareValue.");
    }

    const value = raw === "" ? "" : Number.isNaN(Number(raw)) ? raw : Number(raw);
    return mongoOp === "$eq" ? value : { [mongoOp]: value };
};

/** Equality params from `query`, plus the `rangeField` / `compareField` pairs. */
export const filtersFromQueryString = (query, config) => {
    const filters = {};
    const waive = config.legacyMode;

    for (const key of config.query) {
        const value = sanitizeFilterValue(query[key], key);
        if (value !== undefined) filters[key] = value;
    }

    if (query.rangeField && query.range) {
        const field = assertAllowed(query.rangeField, config.filterable, "filterable", { waive });
        const range = parseRange(query.range);
        if (range) filters[field] = range;
    }

    if (query.compareField && query.compareValue !== undefined) {
        const field = assertAllowed(query.compareField, config.filterable, "filterable", { waive });
        const compare = parseCompare(query);
        if (compare !== undefined) filters[field] = compare;
    }

    return filters;
};

export const sortFromQueryString = (query, config) => {
    const requested = query.sort;
    if (!requested) return defaultSort(config);

    if (typeof requested !== "string") {
        throw new HttpError(400, "Sort must be a single field name.");
    }

    const spec = sortSpecFor(requested);
    assertAllowed(Object.keys(spec)[0], config.sortable, "sortable", { waive: config.legacyMode });
    return spec;
};

/**
 * `?page=` switches on pagination; anything unparseable falls back to page 1
 * rather than erroring, which is long-standing behaviour callers rely on.
 */
export const pagingFromQueryString = (query, config) => {
    if (!query.page) return null;
    return {
        page: parseInt(query.page, 10) || 1,
        pageSize: parseInt(query.pageSize, 10) || config.defaultPageSize,
    };
};

/* ------------------------------------------------------------------ *
 * QUERY body
 * ------------------------------------------------------------------ */

const JSON_MEDIA_TYPE = /^application\/([\w.+-]+\+)?json$/;

/**
 * RFC 10008 defines `Accept-Query` as how a resource states which query format it
 * takes, so a 415 says what would have worked instead of only what did not.
 */
const unsupportedMediaType = (message) =>
    new HttpError(415, message, { headers: { "Accept-Query": "application/json" } });

const positiveInteger = (value, name) => {
    if (value === undefined || value === null) return undefined;
    if (!Number.isInteger(value) || value < 1) {
        throw new HttpError(400, `'${name}' must be a positive integer.`);
    }
    return value;
};

/**
 * Validates the envelope of a QUERY request and returns its recognised keys.
 *
 * An unknown key is a 400 rather than something to ignore: `{"filters": {...}}`
 * ignored quietly is a request to return the entire collection, which is the one
 * failure mode a read endpoint must not have.
 */
export const parseQueryBody = (req, config) => {
    const headers = req.headers ?? {};
    const declaredLength = Number(headers["content-length"] ?? 0);
    const hasBody = declaredLength > 0 || headers["transfer-encoding"] !== undefined;

    // A bodyless QUERY is a well-formed request for an unfiltered list.
    if (!hasBody) return {};

    const mediaType = String(headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();

    if (!JSON_MEDIA_TYPE.test(mediaType)) {
        throw unsupportedMediaType("QUERY body must be sent as application/json.");
    }

    if (req.body === undefined) {
        // The body arrived but nothing parsed it. That is a server
        // misconfiguration, and the log is the only place to say so.
        config.logger.error(
            "[ControllerSets] QUERY received an unparsed body. " +
                "Mount express.json() before this router.",
        );
        throw unsupportedMediaType(
            "QUERY body was not parsed as JSON. No body parser handled this Content-Type.",
        );
    }

    const body = req.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, "QUERY body must be a JSON object.");
    }

    for (const key of Object.keys(body)) {
        if (!QUERY_BODY_KEYS.includes(key)) {
            throw new HttpError(
                400,
                `Unknown key '${key}' in QUERY body. Allowed: ${QUERY_BODY_KEYS.join(", ")}.`,
            );
        }
    }

    const page = positiveInteger(body.page, "page");
    const pageSize = positiveInteger(body.pageSize, "pageSize");
    const limit = positiveInteger(body.limit, "limit");

    // `limit` caps an unpaginated read, so pairing it with paging is a
    // contradiction rather than a precedence puzzle to resolve silently.
    if (limit !== undefined && (page !== undefined || pageSize !== undefined)) {
        throw new HttpError(400, "Use either 'limit' or 'page'/'pageSize', not both.");
    }

    return { filter: body.filter, search: body.search, sort: body.sort, page, pageSize, limit };
};

/**
 * Turns a body's `filter` into a Mongo filter document. Field names are
 * allowlisted and operators are translated from a fixed table, so nothing the
 * client wrote is ever read as Mongo syntax.
 */
export const filtersFromBody = (filter, config) => {
    if (filter === undefined || filter === null) return {};
    if (typeof filter !== "object" || Array.isArray(filter)) {
        throw new HttpError(400, "'filter' must be a JSON object.");
    }

    const filters = {};
    for (const [field, value] of Object.entries(filter)) {
        if (isUnsafeKey(field) || !config.filterable.has(field)) {
            throw new HttpError(400, `Field '${field}' is not filterable.`);
        }
        const clause = sanitizeStructuredFilter(value, field);
        if (clause !== undefined) filters[field] = clause;
    }
    return filters;
};

/**
 * Sort from a QUERY body: one field name, or a list for multi-key sorting —
 * which the query string cannot express. Every key is allowlisted.
 */
export const sortFromBody = (sort, config) => {
    if (sort === undefined || sort === null) return defaultSort(config);

    const requested = Array.isArray(sort) ? sort : [sort];
    if (requested.length === 0) return defaultSort(config);
    if (requested.length > MAX_SORT_KEYS) {
        throw new HttpError(400, `'sort' accepts at most ${MAX_SORT_KEYS} fields.`);
    }

    const spec = {};
    for (const entry of requested) {
        if (typeof entry !== "string" || entry === "" || entry === "-") {
            throw new HttpError(400, "'sort' must be a field name, or a list of them.");
        }
        const [key, direction] = Object.entries(sortSpecFor(entry))[0];
        if (!config.sortable.has(key)) {
            throw new HttpError(400, `Field '${key}' is not sortable.`);
        }
        spec[key] = direction;
    }
    return spec;
};

/** Page window from a QUERY body. `pageSize` alone means the first page. */
export const pagingFromBody = (body, config) => {
    if (body.page === undefined && body.pageSize === undefined) return null;
    return { page: body.page ?? 1, pageSize: body.pageSize ?? config.defaultPageSize };
};
