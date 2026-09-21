import { findOneById, resolveReadShape, validateObjectId } from "./dataAccess.js";
import { handler } from "./handler.js";
import { failure, ok } from "./respond.js";

// GET /:id
export const get = handler(async (req, res, config) => {
    const id = validateObjectId(req.params.id);
    const shape = await resolveReadShape(req, res, config);

    const document = await findOneById({ id, shape, config });
    if (!document) return failure(res, 404, "Entry not found.");

    return ok(res, document);
});
