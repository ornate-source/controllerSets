import mongoose from "mongoose";
import { escapeRegex } from "../utils/sanitize.js";

/**
 * Text search across configured fields, including fields on referenced models.
 */

/**
 * Builds the `$regex` clause for a search term.
 *
 * Escaped by default: an unescaped term is a pattern the client authored and
 * mongod executes. Raw regex remains available for trusted callers via
 * `allowRawRegex`, but it must be a decision, not a default.
 */
export const regexFor = (term, config) => {
    const value = config.allowRawRegex || config.legacyMode ? String(term) : escapeRegex(term);
    return { $regex: value, $options: "i" };
};

/**
 * One clause per configured search field.
 *
 * A dotted field is a relation: the referenced collection is searched first and
 * the matching ids become an `$in` on the parent. Splitting on the *first*
 * separator only means `author.profile.name` targets the nested path
 * `profile.name` on the referenced model, not `profile`.
 */
const clauseFor = async (field, term, config) => {
    const dot = field.indexOf(".");
    if (dot === -1) return { [field]: regexFor(term, config) };

    const relation = field.slice(0, dot);
    const childPath = field.slice(dot + 1);

    const schemaPath = config.model.schema?.path?.(relation);
    const refName = schemaPath?.options?.ref;
    if (!refName) return null;

    try {
        const refModel = mongoose.model(refName);
        const matched = await refModel
            .find({ [childPath]: regexFor(term, config) })
            .select("_id")
            .lean();

        return matched.length > 0
            ? { [relation]: { $in: matched.map((doc) => doc._id) } }
            : null;
    } catch (err) {
        config.logger.error(
            `[ControllerSets] Failed to resolve relational search for '${field}': ${err.message}`,
        );
        return null;
    }
};

/**
 * Applies a search term to a filter document, in place.
 *
 * Shared by every read, so `?s=` and a QUERY body's `search` cannot diverge in
 * how they escape, how deep they resolve, or what they do when nothing matches.
 */
export const applySearchTerm = async (filters, term, config) => {
    if (!term) return filters;

    const fields = config.search;

    if (!Array.isArray(fields)) {
        if (fields && fields !== "none") {
            filters[fields] = regexFor(term, config);
        }
        return filters;
    }

    if (fields.length === 0) return filters;

    const clauses = await Promise.all(fields.map((field) => clauseFor(field, term, config)));
    const valid = clauses.filter(Boolean);

    // No matching relation means no results — not "ignore the search term".
    filters.$or = valid.length > 0 ? valid : [{ _id: null }];
    return filters;
};
