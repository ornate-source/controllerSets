import { HttpError } from "../utils/sanitize.js";
import { encodeCursor, decodeCursor, keysetFilter, withKeyset, withTiebreaker } from "./cursor.js";
import {
    findCursorAnchor,
    findKeysetPage,
    findMany,
    findPage,
    resolveReadShape,
} from "./dataAccess.js";
import { ok, okPaginated } from "./respond.js";

// The single retrieval path. `GET /` and `QUERY /` differ only in how a client
// expressed the request; once parsed they arrive here and are the same read, so
// neither can drift into returning a different shape, volume or cost.

const clampPageSize = (pageSize, config) =>
    Math.min(config.maxLimit, Math.max(1, pageSize ?? config.defaultPageSize));

// `?page=9999999` costs far more to serve than to ask for: the database walks
// every skipped index entry. Refused rather than clamped, since serving a
// different page than the one asked for is worse than saying no.
const offsetWindow = ({ page, pageSize }, config) => {
    const requested = Math.max(1, page ?? 1);

    if (config.maxPage && requested > config.maxPage) {
        throw new HttpError(
            400,
            `Page ${requested} is beyond the maximum of ${config.maxPage}. ` +
                `Narrow the filter, or page with a cursor instead.`,
        );
    }

    return { page: requested, pageSize: clampPageSize(pageSize, config) };
};

// A keyset page. The sort gains `_id` as a tiebreaker so the order is total —
// without it, documents sharing a sort value are skipped or repeated at the
// page boundary.
const readKeysetPage = async ({ filters, sort, paging, shape, config }) => {
    const ordered = withTiebreaker(sort);
    const pageSize = clampPageSize(paging.pageSize, config);

    let scoped = filters;
    if (paging.cursor) {
        const id = decodeCursor(paging.cursor, ordered);
        const anchor = await findCursorAnchor({ id, sortKeys: Object.keys(ordered), config });
        scoped = withKeyset(filters, keysetFilter(anchor, ordered));
    }

    const { documents, hasMore } = await findKeysetPage({
        filters: scoped,
        sort: ordered,
        pageSize,
        shape,
        config,
    });

    const last = documents[documents.length - 1];
    return {
        data: documents,
        pagination: {
            pageSize,
            hasMore,
            nextCursor: hasMore && last ? encodeCursor(last, ordered) : null,
        },
    };
};

/**
 * Runs one list request and writes the response.
 *
 * @param {object} params `{ filters, sort, paging, limit }` as parsed from the
 *   request — `paging` is null for an unpaginated read, or carries `mode`.
 */
export const respondWithList = async (req, res, { filters, sort, paging, limit }, config) => {
    const shape = await resolveReadShape(req, res, config);

    if (paging?.mode === "cursor") {
        return okPaginated(res, await readKeysetPage({ filters, sort, paging, shape, config }));
    }

    if (paging) {
        const window = offsetWindow(paging, config);
        return okPaginated(res, await findPage({ filters, sort, ...window, shape, config }));
    }

    return ok(res, await findMany({ filters, sort, limit, shape, config }));
};
