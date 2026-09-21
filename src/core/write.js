import { HttpError, pickWritable, sanitizeAssignable } from "../utils/sanitize.js";

// Runs before Mongoose, so a field the schema marks `required` may be absent here.
// Nothing returned keeps the payload; an object replaces it; throw to reject.
const runValidator = async (validator, payload, context) => {
    const result = await validator(payload, context);

    if (result === undefined || result === null) return payload;

    if (typeof result !== "object" || Array.isArray(result)) {
        throw new TypeError(
            `[ControllerSets] The '${context.operation}' validator returned ` +
                `${Array.isArray(result) ? "an array" : typeof result} — return a plain object ` +
                `to replace the payload, or nothing to keep it. Throw to reject the request.`,
        );
    }

    // No allowlist: server code may set fields a client cannot. Syntax keys still go.
    return sanitizeAssignable(result);
};

export const buildWritePayload = async (operation, { req, res, config }) => {
    const filtered = config.legacyMode
        ? (req.body ?? {})
        : pickWritable(req.body, config.fieldPolicy[operation]);

    if (!config.legacyMode && Object.keys(filtered).length === 0) {
        throw new HttpError(400, "Request body contains no writable fields.");
    }

    const validator = config.validators[operation];
    if (!validator) return filtered;

    return runValidator(validator, filtered, {
        req,
        res,
        operation,
        model: config.model,
        id: req.params?.id,
    });
};

// The record already exists, so a failure here leaves the caller unsure whether
// the write landed. Surfacing it is opt-in via `strictAfterCreate`.
export const runAfterCreateHook = async (document, config) => {
    if (typeof config.runAfterCreate !== "function") return;

    try {
        await config.runAfterCreate(document);
    } catch (err) {
        config.logger.error(`[ControllerSets] Error in runAfterCreate callback: ${err.message}`);
        if (config.strictAfterCreate) throw err;
    }
};
