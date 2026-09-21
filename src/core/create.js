import { insertOne } from "./dataAccess.js";
import { handler } from "./handler.js";
import { created } from "./respond.js";
import { buildWritePayload, runAfterCreateHook } from "./write.js";

// POST / — field policy, then the author's `validate` hook, then Mongoose.
export const create = handler(async (req, res, config) => {
    const payload = await buildWritePayload("create", { req, res, config });

    const document = await insertOne({ payload, config });
    await runAfterCreateHook(document, config);

    return created(res, document);
});
