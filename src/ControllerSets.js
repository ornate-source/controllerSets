import mongoose from "mongoose";
import {
    HttpError,
    escapeRegex,
    isUnsafeKey,
    pickWritable,
    resolveFieldPolicy,
    sanitizeFilterValue,
    sanitizeStructuredFilter,
} from "./utils/sanitize.js";

const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_MAX_SEARCH_LENGTH = 128;
const DEFAULT_PAGE_SIZE = 50;

/** Keys a QUERY request body may contain. Anything else is a typo or an attempt. */
const QUERY_BODY_KEYS = ["filter", "search", "sort", "page", "pageSize", "limit"];

/** Upper bound on sort keys in one QUERY body. */
const MAX_SORT_KEYS = 5;

const defaultLogger = {
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: () => {},
};

/** Models already warned about, so an unconfigured policy logs once rather than per instance. */
const policyWarned = new Set();

/**
 * ControllerSets - Express CRUD logic for Mongoose models.
 *
 * The governing principle is implicit-deny: a field is not filterable, sortable,
 * or writable until the API author names it. This library generates *public*
 * endpoints, so anything left open is open to everyone.
 */
class ControllerSets {
    constructor(...args) {
        const options = normalizeOptions(args);

        if (!options.model) {
            throw new Error("ControllerSets: Mongoose model is required.");
        }

        this.model = options.model;
        this.orderBy = options.orderBy ?? "none";
        this.query = Array.isArray(options.query) ? options.query : [];
        this.search = options.search ?? [];
        this.runAfterCreate = options.runAfterCreate ?? "none";
        this.onGet = options.onGet ?? "none";

        this.legacyMode = options.legacyMode === true;
        this.logger = options.logger ?? defaultLogger;

        this.fieldPolicy = resolveFieldPolicy(options.allowedFields, options.blockedFields);
        this.filterableFields = options.filterableFields ?? this.query;
        this.sortableFields = options.sortableFields ?? defaultSortable(this.query, this.orderBy);

        this.maxLimit = Number.isInteger(options.maxLimit) ? options.maxLimit : DEFAULT_MAX_LIMIT;
        this.maxSearchLength = options.maxSearchLength ?? DEFAULT_MAX_SEARCH_LENGTH;
        this.allowRawRegex = options.allowRawRegex === true;
        this.lean = options.lean === true;
        this.strictAfterCreate = options.strictAfterCreate === true;

        this.#warnIfUnprotected();
    }

    /**
     * Mass assignment is silent and total when unconfigured, and consumers
     * upgrading from 2.x will not read a changelog. The console will reach them.
     */
    #warnIfUnprotected() {
        if (this.legacyMode || this.fieldPolicy.configured) return;

        const name = this.model?.modelName ?? "<model>";
        if (policyWarned.has(name)) return;
        policyWarned.add(name);

        this.logger.warn(
            `[ControllerSets] '${name}' has no allowedFields/blockedFields configured. ` +
                `Every schema-defined field is client-writable via POST and PATCH, ` +
                `including fields like 'role' or 'isAdmin'. See MIGRATION.md.`,
        );
    }

    /**
     * Converts deliberate 4xx errors into responses here rather than relying on
     * the consumer having mounted `errorHandler`. Anything else propagates:
     * Express 5 forwards rejected promises, and an unexpected failure should not
     * be flattened into a tidy 400.
     */
    #guard(handler) {
        return async (req, res) => {
            try {
                return await handler(req, res);
            } catch (err) {
                if (err instanceof HttpError) {
                    return this.sendErrorResponse(res, err.status, err.message);
                }
                throw err;
            }
        };
    }

    #assertAllowed(field, allowlist, capability) {
        if (this.legacyMode) return field;
        if (typeof field !== "string" || !allowlist.includes(field)) {
            throw new HttpError(400, `Field '${field}' is not ${capability}.`);
        }
        return field;
    }

    /**
     * Builds the `$regex` clause for a search term.
     *
     * Escaped by default: an unescaped term is a pattern the client authored and
     * mongod executes. Raw regex remains available for trusted callers via
     * `allowRawRegex`, but it must be a decision, not a default.
     */
    #regexFor(term) {
        const value = this.allowRawRegex || this.legacyMode ? String(term) : escapeRegex(term);
        return { $regex: value, $options: "i" };
    }

    /** Shared by `?s=` and the QUERY body's `search`, so both obey the same cap. */
    #normalizeSearchTerm(term) {
        if (term === undefined || term === null || term === "") return null;
        if (typeof term !== "string") {
            throw new HttpError(400, "Search term must be a string.");
        }
        if (term.length > this.maxSearchLength) {
            throw new HttpError(400, `Search term exceeds ${this.maxSearchLength} characters.`);
        }
        return term;
    }

    #searchTermFrom(req) {
        return this.#normalizeSearchTerm(req.query.s ?? req.query.search);
    }

    #buildFilters(req) {
        const filters = {};

        for (const key of this.query) {
            const value = sanitizeFilterValue(req.query[key], key);
            if (value !== undefined) filters[key] = value;
        }

        if (req.query.rangeField && req.query.range) {
            const field = this.#assertAllowed(
                req.query.rangeField,
                this.filterableFields,
                "filterable",
            );
            const range = this.#parseRange(req.query.range);
            if (range) filters[field] = range;
        }

        if (req.query.compareField && req.query.compareValue !== undefined) {
            const field = this.#assertAllowed(
                req.query.compareField,
                this.filterableFields,
                "filterable",
            );
            const compare = this.#parseCompare(req.query);
            if (compare !== undefined) filters[field] = compare;
        }

        return filters;
    }

    #parseRange(raw) {
        if (typeof raw !== "string") return null;
        const parts = raw.split("-");
        if (parts.length !== 2) return null;

        const range = {};
        const min = Number(parts[0].trim());
        const max = Number(parts[1].trim());

        if (parts[0].trim() !== "" && !Number.isNaN(min)) range.$gte = min;
        if (parts[1].trim() !== "" && !Number.isNaN(max)) range.$lte = max;

        return Object.keys(range).length > 0 ? range : null;
    }

    #parseCompare(query) {
        const opMap = { gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte", ne: "$ne", eq: "$eq" };
        const mongoOp = opMap[query.compareOperator || "eq"];
        if (!mongoOp) return undefined;

        const raw = query.compareValue;
        if (typeof raw === "object" && raw !== null) {
            throw new HttpError(400, "Invalid compareValue.");
        }

        const value = raw === "" ? "" : Number.isNaN(Number(raw)) ? raw : Number(raw);
        return mongoOp === "$eq" ? value : { [mongoOp]: value };
    }

    async #applySearchTerm(filters, term) {
        if (!term) return;

        if (!Array.isArray(this.search)) {
            if (this.search && this.search !== "none") {
                filters[this.search] = this.#regexFor(term);
            }
            return;
        }

        if (this.search.length === 0) return;

        const clauses = await Promise.all(
            this.search.map((field) => this.#searchClauseFor(field, term)),
        );
        const valid = clauses.filter(Boolean);

        // No matching relation means no results — not "ignore the search term".
        filters.$or = valid.length > 0 ? valid : [{ _id: null }];
    }

    async #searchClauseFor(field, term) {
        const dot = field.indexOf(".");
        if (dot === -1) return { [field]: this.#regexFor(term) };

        // Split on the first separator only: `author.profile.name` targets the
        // nested path `profile.name` on the referenced model, not `profile`.
        const relation = field.slice(0, dot);
        const childPath = field.slice(dot + 1);

        const schemaPath = this.model.schema?.path?.(relation);
        const refName = schemaPath?.options?.ref;
        if (!refName) return null;

        try {
            const refModel = mongoose.model(refName);
            const matched = await refModel
                .find({ [childPath]: this.#regexFor(term) })
                .select("_id")
                .lean();

            return matched.length > 0
                ? { [relation]: { $in: matched.map((doc) => doc._id) } }
                : null;
        } catch (err) {
            this.logger.error(
                `[ControllerSets] Failed to resolve relational search for '${field}': ${err.message}`,
            );
            return null;
        }
    }

    /** The author's own `orderBy`, which is never checked against the allowlist. */
    #defaultSort() {
        if (!this.orderBy || this.orderBy === "none") return {};
        return sortSpecFor(this.orderBy);
    }

    #buildSort(req) {
        const requested = req.query.sort;
        if (!requested) return this.#defaultSort();

        if (typeof requested !== "string") {
            throw new HttpError(400, "Sort must be a single field name.");
        }

        // Only a client-supplied `?sort=` is checked against the allowlist.
        const spec = sortSpecFor(requested);
        this.#assertAllowed(Object.keys(spec)[0], this.sortableFields, "sortable");
        return spec;
    }

    #applyReadOptions(query, populates, selects) {
        const shaped = query.populate(populates).select(selects);
        return this.lean ? shaped.lean() : shaped;
    }

    #validateId(id) {
        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new HttpError(400, "Invalid ID format.");
        }
        return id;
    }

    /**
     * Resolves populate and select options from the onGet hook.
     * Returns safe defaults when no hook is provided.
     */
    getPopulates = async (req, res) => {
        if (typeof this.onGet !== "function") {
            return { populates: [], selects: "" };
        }
        try {
            const result = await this.onGet(req, res);
            return {
                populates: result?.populates || [],
                selects: result?.selects || "",
            };
        } catch (err) {
            this.logger.error(`[ControllerSets] Error in onGet: ${err.message}`);
            return { populates: [], selects: "" };
        }
    };

    /**
     * GET / - Retrieves records with filtering, searching, and pagination.
     * Always bounded: an unpaginated request is still capped at `maxLimit`.
     */
    getAll = this.#guard(async (req, res) => {
        const filters = this.#buildFilters(req);
        await this.#applySearchTerm(filters, this.#searchTermFrom(req));
        const sort = this.#buildSort(req);

        const { populates, selects } = await this.getPopulates(req, res);

        if (req.query.page) {
            return await this.getPaginatedResults(req, res, filters, sort, populates, selects);
        }

        const limit = this.legacyMode ? 0 : this.maxLimit;
        const query = this.model.find(filters).sort(sort).limit(limit);
        const result = await this.#applyReadOptions(query, populates, selects);

        return res.status(200).json({ success: true, data: result });
    });

    /**
     * QUERY / - A read whose parameters travel in the body instead of the URL.
     *
     * QUERY (RFC 10008) is safe and idempotent: it is GET with a body, for filters
     * that are too long for a URL, too structured to flatten into a query string,
     * or too sensitive to leave in proxy and access logs. The response is
     * byte-for-byte what the equivalent GET would return.
     *
     * The body is deliberately *not* a Mongo query. Field names are checked against
     * the same allowlists the query string uses, operators are spelled without `$`
     * and translated through a fixed table, and a body carrying a literal `$` key
     * fails that lookup rather than reaching the driver.
     */
    queryAll = this.#guard(async (req, res) => {
        const body = this.#queryBodyFrom(req, res);

        const filters = this.#buildStructuredFilters(body.filter);
        await this.#applySearchTerm(filters, this.#normalizeSearchTerm(body.search));
        const sort = this.#buildQuerySort(body.sort);

        const { populates, selects } = await this.getPopulates(req, res);

        if (body.page !== undefined || body.pageSize !== undefined) {
            return await this.#paginate(res, {
                filters,
                sort,
                populates,
                selects,
                page: body.page,
                pageSize: body.pageSize,
            });
        }

        const limit = Math.min(this.maxLimit, body.limit ?? this.maxLimit);
        const query = this.model.find(filters).sort(sort).limit(limit);
        const result = await this.#applyReadOptions(query, populates, selects);

        return res.status(200).json({ success: true, data: result });
    });

    /**
     * Validates the envelope of a QUERY request and returns its recognised keys.
     *
     * An unknown key is a 400 rather than something to ignore: `{"filters": {...}}`
     * ignored quietly is a request to return the entire collection, which is the
     * one failure mode a read endpoint must not have.
     */
    #queryBodyFrom(req, res) {
        const headers = req.headers ?? {};
        const declaredLength = Number(headers["content-length"] ?? 0);
        const hasBody = declaredLength > 0 || headers["transfer-encoding"] !== undefined;

        // A bodyless QUERY is a well-formed request for an unfiltered list.
        if (!hasBody) return {};

        const mediaType = String(headers["content-type"] ?? "")
            .split(";")[0]
            .trim()
            .toLowerCase();

        if (!/^application\/([\w.+-]+\+)?json$/.test(mediaType)) {
            throw this.#unsupportedMediaType(res, "QUERY body must be sent as application/json.");
        }

        if (req.body === undefined) {
            // The body arrived but nothing parsed it. That is a server
            // misconfiguration, and the log is the only place to say so.
            this.logger.error(
                "[ControllerSets] QUERY received an unparsed body. " +
                    "Mount express.json() before this router.",
            );
            throw this.#unsupportedMediaType(
                res,
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

        const page = this.#positiveInteger(body.page, "page");
        const pageSize = this.#positiveInteger(body.pageSize, "pageSize");
        const limit = this.#positiveInteger(body.limit, "limit");

        // `limit` caps an unpaginated read, so pairing it with paging is a
        // contradiction rather than a precedence puzzle to resolve silently.
        if (limit !== undefined && (page !== undefined || pageSize !== undefined)) {
            throw new HttpError(400, "Use either 'limit' or 'page'/'pageSize', not both.");
        }

        return { filter: body.filter, search: body.search, sort: body.sort, page, pageSize, limit };
    }

    /**
     * RFC 10008 defines `Accept-Query` as the way a resource states which query
     * format it takes, so a 415 says what would have worked instead of only
     * what did not.
     */
    #unsupportedMediaType(res, message) {
        res?.setHeader?.("Accept-Query", "application/json");
        return new HttpError(415, message);
    }

    #positiveInteger(value, name) {
        if (value === undefined || value === null) return undefined;
        if (!Number.isInteger(value) || value < 1) {
            throw new HttpError(400, `'${name}' must be a positive integer.`);
        }
        return value;
    }

    /**
     * Turns the body's `filter` into a Mongo filter document.
     *
     * Unlike the query string, the allowlist is enforced even under `legacyMode`:
     * QUERY has no 2.x behaviour to stay compatible with, so there is no reason to
     * ship it with the gate open.
     */
    #buildStructuredFilters(filter) {
        if (filter === undefined || filter === null) return {};
        if (typeof filter !== "object" || Array.isArray(filter)) {
            throw new HttpError(400, "'filter' must be a JSON object.");
        }

        const filters = {};
        for (const [field, value] of Object.entries(filter)) {
            if (isUnsafeKey(field) || !this.filterableFields.includes(field)) {
                throw new HttpError(400, `Field '${field}' is not filterable.`);
            }
            const clause = sanitizeStructuredFilter(value, field);
            if (clause !== undefined) filters[field] = clause;
        }
        return filters;
    }

    /**
     * Sort from a QUERY body: one field name, or a list for multi-key sorting —
     * which the query string cannot express. Every key is allowlisted.
     */
    #buildQuerySort(sort) {
        if (sort === undefined || sort === null) return this.#defaultSort();

        const requested = Array.isArray(sort) ? sort : [sort];
        if (requested.length === 0) return this.#defaultSort();
        if (requested.length > MAX_SORT_KEYS) {
            throw new HttpError(400, `'sort' accepts at most ${MAX_SORT_KEYS} fields.`);
        }

        const spec = {};
        for (const entry of requested) {
            if (typeof entry !== "string" || entry === "" || entry === "-") {
                throw new HttpError(400, "'sort' must be a field name, or a list of them.");
            }
            const [key, direction] = Object.entries(sortSpecFor(entry))[0];
            if (!this.sortableFields.includes(key)) {
                throw new HttpError(400, `Field '${key}' is not sortable.`);
            }
            spec[key] = direction;
        }
        return spec;
    }

    /**
     * GET /:id - Retrieves a single record by its ID.
     */
    getById = this.#guard(async (req, res) => {
        const id = this.#validateId(req.params.id);
        const { populates, selects } = await this.getPopulates(req, res);

        const object = await this.#applyReadOptions(this.model.findById(id), populates, selects);
        if (!object) {
            return this.sendErrorResponse(res, 404, "Entry not found.");
        }

        return res.status(200).json({ success: true, data: object });
    });

    /**
     * POST / - Creates a new record from the writable subset of the body.
     */
    create = this.#guard(async (req, res) => {
        const payload = this.legacyMode
            ? req.body
            : pickWritable(req.body, this.fieldPolicy.create);

        if (!this.legacyMode && Object.keys(payload).length === 0) {
            throw new HttpError(400, "Request body contains no writable fields.");
        }

        const result = await this.model.create(payload);

        if (typeof this.runAfterCreate === "function") {
            try {
                await this.runAfterCreate(result);
            } catch (callbackError) {
                this.logger.error(
                    `[ControllerSets] Error in runAfterCreate callback: ${callbackError.message}`,
                );
                // The record exists but its side effect did not run. Surfacing that
                // is opt-in, because failing here leaves the caller unable to tell
                // whether the write landed.
                if (this.strictAfterCreate) throw callbackError;
            }
        }

        return res.status(201).json({ success: true, data: result });
    });

    /**
     * PATCH /:id - Updates a record in a single atomic query.
     */
    update = this.#guard(async (req, res) => {
        const id = this.#validateId(req.params.id);
        const payload = this.legacyMode
            ? req.body
            : pickWritable(req.body, this.fieldPolicy.update);

        if (!this.legacyMode && Object.keys(payload).length === 0) {
            throw new HttpError(400, "Request body contains no writable fields.");
        }

        const { populates, selects } = await this.getPopulates(req, res);

        const query = this.model.findByIdAndUpdate(
            id,
            { $set: payload },
            { returnDocument: "after", runValidators: true, context: "query" },
        );
        const updated = await this.#applyReadOptions(query, populates, selects);

        if (!updated) {
            return this.sendErrorResponse(res, 404, "Entry not found.");
        }

        return res.status(200).json({ success: true, data: updated });
    });

    /**
     * DELETE /:id - Deletes a record in a single atomic query.
     */
    delete = this.#guard(async (req, res) => {
        const id = this.#validateId(req.params.id);

        const deleted = await this.model.findByIdAndDelete(id);
        if (!deleted) {
            return this.sendErrorResponse(res, 404, "Entry not found.");
        }

        return res.status(200).json({ success: true, message: "Item successfully deleted." });
    });

    /**
     * Internal pagination logic.
     */
    getPaginatedResults = async (req, res, filters, sort, populates = [], selects = "") => {
        return this.#paginate(res, {
            filters,
            sort,
            populates,
            selects,
            page: parseInt(req.query.page) || 1,
            pageSize: parseInt(req.query.pageSize) || DEFAULT_PAGE_SIZE,
        });
    };

    /**
     * One paginated read, whichever method asked for it. Page bounds are clamped
     * here rather than at each call site, so `pageSize` can never exceed
     * `maxLimit` no matter how the request expressed it.
     */
    async #paginate(res, { filters, sort, populates = [], selects = "", page, pageSize }) {
        const safePage = Math.max(1, page ?? 1);
        const safeSize = Math.min(this.maxLimit, Math.max(1, pageSize ?? DEFAULT_PAGE_SIZE));
        const skip = (safePage - 1) * safeSize;

        const query = this.model.find(filters).skip(skip).limit(safeSize).sort(sort);

        const [totalRecords, result] = await Promise.all([
            this.model.countDocuments(filters),
            this.#applyReadOptions(query, populates, selects),
        ]);

        return res.status(200).json({
            success: true,
            data: result,
            pagination: {
                currentPage: safePage,
                pageSize: safeSize,
                totalPages: Math.ceil(totalRecords / safeSize),
                totalRecords,
            },
        });
    }

    /**
     * Standard error reporter for the controller.
     */
    sendErrorResponse = (res, statusCode, message) => {
        return res.status(statusCode).json({ success: false, error: message });
    };
}

/** `"-createdAt"` -> `{ createdAt: -1 }`. */
function sortSpecFor(field) {
    const descending = field.startsWith("-");
    const key = descending ? field.slice(1) : field;
    return { [key]: descending ? -1 : 1 };
}

/** Sorting defaults to the filterable set plus whatever `orderBy` already names. */
function defaultSortable(query, orderBy) {
    const fields = [...query];
    if (orderBy && orderBy !== "none") {
        const key = orderBy.startsWith("-") ? orderBy.slice(1) : orderBy;
        if (!fields.includes(key)) fields.push(key);
    }
    return fields;
}

/**
 * Accepts both the options-object form and the legacy positional signature
 * `(model, orderBy, query, search, runAfterCreate, onGet)`.
 */
function normalizeOptions(args) {
    const [first] = args;
    const isOptionsObject =
        first && typeof first === "object" && !Array.isArray(first) && "model" in first;

    if (isOptionsObject) return first;

    const [model, orderBy, query, search, runAfterCreate, onGet] = args;
    return { model, orderBy, query, search, runAfterCreate, onGet };
}

export { ControllerSets };
