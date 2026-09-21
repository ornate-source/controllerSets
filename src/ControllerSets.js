import { HttpError } from "./utils/sanitize.js";
import { buildConfig, normalizeOptions, warnIfUnprotected } from "./core/config.js";
import {
    filtersFromBody,
    filtersFromQueryString,
    pagingFromBody,
    pagingFromQueryString,
    parseQueryBody,
    searchTermFromQueryString,
    normalizeSearchTerm,
    sortFromBody,
    sortFromQueryString,
} from "./core/readParams.js";
import { applySearchTerm } from "./core/search.js";
import { buildWritePayload, runAfterCreateHook } from "./core/write.js";
import {
    deleteOneById,
    findMany,
    findOneById,
    findPage,
    insertOne,
    resolveReadShape,
    updateOneById,
    validateObjectId,
} from "./core/dataAccess.js";
import { created, failure, ok, okMessage, okPaginated } from "./core/respond.js";

// Express CRUD handlers for a Mongoose model. Implicit-deny throughout: a field
// is not filterable, sortable or writable until the author names it.
//
// Each handler composes the modules under `core/` — config, readParams, search,
// write, dataAccess, respond — so a rule lives in one place and no endpoint can
// skip it.
class ControllerSets {
    constructor(...args) {
        const config = buildConfig(normalizeOptions(args));

        this.config = config;

        // Mirrored from `config`: consumers have always read these off an instance.
        this.model = config.model;
        this.orderBy = config.orderBy;
        this.query = config.query;
        this.search = config.search;
        this.runAfterCreate = config.runAfterCreate;
        this.onGet = config.onGet;
        this.legacyMode = config.legacyMode;
        this.logger = config.logger;
        this.fieldPolicy = config.fieldPolicy;
        this.filterableFields = config.filterableFields;
        this.sortableFields = config.sortableFields;
        this.maxLimit = config.maxLimit;
        this.maxSearchLength = config.maxSearchLength;
        this.allowRawRegex = config.allowRawRegex;
        this.lean = config.lean;
        this.strictAfterCreate = config.strictAfterCreate;

        warnIfUnprotected(config);
    }

    // Deliberate 4xx/415s answered here, so they work without `errorHandler`
    // mounted. Anything unexpected propagates rather than becoming a tidy 400.
    #handler(run) {
        return async (req, res) => {
            try {
                return await run(req, res);
            } catch (err) {
                if (!(err instanceof HttpError)) throw err;
                if (res.headersSent) throw err;

                for (const [name, value] of Object.entries(err.headers ?? {})) {
                    res.setHeader(name, value);
                }
                return failure(res, err.status, err.message, err.fields);
            }
        };
    }

    // `?page=9999999` costs far more to serve than to ask for: the database walks
    // every skipped index entry. Refused rather than clamped, since serving a
    // different page than the one asked for is worse than saying no.
    #pageWindow({ page, pageSize }) {
        const requested = Math.max(1, page ?? 1);

        if (this.config.maxPage && requested > this.config.maxPage) {
            throw new HttpError(
                400,
                `Page ${requested} is beyond the maximum of ${this.config.maxPage}. ` +
                    `Narrow the filter instead of paging deeper.`,
            );
        }

        return {
            page: requested,
            pageSize: Math.min(
                this.config.maxLimit,
                Math.max(1, pageSize ?? this.config.defaultPageSize),
            ),
        };
    }

    async #respondWithList(req, res, { filters, sort, paging, limit }) {
        const shape = await resolveReadShape(req, res, this.config);

        if (paging) {
            const window = this.#pageWindow(paging);
            const page = await findPage({ filters, sort, ...window, shape, config: this.config });
            return okPaginated(res, page);
        }

        const documents = await findMany({ filters, sort, limit, shape, config: this.config });
        return ok(res, documents);
    }

    // ---- GET / — list, filter, search, sort, paginate ----

    getAll = this.#handler(async (req, res) => {
        const config = this.config;

        const filters = filtersFromQueryString(req.query, config);
        await applySearchTerm(filters, searchTermFromQueryString(req.query, config), config);

        return this.#respondWithList(req, res, {
            filters,
            sort: sortFromQueryString(req.query, config),
            paging: pagingFromQueryString(req.query, config),
            // `legacyMode` restores 2.x's unbounded read; everything else is capped.
            limit: config.legacyMode ? 0 : config.maxLimit,
        });
    });

    // ---- QUERY / — the same read, described by a JSON body ----

    // QUERY (RFC 10008) is GET with a body: safe, idempotent, same allowlists.
    // The body is not a Mongo query — operators are spelled without `$`.
    queryAll = this.#handler(async (req, res) => {
        const config = this.config;
        const body = parseQueryBody(req, config);

        const filters = filtersFromBody(body.filter, config);
        await applySearchTerm(filters, normalizeSearchTerm(body.search, config), config);

        return this.#respondWithList(req, res, {
            filters,
            sort: sortFromBody(body.sort, config),
            paging: pagingFromBody(body, config),
            limit: Math.min(config.maxLimit, body.limit ?? config.maxLimit),
        });
    });

    // ---- GET /:id ----

    getById = this.#handler(async (req, res) => {
        const id = validateObjectId(req.params.id);
        const shape = await resolveReadShape(req, res, this.config);

        const document = await findOneById({ id, shape, config: this.config });
        if (!document) return failure(res, 404, "Entry not found.");

        return ok(res, document);
    });

    // ---- POST / ----

    create = this.#handler(async (req, res) => {
        const payload = await buildWritePayload("create", { req, res, config: this.config });

        const document = await insertOne({ payload, config: this.config });
        await runAfterCreateHook(document, this.config);

        return created(res, document);
    });

    // ---- PATCH /:id ----

    update = this.#handler(async (req, res) => {
        const id = validateObjectId(req.params.id);
        const payload = await buildWritePayload("update", { req, res, config: this.config });
        const shape = await resolveReadShape(req, res, this.config);

        const document = await updateOneById({ id, payload, shape, config: this.config });
        if (!document) return failure(res, 404, "Entry not found.");

        return ok(res, document);
    });

    // ---- DELETE /:id ----

    delete = this.#handler(async (req, res) => {
        const id = validateObjectId(req.params.id);

        const deleted = await deleteOneById({ id, config: this.config });
        if (!deleted) return failure(res, 404, "Entry not found.");

        return okMessage(res, "Item successfully deleted.");
    });

    getPopulates = async (req, res) => resolveReadShape(req, res, this.config);

    getPaginatedResults = async (req, res, filters, sort, populates = [], selects = "") => {
        // Not `pagingFromQueryString`: this helper paginates with or without `?page=`.
        const window = this.#pageWindow({
            page: parseInt(req.query.page, 10) || 1,
            pageSize: parseInt(req.query.pageSize, 10) || this.config.defaultPageSize,
        });
        const page = await findPage({
            filters,
            sort,
            ...window,
            shape: { populates, selects },
            config: this.config,
        });
        return okPaginated(res, page);
    };

    sendErrorResponse = (res, statusCode, message) => failure(res, statusCode, message);
}

export { ControllerSets };
