import { resolveFieldPolicy } from "../utils/sanitize.js";
import { sortSpecFor } from "./readParams.js";

/**
 * Option normalization.
 *
 * Every option is read exactly once, here, and frozen into a plain config object
 * that the rest of the pipeline treats as read-only. The handlers therefore never
 * ask "what did the author configure?" mid-request — they are handed the answer.
 */

export const DEFAULT_MAX_LIMIT = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MAX_SEARCH_LENGTH = 128;

/** How a paginated read learns how many records matched. */
const COUNT_STRATEGIES = ["exact", "estimated", "none"];

export const defaultLogger = {
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: () => {},
};

/** Models already warned about, so an unconfigured policy logs once rather than per instance. */
const policyWarned = new Set();

/**
 * Accepts both the options-object form and the legacy positional signature
 * `(model, orderBy, query, search, runAfterCreate, onGet)`.
 */
export function normalizeOptions(args) {
    const [first] = args;
    const isOptionsObject =
        first && typeof first === "object" && !Array.isArray(first) && "model" in first;

    if (isOptionsObject) return first;

    const [model, orderBy, query, search, runAfterCreate, onGet] = args;
    return { model, orderBy, query, search, runAfterCreate, onGet };
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

/** A hook accepted either as one function for both verbs, or one per verb. */
function perVerbHook(option, verb) {
    if (typeof option === "function") return option;
    if (option && typeof option === "object" && typeof option[verb] === "function") {
        return option[verb];
    }
    return null;
}

function positiveIntOption(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** `maxPage` is off unless asked for, so `null` is a legitimate resolved value. */

/**
 * Turns raw options into the frozen config the pipeline runs on.
 *
 * Allowlists are kept as both the array the author gave (still readable on the
 * instance, since consumers have always been able to inspect it) and a `Set` for
 * the membership tests, which happen once per field per request.
 */
export function buildConfig(options) {
    if (!options.model) {
        throw new Error("ControllerSets: Mongoose model is required.");
    }

    const orderBy = options.orderBy ?? "none";
    const query = Array.isArray(options.query) ? options.query : [];
    const filterableFields = options.filterableFields ?? query;
    const sortableFields = options.sortableFields ?? defaultSortable(query, orderBy);

    const countStrategy = COUNT_STRATEGIES.includes(options.countStrategy)
        ? options.countStrategy
        : "exact";

    const maxTimeMS = Number.isInteger(options.maxTimeMS) && options.maxTimeMS > 0
        ? options.maxTimeMS
        : null;

    return Object.freeze({
        model: options.model,
        logger: options.logger ?? defaultLogger,
        legacyMode: options.legacyMode === true,

        // ---- reading ----
        orderBy,
        query,
        filterableFields,
        sortableFields,
        filterable: new Set(filterableFields),
        sortable: new Set(sortableFields),
        search: options.search ?? [],
        defaultSort: orderBy && orderBy !== "none" ? Object.freeze(sortSpecFor(orderBy)) : null,
        maxLimit: positiveIntOption(options.maxLimit, DEFAULT_MAX_LIMIT),
        maxPage: positiveIntOption(options.maxPage, null),
        defaultPageSize: positiveIntOption(options.defaultPageSize, DEFAULT_PAGE_SIZE),
        maxSearchLength: positiveIntOption(options.maxSearchLength, DEFAULT_MAX_SEARCH_LENGTH),
        allowRawRegex: options.allowRawRegex === true,
        lean: options.lean === true,
        maxTimeMS,
        countStrategy,
        onGet: options.onGet ?? "none",

        // ---- writing ----
        fieldPolicy: resolveFieldPolicy(options.allowedFields, options.blockedFields),
        validators: Object.freeze({
            create: perVerbHook(options.validate, "create"),
            update: perVerbHook(options.validate, "update"),
        }),
        runAfterCreate: options.runAfterCreate ?? "none",
        strictAfterCreate: options.strictAfterCreate === true,
    });
}

/**
 * Mass assignment is silent and total when unconfigured, and consumers upgrading
 * from 2.x will not read a changelog. The console will reach them.
 */
export function warnIfUnprotected(config) {
    if (config.legacyMode || config.fieldPolicy.configured) return;

    const name = config.model?.modelName ?? "<model>";
    if (policyWarned.has(name)) return;
    policyWarned.add(name);

    config.logger.warn(
        `[ControllerSets] '${name}' has no allowedFields/blockedFields configured. ` +
            `Every schema-defined field is client-writable via POST and PATCH, ` +
            `including fields like 'role' or 'isAdmin'. See MIGRATION.md.`,
    );
}
