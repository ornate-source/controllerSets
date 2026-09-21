import {
    filtersFromBody,
    normalizeSearchTerm,
    pagingFromBody,
    parseQueryBody,
    sortFromBody,
} from "./readParams.js";
import { applySearchTerm } from "./search.js";
import { handler } from "./handler.js";
import { respondWithList } from "./list.js";

// QUERY / (RFC 10008) — GET with a body: safe, idempotent, same allowlists, and
// the same `list.js` retrieval. Only the parsing differs from `getAll`.
export const query = handler(async (req, res, config) => {
    const body = parseQueryBody(req, config);

    const filters = filtersFromBody(body.filter, config);
    await applySearchTerm(filters, normalizeSearchTerm(body.search, config), config);

    return respondWithList(
        req,
        res,
        {
            filters,
            sort: sortFromBody(body.sort, config),
            paging: pagingFromBody(body, config),
            limit: Math.min(config.maxLimit, body.limit ?? config.maxLimit),
        },
        config,
    );
});
