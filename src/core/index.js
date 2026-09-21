// The core surface, in one place.
//
// Only code outside `core/` imports from here — `ControllerSets.js`, and any
// handler you wire by hand. Inside `core/`, modules import each other directly:
// routing every internal import through this barrel would make the dependency
// graph circular and hide which module actually depends on which.

// ---- routes: one module per endpoint ----
export { getAll } from "./getAll.js";
export { query } from "./query.js";
export { get } from "./get.js";
export { create } from "./create.js";
export { update } from "./update.js";
export { remove } from "./delete.js";

// ---- the retrieval `getAll` and `query` share ----
export { respondWithList } from "./list.js";

// ---- configuration ----
export {
    DEFAULT_MAX_LIMIT,
    DEFAULT_MAX_SEARCH_LENGTH,
    DEFAULT_PAGE_SIZE,
    buildConfig,
    defaultLogger,
    normalizeOptions,
    warnIfUnprotected,
} from "./config.js";

// ---- request → read parameters ----
export {
    MAX_SORT_KEYS,
    QUERY_BODY_KEYS,
    defaultSort,
    filtersFromBody,
    filtersFromQueryString,
    normalizeSearchTerm,
    pagingFromBody,
    pagingFromQueryString,
    parseQueryBody,
    searchTermFromQueryString,
    sortFromBody,
    sortFromQueryString,
    sortSpecFor,
} from "./readParams.js";

// ---- keyset pagination ----
export {
    decodeCursor,
    encodeCursor,
    keysetFilter,
    sortSignature,
    withKeyset,
    withTiebreaker,
} from "./cursor.js";

// ---- search ----
export { applySearchTerm, regexFor } from "./search.js";

// ---- writes ----
export { buildWritePayload, runAfterCreateHook } from "./write.js";

// ---- database access ----
export {
    deleteOneById,
    findCursorAnchor,
    findKeysetPage,
    findMany,
    findOneById,
    findPage,
    insertOne,
    resolveReadShape,
    updateOneById,
    validateObjectId,
} from "./dataAccess.js";

// ---- responses and error handling ----
export { created, failure, ok, okMessage, okPaginated } from "./respond.js";
export { handler } from "./handler.js";
