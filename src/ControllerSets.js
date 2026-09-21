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

/**
 * ControllerSets — Express CRUD handlers for a Mongoose model.
 *
 * The governing principle is implicit-deny: a field is not filterable, sortable,
 * or writable until the API author names it. This library generates *public*
 * endpoints, so anything left open is open to everyone.
 *
 * Each handler below is a thin composition of four steps — read the request,
 * check it against the policy, touch the database, write the envelope — and each
 * step lives in its own module under `core/`:
 *
 *   core/config.js      options in, one frozen config out
 *   core/readParams.js  request → filters, sort, page window (pure)
 *   core/search.js      search terms, including across relations
 *   core/write.js       body → payload: field policy, then your `validate` hook
 *   core/dataAccess.js  every Mongoose call, with the caps applied
 *   core/respond.js     the response envelope
 *
 * The handlers stay short on purpose: a rule that lives in one module applies to
 * every endpoint, and an endpoint added later cannot quietly skip one.
 */
class ControllerSets {
    constructor(...args) {
        const config = buildConfig(normalizeOptions(args));

        /** The resolved, frozen configuration every handler runs on. */
        this.config = config;

        // Long-standing public properties. They mirror `config` and are kept
        // because consumers have always been able to read them off an instance.
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

    /* ================================================================== *
     * Shared plumbing
     * ================================================================== */

    /**
     * Converts deliberate 4xx/415 errors into responses here rather than relying
     * on the consumer having mounted `errorHandler`. Anything else propagates:
     * Express 5 forwards rejected promises, and an unexpected failure should not
     * be flattened into a tidy 400.
     */
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

    /**
     * A page window a client cannot widen past `maxLimit`, nor push past
     * `maxPage`.
     *
     * A deep page is the one read that costs far more to serve than to ask for:
     * `?page=9999999` makes the database walk every skipped index entry before
     * returning anything. `maxPage` refuses it outright rather than clamping,
     * because quietly serving a different page than the one requested is worse
     * than saying no.
     */
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

    /**
     * The one read responder, shared by `GET /` and `QUERY /`.
     *
     * Both methods differ only in how their parameters were expressed; from here
     * down they are the same request, which is why neither can drift into
     * returning a shape — or a volume — the other would not.
     */
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

    /* ================================================================== *
     * GET / — list, filter, search, sort, paginate
     * ================================================================== */

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

    /* ================================================================== *
     * QUERY / — the same read, described by a JSON body
     * ================================================================== */

    /**
     * QUERY (RFC 10008) is safe and idempotent: GET with a body, for filters too
     * long for a URL, too structured to flatten into a query string, or too
     * sensitive to leave in proxy and access logs.
     *
     * The body is deliberately *not* a Mongo query. Field names are checked
     * against the same allowlists the query string uses, operators are spelled
     * without `$` and translated through a fixed table, and a body carrying a
     * literal `$` key fails that lookup rather than reaching the driver.
     */
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

    /* ================================================================== *
     * GET /:id — one record
     * ================================================================== */

    getById = this.#handler(async (req, res) => {
        const id = validateObjectId(req.params.id);
        const shape = await resolveReadShape(req, res, this.config);

        const document = await findOneById({ id, shape, config: this.config });
        if (!document) return failure(res, 404, "Entry not found.");

        return ok(res, document);
    });

    /* ================================================================== *
     * POST / — create
     * ================================================================== */

    /**
     * The body is filtered to the fields a client may write, handed to your
     * `validate` hook if you configured one, and only then given to Mongoose —
     * whose schema validators still run as the last line of defence.
     */
    create = this.#handler(async (req, res) => {
        const payload = await buildWritePayload("create", { req, res, config: this.config });

        const document = await insertOne({ payload, config: this.config });
        await runAfterCreateHook(document, this.config);

        return created(res, document);
    });

    /* ================================================================== *
     * PATCH /:id — partial update
     * ================================================================== */

    update = this.#handler(async (req, res) => {
        const id = validateObjectId(req.params.id);
        const payload = await buildWritePayload("update", { req, res, config: this.config });
        const shape = await resolveReadShape(req, res, this.config);

        const document = await updateOneById({ id, payload, shape, config: this.config });
        if (!document) return failure(res, 404, "Entry not found.");

        return ok(res, document);
    });

    /* ================================================================== *
     * DELETE /:id — remove
     * ================================================================== */

    delete = this.#handler(async (req, res) => {
        const id = validateObjectId(req.params.id);

        const deleted = await deleteOneById({ id, config: this.config });
        if (!deleted) return failure(res, 404, "Entry not found.");

        return okMessage(res, "Item successfully deleted.");
    });

    /* ================================================================== *
     * Public helpers, kept for handlers wired by hand
     * ================================================================== */

    /** Resolves `populate` / `select` from the `onGet` hook. */
    getPopulates = async (req, res) => resolveReadShape(req, res, this.config);

    /** One paginated read, reading its page window from the query string. */
    getPaginatedResults = async (req, res, filters, sort, populates = [], selects = "") => {
        // Not `pagingFromQueryString`: this helper paginates whether or not
        // `?page=` was sent, which is how it has always behaved.
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

    /** Standard error reporter for the controller. */
    sendErrorResponse = (res, statusCode, message) => failure(res, statusCode, message);
}

export { ControllerSets };
