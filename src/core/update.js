import { resolveReadShape, updateOneById, validateObjectId } from "./dataAccess.js";
import { handler } from "./handler.js";
import { failure, ok } from "./respond.js";
import { buildWritePayload } from "./write.js";

// PATCH /:id
export const update = handler(async (req, res, config) => {
    const id = validateObjectId(req.params.id);
    const payload = await buildWritePayload("update", { req, res, config });
    const shape = await resolveReadShape(req, res, config);

    const document = await updateOneById({ id, payload, shape, config });
    if (!document) return failure(res, 404, "Entry not found.");

    return ok(res, document);
});
