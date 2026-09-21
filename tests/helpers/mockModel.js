/**
 * A chainable, thenable Mongoose-model double.
 *
 * The previous hand-rolled mocks resolved only via `.lean()` and ignored `$set`
 * semantics, so they could not observe the filter object actually handed to
 * MongoDB — which is precisely what an injection test needs to assert on.
 * This records every query the controller builds.
 */

const matchValue = (actual, expected) => {
    if (expected === null || typeof expected !== "object" || expected instanceof Date) {
        return actual === expected;
    }

    for (const [op, operand] of Object.entries(expected)) {
        switch (op) {
            case "$gt":
                if (!(actual > operand)) return false;
                break;
            case "$gte":
                if (!(actual >= operand)) return false;
                break;
            case "$lt":
                if (!(actual < operand)) return false;
                break;
            case "$lte":
                if (!(actual <= operand)) return false;
                break;
            case "$ne":
                if (actual === operand) return false;
                break;
            case "$eq":
                if (actual !== operand) return false;
                break;
            case "$in":
                if (!operand.some((item) => String(item) === String(actual))) return false;
                break;
            case "$nin":
                if (operand.some((item) => String(item) === String(actual))) return false;
                break;
            case "$regex":
                if (!new RegExp(operand, expected.$options ?? "").test(String(actual ?? "")))
                    return false;
                break;
            case "$options":
                break;
            default:
                return false;
        }
    }
    return true;
};

const matchDocument = (doc, filters) => {
    for (const [key, expected] of Object.entries(filters)) {
        if (key === "$or") {
            if (!expected.some((clause) => matchDocument(doc, clause))) return false;
            continue;
        }
        if (!matchValue(doc[key], expected)) return false;
    }
    return true;
};

const applySort = (docs, sort) => {
    if (!sort || Object.keys(sort).length === 0) return docs;
    const [key, direction] = Object.entries(sort)[0];
    return [...docs].sort((a, b) => {
        if (a[key] === b[key]) return 0;
        return (a[key] > b[key] ? 1 : -1) * direction;
    });
};

export const createMockModel = ({ modelName = "Mock", refPaths = {} } = {}) => {
    const store = new Map();
    let idCounter = 1;

    const calls = {
        lastFilters: null,
        lastSort: null,
        lastLimit: null,
        lastPopulate: null,
        lastSelect: null,
        lastLean: false,
        lastUpdate: null,
    };

    const makeQuery = (resolver) => {
        const state = { sort: null, skip: 0, limit: 0, lean: false };
        const query = {
            sort(value) {
                state.sort = value;
                calls.lastSort = value;
                return query;
            },
            skip(value) {
                state.skip = value;
                return query;
            },
            limit(value) {
                state.limit = value;
                calls.lastLimit = value;
                return query;
            },
            populate(value) {
                calls.lastPopulate = value;
                return query;
            },
            select(value) {
                calls.lastSelect = value;
                return query;
            },
            lean() {
                state.lean = true;
                calls.lastLean = true;
                return query;
            },
            then(resolve, reject) {
                return Promise.resolve()
                    .then(() => resolver(state))
                    .then(resolve, reject);
            },
        };
        return query;
    };

    const model = {
        modelName,
        calls,
        store,

        schema: {
            path: (field) =>
                refPaths[field] ? { options: { ref: refPaths[field] } } : null,
        },

        seed(docs) {
            for (const doc of docs) store.set(String(doc._id), doc);
            return model;
        },

        find(filters = {}) {
            calls.lastFilters = filters;
            return makeQuery((state) => {
                let docs = [...store.values()].filter((doc) => matchDocument(doc, filters));
                docs = applySort(docs, state.sort);
                if (state.skip) docs = docs.slice(state.skip);
                // Mongoose treats limit(0) as unbounded.
                if (state.limit) docs = docs.slice(0, state.limit);
                return docs;
            });
        },

        findById(id) {
            return makeQuery(() => store.get(String(id)) ?? null);
        },

        create(body) {
            if (body?.name === "TRIGGER_ERROR") {
                const err = new Error("Validation failed");
                err.name = "ValidationError";
                err.errors = { name: { message: "Name is required" } };
                return Promise.reject(err);
            }
            if (body?.name === "TRIGGER_DUPLICATE") {
                const err = new Error("E11000 duplicate key error collection: db.items");
                err.code = 11000;
                err.keyPattern = { name: 1 };
                return Promise.reject(err);
            }
            const id = String(idCounter++).padStart(24, "0");
            const doc = { _id: id, ...body };
            store.set(id, doc);
            return Promise.resolve(doc);
        },

        findByIdAndUpdate(id, update) {
            calls.lastUpdate = update;
            return makeQuery(() => {
                const existing = store.get(String(id));
                if (!existing) return null;
                const updated = { ...existing, ...(update.$set ?? {}) };
                store.set(String(id), updated);
                return updated;
            });
        },

        findByIdAndDelete(id) {
            const existing = store.get(String(id));
            store.delete(String(id));
            return Promise.resolve(existing ?? null);
        },

        countDocuments(filters = {}) {
            return Promise.resolve(
                [...store.values()].filter((doc) => matchDocument(doc, filters)).length,
            );
        },
    };

    return model;
};

/** Valid 24-hex ObjectId strings, so ID validation is exercised rather than bypassed. */
export const objectId = (n) => String(n).padStart(24, "0");

/** Boots an app on an ephemeral port and tears it down around a single test body. */
export const withServer = async (app, run) => {
    const server = app.listen(0);
    try {
        await run(`http://localhost:${server.address().port}`);
    } finally {
        server.close();
    }
};
