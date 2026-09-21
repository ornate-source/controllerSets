import mongoose from "mongoose";
import { HttpError } from "../utils/sanitize.js";

/**
 * Every call this library makes into Mongoose.
 *
 * Reads go through one place so the guarantees hold everywhere without each
 * handler remembering them: bounded result sets, an optional server-side time
 * limit, and `populate`/`select` shaped by `onGet`. A new endpoint added here
 * inherits all of it; one written against the model directly would not.
 */

/**
 * `maxTimeMS` is the only defence against a query that is slow at the database
 * rather than in this process — an unindexed sort on a large collection will
 * otherwise hold a connection for as long as it takes.
 */
const bounded = (query, config) => {
    if (!config.maxTimeMS) return query;
    return typeof query?.maxTimeMS === "function" ? query.maxTimeMS(config.maxTimeMS) : query;
};

/**
 * Applies read shaping.
 *
 * `populate` and `select` are called unconditionally, including with the empty
 * defaults, because Mongoose treats those as no-ops and skipping them would make
 * the call sequence depend on whether a hook happened to return anything.
 */
const shaped = (query, { populates = [], selects = "" }, config) => {
    const withOptions = query.populate(populates).select(selects);
    const leaned = config.lean ? withOptions.lean() : withOptions;
    return bounded(leaned, config);
};

export const validateObjectId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new HttpError(400, "Invalid ID format.");
    }
    return id;
};

/**
 * Resolves `populate` / `select` from the `onGet` hook.
 *
 * A throwing hook degrades to the safe defaults rather than failing the read: it
 * decides presentation, and presentation is not worth a 500.
 */
export const resolveReadShape = async (req, res, config) => {
    if (typeof config.onGet !== "function") return { populates: [], selects: "" };

    try {
        const result = await config.onGet(req, res);
        return { populates: result?.populates || [], selects: result?.selects || "" };
    } catch (err) {
        config.logger.error(`[ControllerSets] Error in onGet: ${err.message}`);
        return { populates: [], selects: "" };
    }
};

/** An unpaginated list. Always bounded, `legacyMode` excepted. */
export const findMany = ({ filters, sort, limit, shape, config }) => {
    const query = config.model.find(filters).sort(sort).limit(limit);
    return shaped(query, shape, config);
};

export const findOneById = ({ id, shape, config }) =>
    shaped(config.model.findById(id), shape, config);

/**
 * How many records matched, according to the configured strategy.
 *
 *   exact     — `countDocuments`, correct and the default.
 *   estimated — collection metadata, O(1), but it cannot see a filter, so a
 *               filtered read still has to count exactly.
 *   none      — no count at all; the caller learns `hasMore` instead.
 */
const countMatching = async (filters, config) => {
    if (config.countStrategy === "none") return null;

    const unfiltered = Object.keys(filters).length === 0;
    if (config.countStrategy === "estimated" && unfiltered) {
        return bounded(config.model.estimatedDocumentCount(), config);
    }

    return bounded(config.model.countDocuments(filters), config);
};

/**
 * One page, plus the totals to navigate it.
 *
 * Under `countStrategy: 'none'` one extra document is fetched instead of running
 * a second query: enough to answer "is there another page?" without ever
 * counting a collection.
 */
export const findPage = async ({ filters, sort, page, pageSize, shape, config }) => {
    const skip = (page - 1) * pageSize;
    const probing = config.countStrategy === "none";
    const fetchSize = probing ? pageSize + 1 : pageSize;

    const query = config.model.find(filters).skip(skip).limit(fetchSize).sort(sort);

    const [totalRecords, documents] = await Promise.all([
        countMatching(filters, config),
        shaped(query, shape, config),
    ]);

    if (probing) {
        const hasMore = documents.length > pageSize;
        return {
            data: hasMore ? documents.slice(0, pageSize) : documents,
            pagination: { currentPage: page, pageSize, hasMore },
        };
    }

    return {
        data: documents,
        pagination: {
            currentPage: page,
            pageSize,
            totalPages: Math.ceil(totalRecords / pageSize),
            totalRecords,
        },
    };
};

export const insertOne = ({ payload, config }) => config.model.create(payload);

/**
 * A single atomic update, rather than read-then-write, so two simultaneous
 * updates cannot clobber each other in the gap. Schema validators run with
 * `context: "query"`, which is what makes custom validators using `this` behave.
 */
export const updateOneById = ({ id, payload, shape, config }) => {
    const query = config.model.findByIdAndUpdate(
        id,
        { $set: payload },
        { returnDocument: "after", runValidators: true, context: "query" },
    );
    return shaped(query, shape, config);
};

export const deleteOneById = ({ id, config }) =>
    bounded(config.model.findByIdAndDelete(id), config);
