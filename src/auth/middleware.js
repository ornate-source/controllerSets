import { HttpError } from "../utils/sanitize.js";
import { failure } from "../core/respond.js";
import { verifyToken } from "./token.js";

// Who is calling, and may they.

const bearer = (req) => {
    const header = req.headers?.authorization;
    if (typeof header !== "string") return null;

    const [scheme, value] = header.split(" ");
    return scheme?.toLowerCase() === "bearer" && value ? value : null;
};

const reject = (res, status, message) => failure(res, status, message);

/**
 * Verifies the bearer token and populates `req.auth`.
 *
 * With `loadUser` it also fetches the record, so a deleted or disabled account
 * cannot keep using a token that has not expired yet.
 */
export const requireAuth = (config, { loadUser = false } = {}) => {
    return async (req, res, next) => {
        try {
            const token = bearer(req);
            if (!token) return reject(res, 401, "Authentication required.");

            const claims = verifyToken(token, config.token);
            req.auth = { userId: claims.sub, role: claims.role, claims };

            if (loadUser || config.token.invalidateOnPasswordChange) {
                const user = await config.model.findById(claims.sub);
                if (!user) return reject(res, 401, "Authentication required.");

                // A password change ends the sessions that predate it. Both
                // sides are compared in whole seconds because `iat` is floored:
                // a token minted in the same second as the change is current,
                // and comparing milliseconds would sign the user straight out.
                const changedAt = user[config.fields.passwordChangedAt];
                if (
                    config.token.invalidateOnPasswordChange &&
                    changedAt instanceof Date &&
                    claims.iat < Math.floor(changedAt.getTime() / 1000)
                ) {
                    return reject(res, 401, "Session ended. Sign in again.");
                }

                if (config.fields.disabled && user[config.fields.disabled]) {
                    return reject(res, 403, "This account is not active.");
                }

                req.user = user;
                req.auth.role = user[config.roles.field] ?? req.auth.role;
            }

            return next();
        } catch (err) {
            if (err instanceof HttpError) return reject(res, err.status, err.message);
            return next(err);
        }
    };
};

/** Gates a route on a role. Runs after `requireAuth`, which put the role there. */
export const requireRole = (...allowed) => {
    const permitted = allowed.flat();

    return (req, res, next) => {
        if (!req.auth) return reject(res, 401, "Authentication required.");

        const held = Array.isArray(req.auth.role) ? req.auth.role : [req.auth.role];
        if (!held.some((role) => permitted.includes(role))) {
            return reject(res, 403, "You do not have access to this resource.");
        }
        return next();
    };
};
