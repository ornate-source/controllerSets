import mongoose from "mongoose";
import { HttpError } from "../utils/sanitize.js";

// The only bound on a query that is slow at the database rather than here.
const bounded = (query, config) => {
    if (!config.maxTimeMS) return query;
    return typeof query?.maxTimeMS === "function" ? query.maxTimeMS(config.maxTimeMS) : query;
};

// Applied only when configured, and only when the driver exposes them, so a
// custom model double is never handed a method it does not implement.
const tuned = (query, config) => {
    let shapedQuery = query;
    // Sorts above 100MB fail outright without this; on a large collection that
    // is the difference between a slow page and no page.
    if (config.allowDiskUse && typeof shapedQuery.allowDiskUse === "function") {
        shapedQuery = shapedQuery.allowDiskUse(true);
    }
    if (config.batchSize && typeof shapedQuery.batchSize === "function") {
        shapedQuery = shapedQuery.batchSize(config.batchSize);
    }
    return bounded(shapedQuery, config);
};

// `populate` and `select` run even when empty: Mongoose treats those as no-ops,
// and skipping them would make the call sequence depend on what `onGet` returned.
const shaped = (query, { populates = [], selects = "" }, config) => {
    const withOptions = query.populate(populates).select(selects);
    return tuned(config.lean ? withOptions.lean() : withOptions, config);
};

export const validateObjectId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new HttpError(400, "Invalid ID format.");
    }
    return id;
};

export const resolveReadShape = async (req, res, config) => {
    if (typeof config.onGet !== "function") return { populates: [], selects: "" };

    try {
        const result = await config.onGet(req, res);
        return { populates: result?.populates || [], selects: result?.selects || "" };
    } catch (err) {
        // Presentation is not worth a 500.
        config.logger.error(`[ControllerSets] Error in onGet: ${err.message}`);
        return { populates: [], selects: "" };
    }
};

export const findMany = ({ filters, sort, limit, shape, config }) => {
    const query = config.model.find(filters).sort(sort).limit(limit);
    return shaped(query, shape, config);
};

export const findOneById = ({ id, shape, config }) =>
    shaped(config.model.findById(id), shape, config);

// `estimated` reads collection metadata in O(1) but is blind to filters, so a
// filtered page still counts exactly.
const countMatching = async (filters, config) => {
    if (config.countStrategy === "none") return null;

    const unfiltered = Object.keys(filters).length === 0;
    if (config.countStrategy === "estimated" && unfiltered) {
        return bounded(config.model.estimatedDocumentCount(), config);
    }

    return bounded(config.model.countDocuments(filters), config);
};

// Under `countStrategy: 'none'` one extra document is fetched in place of the
// count query — enough to answer "is there another page?".
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

// The anchor a cursor points at, read back for its sort values. One primary-key
// lookup, which is what lets the cursor itself stay tamper-proof.
export const findCursorAnchor = async ({ id, sortKeys, config }) => {
    const projection = Object.fromEntries(sortKeys.map((key) => [key, 1]));
    const anchor = await bounded(
        config.model.findById(id).select(projection).lean(),
        config,
    );

    if (!anchor) {
        throw new HttpError(
            400,
            "The record this cursor points at no longer exists. Start the scan again.",
        );
    }
    return anchor;
};

// One keyset page. No `skip` and no count, so the cost is the same on page one
// and page one million.
export const findKeysetPage = async ({ filters, sort, pageSize, shape, config }) => {
    const query = config.model.find(filters).sort(sort).limit(pageSize + 1);
    const documents = await shaped(query, shape, config);

    const hasMore = documents.length > pageSize;
    return { documents: hasMore ? documents.slice(0, pageSize) : documents, hasMore };
};

export const insertOne = ({ payload, config }) => config.model.create(payload);

// Atomic, so two simultaneous updates cannot clobber each other in the gap.
// `context: "query"` is what makes schema validators using `this` work.
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
