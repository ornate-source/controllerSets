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
        search = "none",
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

        // Bind all methods to ensure 'this' context in Express
        this.getAll = this.getAll.bind(this);
        this.getById = this.getById.bind(this);
        this.create = this.create.bind(this);
        this.update = this.update.bind(this);
        this.delete = this.delete.bind(this);
    }

    /**
     * Internal utility to fetch an object and handle basic validation.
     */
    async getObjectById(req, res) {
        const { id } = req.params;
        const isValidId = mongoose?.Types?.ObjectId?.isValid 
            ? mongoose.Types.ObjectId.isValid(id)
            : /^[0-9a-fA-F]{24}$/.test(id);

        if (!isValidId) {
            this.sendErrorResponse(res, 400, "Invalid ID format.");
            return null;
        }

        try {
            const object = await this.model.findById(id);
            if (!object) {
                this.sendErrorResponse(res, 404, "Entry not found.");
                return null;
            }
            return object;
        } catch (error) {
            console.error(`[ControllerSets] Error in getObjectById: ${error.message}`);
            this.sendErrorResponse(res, 500, "Database lookup failed.");
            return null;
        }
    }

    /**
     * GET / - Retrieves list of records with filtering, searching, and pagination.
     */
    async getAll(req, res) {
        try {
            let filters = this.query.reduce((acc, queryKey) => {
                if (req.query[queryKey] !== undefined) {
                    acc[queryKey] = req.query[queryKey];
                }
                return acc;
            }, {});

            if (this.search !== "none" && req.query[this.search]) {
                filters[this.search] = {
                    $regex: String(req.query[this.search]),
                    $options: "i",
                };
            }

            let sort = {};
            if (this.orderBy !== "none") {
                const isDescending = this.orderBy.startsWith("-");
                const sortKey = isDescending ? this.orderBy.substring(1) : this.orderBy;
                sort[sortKey] = isDescending ? -1 : 1;
            }

            if (req.query.page) {
                return await this.getPaginatedResults(req, res, filters, sort);
            }

            const result = await this.model.find(filters).sort(sort).lean();
            return res.status(200).json({ success: true, data: result });
        } catch (error) {
            console.error(`[ControllerSets] Error in getAll: ${error.message}`);
            return this.sendErrorResponse(res, 500, "Failed to retrieve entries.");
        }
    }

    /**
     * GET /:id - Retrieves a single record by its ID.
     */
    async getById(req, res) {
        const object = await this.getObjectById(req, res);
        if (object) {
            return res.status(200).json({ success: true, data: object });
        }
    }

    /**
     * POST / - Creates a new record.
     */
    async create(req, res) {
        try {
            const result = await this.model.create(req.body);
            if (typeof this.runAfterCreate === "function") {
                try {
                    await this.runAfterCreate(result);
                } catch (callbackError) {
                    console.error(`[ControllerSets] Error in runAfterCreate callback: ${callbackError.message}`);
                }
            }
            return res.status(201).json({ success: true, data: result });
        } catch (error) {
            console.error(`[ControllerSets] Error in create: ${error.message}`);
            return this.sendErrorResponse(res, 400, error.message || "Failed to create entry.");
        }
    }

    /**
     * PATCH /:id - Updates an existing record.
     */
    async update(req, res) {
        const object = await this.getObjectById(req, res);
        if (!object) return;

        try {
            const updatedObject = await this.model.findByIdAndUpdate(
                object._id,
                { $set: req.body },
                { new: true, runValidators: true }
            );
            return res.status(200).json({ success: true, data: updatedObject });
        } catch (error) {
            console.error(`[ControllerSets] Error in update: ${error.message}`);
            return this.sendErrorResponse(res, 400, "Update failed. Check your data.");
        }
    }

    /**
     * DELETE /:id - Deletes a record.
     */
    async delete(req, res) {
        const object = await this.getObjectById(req, res);
        if (!object) return;

        try {
            await this.model.findByIdAndDelete(object._id);
            return res.status(200).json({ success: true, message: "Item successfully deleted." });
        } catch (error) {
            console.error(`[ControllerSets] Error in delete: ${error.message}`);
            return this.sendErrorResponse(res, 500, "Deletion failed.");
        }
    }

    /**
     * Internal pagination logic.
     */
    async getPaginatedResults(req, res, filters, sort) {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 50));
        const skip = (page - 1) * pageSize;

        try {
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
        } catch (error) {
            console.error(`[ControllerSets] Error in pagination: ${error.message}`);
            return this.sendErrorResponse(res, 500, "Pagination error.");
        }
    }

    /**
     * Standard error reporter for the controller.
     */
    sendErrorResponse(res, statusCode, message) {
        return res.status(statusCode).json({ success: false, error: message });
    }
}

export { ControllerSets };
