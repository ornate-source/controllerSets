import {
    filtersFromQueryString,
    pagingFromQueryString,
    searchTermFromQueryString,
    sortFromQueryString,
} from "./readParams.js";
import { applySearchTerm } from "./search.js";
import { handler } from "./handler.js";
import { respondWithList } from "./list.js";

// GET / — the query string describes the read; `list.js` performs it.
export const getAll = handler(async (req, res, config) => {
    const filters = filtersFromQueryString(req.query, config);
    await applySearchTerm(filters, searchTermFromQueryString(req.query, config), config);

    return respondWithList(
        req,
        res,
        {
            filters,
            sort: sortFromQueryString(req.query, config),
            paging: pagingFromQueryString(req.query, config),
            // `legacyMode` restores 2.x's unbounded read; everything else is capped.
            limit: config.legacyMode ? 0 : config.maxLimit,
        },
        config,
    );
});
