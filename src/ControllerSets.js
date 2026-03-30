import mongoose from "mongoose";

/**
 * ControllerSets - Professional Express logic for Mongoose CRUD.
 * Standardizes responses, handles pagination, and provides robust error catching.
 */
class ControllerSets {
    constructor(
        model,
        orderBy = "none",
        query = [],
        search = [],
        runAfterCreate = "none"
    ) {
        if (!model) {
            throw new Error("ControllerSets: Mongoose model is required.");
        }
        this.model = model;
        this.orderBy = orderBy;
        this.query = query;
        this.search = search;
        this.runAfterCreate = runAfterCreate;
    }

    /**
     * Internal utility to fetch an object and handle basic validation.
     */
    getObjectById = async (req, res) => {
        const { id } = req.params;
        const isValidId = mongoose.Types.ObjectId.isValid(id);

        if (!isValidId) {
            this.sendErrorResponse(res, 400, "Invalid ID format.");
            return null;
        }

        const object = await this.model.findById(id);
        if (!object) {
            this.sendErrorResponse(res, 404, "Entry not found.");
            return null;
        }
        return object;
    };

    /**
     * GET / - Retrieves list of records with filtering, searching, and pagination.
     */
    getAll = async (req, res) => {
        let filters = this.query.reduce((acc, queryKey) => {
            if (req.query[queryKey] !== undefined) {
                acc[queryKey] = req.query[queryKey];
            }
            return acc;
        }, {});

        const searchTerm = req.query.s || req.query.search;

        if (Array.isArray(this.search) && this.search.length > 0 && searchTerm) {
            const searchPromises = this.search.map(async (field) => {
                if (field.includes(".")) {
                    const [relation, childField] = field.split(".");
                    const schemaPath = this.model.schema.path(relation);
                    if (schemaPath?.options?.ref) {
                        const refModelName = schemaPath.options.ref;
                        try {
                            const refModel = mongoose.model(refModelName);
                            const matchedDocs = await refModel.find({
                                [childField]: { $regex: String(searchTerm), $options: "i" }
                            }).select('_id').lean();
                            
                            const ids = matchedDocs.map((doc) => doc._id);
                            return ids.length > 0 ? { [relation]: { $in: ids } } : null;
                        } catch (e) {
                            console.error(`[ControllerSets] Error resolving nested search for ${field}:`, e.message);
                            return null;
                        }
                    }
                    return null;
                } else {
                    return {
                        [field]: {
                            $regex: String(searchTerm),
                            $options: "i",
                        },
                    };
                }
            });

            const resolvedOr = await Promise.all(searchPromises);
            const validOrClauses = resolvedOr.filter(Boolean);

            if (validOrClauses.length > 0) {
                filters.$or = validOrClauses;
            } else {
                filters.$or = [{ _id: null }]; 
            }
        } else if (!Array.isArray(this.search) && this.search !== "none" && req.query[this.search]) {
            filters[this.search] = {
                $regex: String(req.query[this.search]),
                $options: "i",
            };
        }

        let sort = {};
        const activeSort = req.query.sort || this.orderBy;
        if (activeSort && activeSort !== "none") {
            const isDescending = activeSort.startsWith("-");
            const sortKey = isDescending ? activeSort.substring(1) : activeSort;
            sort[sortKey] = isDescending ? -1 : 1;
        }

        if (req.query.page) {
            return await this.getPaginatedResults(req, res, filters, sort);
        }

        const result = await this.model.find(filters).sort(sort).lean();
        return res.status(200).json({ success: true, data: result });
    };

    /**
     * GET /:id - Retrieves a single record by its ID.
     */
    getById = async (req, res) => {
        const object = await this.getObjectById(req, res);
        if (object) {
            return res.status(200).json({ success: true, data: object });
        }
    };

    /**
     * POST / - Creates a new record.
     */
    create = async (req, res) => {
        const result = await this.model.create(req.body);
        if (typeof this.runAfterCreate === "function") {
            try {
                await this.runAfterCreate(result);
            } catch (callbackError) {
                console.error(`[ControllerSets] Error in runAfterCreate callback: ${callbackError.message}`);
            }
        }
        return res.status(201).json({ success: true, data: result });
    };

    /**
     * PATCH /:id - Updates an existing record.
     */
    update = async (req, res) => {
        const object = await this.getObjectById(req, res);
        if (!object) return;

        const updatedObject = await this.model.findByIdAndUpdate(
            object._id,
            { $set: req.body },
            { returnDocument: 'after', runValidators: true }
        ).lean();

        return res.status(200).json({ success: true, data: updatedObject });
    };

    /**
     * DELETE /:id - Deletes a record.
     */
    delete = async (req, res) => {
        const object = await this.getObjectById(req, res);
        if (!object) return;

        await this.model.findByIdAndDelete(object._id);
        return res.status(200).json({ success: true, message: "Item successfully deleted." });
    };

    /**
     * Internal pagination logic.
     */
    getPaginatedResults = async (req, res, filters, sort) => {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 50));
        const skip = (page - 1) * pageSize;

        const [totalRecords, result] = await Promise.all([
            this.model.countDocuments(filters),
            this.model.find(filters).skip(skip).limit(pageSize).sort(sort).lean(),
        ]);

        const totalPages = Math.ceil(totalRecords / pageSize);
        return res.status(200).json({
            success: true,
            data: result,
            pagination: {
                currentPage: page,
                pageSize,
                totalPages,
                totalRecords
            }
        });
    };

    /**
     * Standard error reporter for the controller.
     */
    sendErrorResponse = (res, statusCode, message) => {
        return res.status(statusCode).json({ success: false, error: message });
    };
}

export { ControllerSets };
