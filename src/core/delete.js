import { deleteOneById, validateObjectId } from "./dataAccess.js";
import { handler } from "./handler.js";
import { failure, okMessage } from "./respond.js";

// DELETE /:id
export const remove = handler(async (req, res, config) => {
    const id = validateObjectId(req.params.id);

    const deleted = await deleteOneById({ id, config });
    if (!deleted) return failure(res, 404, "Entry not found.");

    return okMessage(res, "Item successfully deleted.");
});
