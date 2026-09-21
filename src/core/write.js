import { HttpError, pickWritable, sanitizeAssignable } from "../utils/sanitize.js";

/**
 * Request body → the document this library is willing to write.
 *
 * Two gates, in this order, and both are needed:
 *
 *   1. the field policy, which decides what a *client* may set;
 *   2. the author's own `validate` hook, which decides whether the resulting
 *      values make sense.
 *
 * The first is about authority and cannot be delegated; the second is about
 * correctness and is nobody's business but the API author's. Mongoose's schema
 * validators still run after both, as the last line of defence.
 */

/**
 * Runs the configured validator for one verb.
 *
 * The hook runs before Mongoose, which is what lets it add server-owned fields a
 * schema marks `required`. The corollary is that a required field may be missing
 * when the hook sees it, so a hook that dereferences one should check first.
 *
 * Return contract, chosen so the common case is a function that just throws:
 *   - `undefined` / `null` — the payload stands as filtered;
 *   - a plain object — replaces the payload, letting a hook normalise values or
 *     add server-owned fields (`ownerId`, `slug`) that no client may set;
 *   - anything else — a programming error, and it is raised as one.
 *
 * To reject a request, throw: `ValidationError` for field-level messages, any
 * `HttpError` for a plain status, or a Mongoose `ValidationError` if you ran the
 * schema yourself. Anything else propagates as a 500, unchanged.
 */
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

    // The hook runs on the server and may legitimately set fields a client
    // cannot, so no allowlist is reapplied. Keys that are syntax rather than
    // data are still refused: no hook needs `$set` or `__proto__` as a name.
    return sanitizeAssignable(result);
};

/**
 * Builds the payload for a create or an update.
 *
 * @param {"create"|"update"} operation
 * @returns {Promise<object>} the document to hand Mongoose
 */
export const buildWritePayload = async (operation, { req, res, config }) => {
    // `legacyMode` writes the body as it arrived. `?? {}` only covers the case
    // where no parser ran at all, so a hook is never handed `undefined`.
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

/**
 * Runs the `runAfterCreate` side effect.
 *
 * The record already exists by the time this runs, so a failure here leaves the
 * caller unable to tell whether the write landed. Surfacing it is therefore
 * opt-in via `strictAfterCreate`; by default it is logged and swallowed.
 */
export const runAfterCreateHook = async (document, config) => {
    if (typeof config.runAfterCreate !== "function") return;

    try {
        await config.runAfterCreate(document);
    } catch (err) {
        config.logger.error(`[ControllerSets] Error in runAfterCreate callback: ${err.message}`);
        if (config.strictAfterCreate) throw err;
    }
};
