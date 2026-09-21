import mongoose from "mongoose";
import { escapeRegex } from "../utils/sanitize.js";

// Escaped by default: an unescaped term is a pattern the client authored and
// mongod executes.
export const regexFor = (term, config) => {
    const value = config.allowRawRegex || config.legacyMode ? String(term) : escapeRegex(term);
    return { $regex: value, $options: "i" };
};

// A dotted field is a relation: the referenced collection is searched first and
// its ids become an `$in`. Splitting on the first separator only means
// `author.profile.name` targets `profile.name` on the referenced model.
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
        // Capped: the `$in` this builds grows with the referenced collection, not
        // with the page, so an uncapped match is the one clause that gets slower
        // as the data grows. Beyond the cap the search narrows rather than stalls.
        const matched = await refModel
            .find({ [childPath]: regexFor(term, config) })
            .select("_id")
            .limit(config.maxRelationMatches)
            .lean();

        if (matched.length === 0) return null;

        if (matched.length === config.maxRelationMatches) {
            config.logger.warn(
                `[ControllerSets] Relational search on '${field}' hit the ` +
                    `${config.maxRelationMatches}-match cap; results are partial. ` +
                    `Raise 'maxRelationMatches' or search a narrower term.`,
            );
        }

        return { [relation]: { $in: matched.map((doc) => doc._id) } };
    } catch (err) {
        config.logger.error(
            `[ControllerSets] Failed to resolve relational search for '${field}': ${err.message}`,
        );
        return null;
    }
};

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
