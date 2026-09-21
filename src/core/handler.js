import { HttpError } from "../utils/sanitize.js";
import { failure } from "./respond.js";

// Deliberate 4xx/415s are answered here, so they work without `errorHandler`
// mounted. Anything unexpected propagates rather than becoming a tidy 400.
export const handler = (run) => async (req, res, config) => {
    try {
        return await run(req, res, config);
    } catch (err) {
        if (!(err instanceof HttpError) || res.headersSent) throw err;

        for (const [name, value] of Object.entries(err.headers ?? {})) {
            res.setHeader(name, value);
        }
        return failure(res, err.status, err.message, err.fields);
    }
};
