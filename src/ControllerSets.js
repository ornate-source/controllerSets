import {
    buildConfig,
    create,
    failure,
    findPage,
    get,
    getAll,
    normalizeOptions,
    okPaginated,
    query,
    remove,
    resolveReadShape,
    update,
    warnIfUnprotected,
} from "./core/index.js";
import { resolveCache } from "./cache/index.js";

// Express CRUD handlers for a Mongoose model. Implicit-deny throughout: a field
// is not filterable, sortable or writable until the author names it.

class ControllerSets {
    constructor(...args) {
        const options = normalizeOptions(args);
        const config = buildConfig(options);
        this.config = config;

        // Mirrored from `config`: consumers have always read these off an instance.
        this.model = config.model;
        this.orderBy = config.orderBy;
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

        // Opt-in response cache. The handlers below are class fields, so they
        // exist by now and are wrapped in place: reads go through the cache,
        // successful writes invalidate it.
        const cache = resolveCache(options.cache, config);
        this.cache = cache;
        if (cache) {
            this.getAll = cache.read("list", this.getAll);
            this.query = cache.read("query", this.query);
            this.get = cache.read("one", this.get);
            this.getById = this.get;
            this.queryAll = this.query;
            this.create = cache.write(this.create);
            this.update = cache.write(this.update);
            this.delete = cache.write(this.delete);
        }
    }

    /**
     * Drops every cached response for this model — call it after changing
     * records outside these handlers. Resolves (quietly) when caching is off.
     */
    invalidateCache = async () => {
        if (this.cache) await this.cache.invalidate();
    };

    /** GET / */
    getAll = (req, res) => getAll(req, res, this.config);

    /** QUERY / */
    query = (req, res) => query(req, res, this.config);

    /** GET /:id */
    get = (req, res) => get(req, res, this.config);

    /** POST / */
    create = (req, res) => create(req, res, this.config);

    /** PATCH /:id */
    update = (req, res) => update(req, res, this.config);

    /** DELETE /:id */
    delete = (req, res) => remove(req, res, this.config);

    /** @deprecated Renamed to `get`. */
    getById = (req, res) => get(req, res, this.config);

    /** @deprecated Renamed to `query`. */
    queryAll = (req, res) => query(req, res, this.config);

    /** Resolves `populate` / `select` from the `onGet` hook. */
    getPopulates = (req, res) => resolveReadShape(req, res, this.config);

    /** One offset-paginated read, for handlers wired by hand. */
    getPaginatedResults = async (
        req,
        res,
        filters,
        sort,
        populates = [],
        selects = "",
    ) => {
        const page = await findPage({
            filters,
            sort,
            page: Math.max(1, parseInt(req.query.page, 10) || 1),
            pageSize: Math.min(
                this.config.maxLimit,
                Math.max(
                    1,
                    parseInt(req.query.pageSize, 10) ||
                        this.config.defaultPageSize,
                ),
            ),
            shape: { populates, selects },
            config: this.config,
        });
        return okPaginated(res, page);
    };

    /** Standard error reporter for the controller. */
    sendErrorResponse = (res, statusCode, message) =>
        failure(res, statusCode, message);
}

export { ControllerSets };
