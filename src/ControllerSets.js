import mongoose from "mongoose";
import {
    HttpError,
    escapeRegex,
    pickWritable,
    resolveFieldPolicy,
    sanitizeFilterValue,
} from "./utils/sanitize.js";

const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_MAX_SEARCH_LENGTH = 128;

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

    #searchTermFrom(req) {
        const term = req.query.s ?? req.query.search;
        if (term === undefined || term === null || term === "") return null;
        if (typeof term !== "string") {
            throw new HttpError(400, "Search term must be a string.");
        }
        if (term.length > this.maxSearchLength) {
            throw new HttpError(400, `Search term exceeds ${this.maxSearchLength} characters.`);
        }
        return term;
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

    async #applySearch(filters, req) {
        const term = this.#searchTermFrom(req);
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

    #buildSort(req) {
        const active = req.query.sort || this.orderBy;
        if (!active || active === "none") return {};

        const descending = active.startsWith("-");
        const key = descending ? active.slice(1) : active;

        // A configured `orderBy` is the author's own choice and is always permitted;
        // only a client-supplied `?sort=` is checked against the allowlist.
        if (req.query.sort) {
            this.#assertAllowed(key, this.sortableFields, "sortable");
        }

        return { [key]: descending ? -1 : 1 };
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
        await this.#applySearch(filters, req);
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
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(
            this.maxLimit,
            Math.max(1, parseInt(req.query.pageSize) || 50),
        );
        const skip = (page - 1) * pageSize;

        const query = this.model.find(filters).skip(skip).limit(pageSize).sort(sort);

        const [totalRecords, result] = await Promise.all([
            this.model.countDocuments(filters),
            this.#applyReadOptions(query, populates, selects),
        ]);

        return res.status(200).json({
            success: true,
            data: result,
            pagination: {
                currentPage: page,
                pageSize,
                totalPages: Math.ceil(totalRecords / pageSize),
                totalRecords,
            },
        });
    };

    /**
     * Standard error reporter for the controller.
     */
    sendErrorResponse = (res, statusCode, message) => {
        return res.status(statusCode).json({ success: false, error: message });
    };
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
