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

// Express CRUD handlers for a Mongoose model. Implicit-deny throughout: a field
// is not filterable, sortable or writable until the author names it.
//
// This class is the surface only — one method per route, each delegating to its
// module in `core/`. `getAll` and `query` retrieve through the same `core/list.js`,
// so the two routes cannot diverge in what they return or what they cost.
class ControllerSets {
    constructor(...args) {
        const config = buildConfig(normalizeOptions(args));
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
    }

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
