import mongoose from "mongoose";
import { HttpError } from "../utils/sanitize.js";

// The only bound on a query that is slow at the database rather than here.
const bounded = (query, config) => {
    if (!config.maxTimeMS) return query;
    return typeof query?.maxTimeMS === "function" ? query.maxTimeMS(config.maxTimeMS) : query;
};

// `populate` and `select` run even when empty: Mongoose treats those as no-ops,
// and skipping them would make the call sequence depend on what `onGet` returned.
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
