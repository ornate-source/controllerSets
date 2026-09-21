import { HttpError } from "../utils/sanitize.js";

// Keyset ("seek") pagination. `skip(n)` makes the server walk n index entries
// before returning anything, so page 1,000,000 of a billion-document collection
// costs a billion steps. A keyset page instead asks "everything after this
// document", which is one index seek whatever the page number.
//
// The cursor carries only the anchor document's `_id`, never the sort values.
// The server re-reads that document to learn them, so a client cannot craft a
// cursor that filters on a field it was never allowed to filter on.

/** `{ price: -1, _id: 1 }` -> `"-price,_id"`. */
export const sortSignature = (sort) =>
    Object.entries(sort)
        .map(([key, direction]) => `${direction < 0 ? "-" : ""}${key}`)
        .join(",");

// A keyset page needs a total order, or documents sharing a sort value would be
// skipped or repeated at the boundary. `_id` is unique, so it settles every tie.
export const withTiebreaker = (sort) => {
    if (Object.hasOwn(sort, "_id")) return sort;
    const directions = Object.values(sort);
    const last = directions.length > 0 ? directions[directions.length - 1] : 1;
    return { ...sort, _id: last };
};

export const encodeCursor = (document, sort) => {
    const id = document?._id;
    if (id === undefined || id === null) return null;

    const payload = JSON.stringify({ i: String(id), s: sortSignature(sort) });
    return Buffer.from(payload, "utf8").toString("base64url");
};

/** Returns the anchor id, or throws if the token is malformed or from another sort. */
export const decodeCursor = (token, sort) => {
    if (typeof token !== "string" || token === "") {
        throw new HttpError(400, "Cursor must be a non-empty string.");
    }

    let payload;
    try {
        payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    } catch {
        throw new HttpError(400, "Cursor is not a valid pagination token.");
    }

    if (!payload || typeof payload.i !== "string" || typeof payload.s !== "string") {
        throw new HttpError(400, "Cursor is not a valid pagination token.");
    }

    // Continuing a scan under a different sort would silently skip or repeat
    // records, so the order the cursor was issued for has to match.
    if (payload.s !== sortSignature(sort)) {
        throw new HttpError(400, "Cursor was issued for a different sort order.");
    }

    return payload.i;
};

// Everything ordered after the anchor. For `{ a: 1, _id: 1 }`:
//   a > va  OR  (a = va AND _id > vid)
export const keysetFilter = (anchor, sort) => {
    const clauses = [];
    const equalities = {};

    for (const [key, direction] of Object.entries(sort)) {
        const operator = direction < 0 ? "$lt" : "$gt";
        const value = anchor[key] ?? null;

        clauses.push({ ...equalities, [key]: { [operator]: value } });
        equalities[key] = value;
    }

    return clauses.length === 1 ? clauses[0] : { $or: clauses };
};

/** ANDs the keyset clause onto the request's filters without disturbing an existing `$or`. */
export const withKeyset = (filters, keyset) => {
    if (!keyset) return filters;
    if (Object.keys(filters).length === 0) return keyset;
    return { $and: [filters, keyset] };
};
