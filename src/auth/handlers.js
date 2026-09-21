import { HttpError } from "../utils/sanitize.js";
import { handler } from "../core/handler.js";
import { created, failure, ok, okMessage } from "../core/respond.js";
import { findMany, findPage, validateObjectId } from "../core/dataAccess.js";
import {
    assertPasswordPolicy,
    clearFailures,
    credentialSelect,
    findByIdentifier,
    hashFor,
    identifierValues,
    isLocked,
    passwordMatches,
    publicProjection,
    publicUser,
    recordFailure,
    writableFrom,
} from "./account.js";
import { verifyAgainstDecoy } from "./password.js";
import { generateOtp, hashOtp, otpMatches } from "./otp.js";
import { signToken } from "./token.js";
import { resolveProvider } from "./providers/index.js";

// The endpoints. Each one is short because the decisions live in `account.js`,
// `password.js`, `token.js` and `otp.js`; what is left here is the sequence.

const issue = (user, config) =>
    signToken(
        {
            sub: String(user._id),
            role: user[config.roles.field] ?? undefined,
        },
        config.token,
    );

const session = (user, config) => ({ token: issue(user, config), user: publicUser(user, config) });

/* ------------------------------------------------------------------ *
 * POST /register
 * ------------------------------------------------------------------ */

export const register = handler(async (req, res, config) => {
    const identifiers = identifierValues(req.body, config);
    const password = assertPasswordPolicy(req.body?.password, config);

    const payload = {
        ...writableFrom(req.body, config.registerFields, config),
        ...identifiers,
        [config.fields.password]: await hashFor(password, config),
        [config.roles.field]: config.roles.multiple ? [config.roles.default] : config.roles.default,
    };

    let user;
    try {
        user = await config.model.create(payload);
    } catch (err) {
        // A duplicate identifier is the one error worth translating: it means
        // the account exists, and the 409 says so without saying which field.
        if (err?.code === 11000) {
            throw new HttpError(409, "An account with those details already exists.");
        }
        throw err;
    }

    if (config.onRegister) await config.onRegister(user, req);

    return created(res, session(user, config));
});

/* ------------------------------------------------------------------ *
 * POST /login
 * ------------------------------------------------------------------ */

// One message for every way a login can fail. "No such user" and "wrong
// password" told apart is a list of your customers.
const REJECTED = "Invalid credentials.";

export const login = handler(async (req, res, config) => {
    const identifier = req.body?.identifier ?? req.body?.[config.identifiers[0].field];
    const password = req.body?.password;

    if (typeof password !== "string" || password === "") {
        throw new HttpError(400, "A password is required.");
    }

    const user = await findByIdentifier(identifier, config).select(credentialSelect(config));

    if (!user) {
        // Same work as a real verification, so the response time says nothing.
        await verifyAgainstDecoy(password);
        throw new HttpError(401, REJECTED);
    }

    if (isLocked(user, config)) {
        throw new HttpError(429, "Too many failed attempts. Try again later.");
    }

    if (!(await passwordMatches(password, user[config.fields.password], config))) {
        await recordFailure(user, config);
        throw new HttpError(401, REJECTED);
    }

    if (config.fields.disabled && user[config.fields.disabled]) {
        throw new HttpError(403, "This account is not active.");
    }

    if (config.onLogin) await config.onLogin(user, req);

    if (user[config.fields.failedLogins] || user[config.fields.lockedUntil]) {
        await clearFailures(user, config);
    }

    return ok(res, session(user, config));
});

/* ------------------------------------------------------------------ *
 * POST /social/:provider
 * ------------------------------------------------------------------ */

export const socialLogin = handler(async (req, res, config) => {
    const name = String(req.params.provider ?? "").toLowerCase();
    const provider = resolveProvider(name, config);

    const profile = await provider.verify(req.body ?? {});
    if (!profile?.id) throw new HttpError(401, "The provider returned no account id.");

    // Match on the provider id first. Falling back to a verified email is what
    // links a social sign-in to an account that already registered by password
    // — and it is only safe because the provider vouched for that address.
    let user = await config.model.findOne({ [provider.idField]: profile.id });

    if (!user && profile.email) {
        const emailField = config.identifiers.find((spec) => spec.field === "email")?.field;
        if (emailField) {
            user = await config.model.findOne({ [emailField]: profile.email.toLowerCase() });
            if (user) {
                user[provider.idField] = profile.id;
                await user.save();
            }
        }
    }

    if (!user) {
        const identifiers = profile.email ? { email: profile.email.toLowerCase() } : {};
        user = await config.model.create({
            ...identifiers,
            [provider.idField]: profile.id,
            ...(profile.name ? { name: profile.name } : {}),
            [config.roles.field]: config.roles.multiple
                ? [config.roles.default]
                : config.roles.default,
        });
        if (config.onRegister) await config.onRegister(user, req);
    }

    if (config.fields.disabled && user[config.fields.disabled]) {
        throw new HttpError(403, "This account is not active.");
    }
    if (config.onLogin) await config.onLogin(user, req);

    return ok(res, { ...session(user, config), provider: name });
});

/* ------------------------------------------------------------------ *
 * POST /password/change  (authenticated)
 * ------------------------------------------------------------------ */

export const changePassword = handler(async (req, res, config) => {
    const current = req.body?.currentPassword;
    const next = assertPasswordPolicy(req.body?.newPassword, config);

    const user = await config.model
        .findById(req.auth.userId)
        .select(`+${config.fields.password}`);
    if (!user) throw new HttpError(401, "Not authenticated.");

    if (!(await passwordMatches(current ?? "", user[config.fields.password], config))) {
        throw new HttpError(401, "Current password is incorrect.");
    }

    await config.model.updateOne(
        { _id: user._id },
        {
            $set: {
                [config.fields.password]: await hashFor(next, config),
                [config.fields.passwordChangedAt]: new Date(),
            },
        },
    );

    return okMessage(res, "Password changed.");
});

/* ------------------------------------------------------------------ *
 * POST /password/forgot  →  a one-time code
 * ------------------------------------------------------------------ */

const OTP_PURPOSE = "password-reset";

// Whether or not the account exists, the answer is the same. Anything else
// turns this endpoint into a way to ask which addresses are registered.
const SENT = "If that account exists, a code has been sent.";

export const forgotPassword = handler(async (req, res, config) => {
    const identifier = req.body?.identifier ?? req.body?.[config.identifiers[0].field];
    const channel = req.body?.channel === "sms" ? "sms" : "email";

    const user = await findByIdentifier(identifier, config);
    if (!user) return okMessage(res, SENT);

    const code = generateOtp(config.otp.length);

    await config.model.updateOne(
        { _id: user._id },
        {
            $set: {
                [config.fields.otpHash]: hashOtp(code, OTP_PURPOSE, config.token.secret),
                [config.fields.otpPurpose]: OTP_PURPOSE,
                [config.fields.otpExpiresAt]: new Date(Date.now() + config.otp.ttlSeconds * 1000),
                [config.fields.otpAttempts]: 0,
            },
        },
    );

    if (config.otp.deliver) {
        // Delivery is the application's: this library has no opinion on your
        // mail provider and no business holding its credentials.
        try {
            await config.otp.deliver({ user: publicUser(user, config), code, channel, req });
        } catch (err) {
            config.logger.error(`[Auth] OTP delivery failed: ${err.message}`);
            throw new HttpError(503, "Could not send the code. Try again shortly.");
        }
    } else {
        config.logger.warn(
            "[Auth] No 'otp.deliver' configured — the reset code was generated but not sent.",
        );
    }

    return okMessage(res, SENT);
});

/* ------------------------------------------------------------------ *
 * POST /password/reset  →  verify the code, set the password
 * ------------------------------------------------------------------ */

export const resetPassword = handler(async (req, res, config) => {
    const identifier = req.body?.identifier ?? req.body?.[config.identifiers[0].field];
    const code = req.body?.code;
    const next = assertPasswordPolicy(req.body?.newPassword, config);

    const user = await findByIdentifier(identifier, config).select(
        `+${config.fields.otpHash} +${config.fields.otpExpiresAt} +${config.fields.otpAttempts} +${config.fields.otpPurpose}`,
    );

    const invalid = new HttpError(400, "That code is invalid or has expired.");
    if (!user || !user[config.fields.otpHash]) throw invalid;

    const expiresAt = user[config.fields.otpExpiresAt];
    if (!(expiresAt instanceof Date) || expiresAt.getTime() < Date.now()) throw invalid;
    if ((user[config.fields.otpAttempts] ?? 0) >= config.otp.maxAttempts) throw invalid;
    if (user[config.fields.otpPurpose] !== OTP_PURPOSE) throw invalid;

    if (!otpMatches(code, OTP_PURPOSE, config.token.secret, user[config.fields.otpHash])) {
        // Count the guess. Without this a six-digit code is brute-forceable.
        await config.model.updateOne({ _id: user._id }, { $inc: { [config.fields.otpAttempts]: 1 } });
        throw invalid;
    }

    await config.model.updateOne(
        { _id: user._id },
        {
            $set: {
                [config.fields.password]: await hashFor(next, config),
                [config.fields.passwordChangedAt]: new Date(),
                [config.fields.otpHash]: null,
                [config.fields.otpPurpose]: null,
                [config.fields.otpExpiresAt]: null,
                [config.fields.otpAttempts]: 0,
                [config.fields.failedLogins]: 0,
                [config.fields.lockedUntil]: null,
            },
        },
    );

    return okMessage(res, "Password reset. Sign in with your new password.");
});

/* ------------------------------------------------------------------ *
 * GET /me
 * ------------------------------------------------------------------ */

export const me = handler(async (req, res, config) => {
    const user = await config.model.findById(req.auth.userId).select(publicProjection(config));
    if (!user) throw new HttpError(401, "Not authenticated.");

    return ok(res, publicUser(user, config));
});

/* ------------------------------------------------------------------ *
 * PATCH /users/:id
 * ------------------------------------------------------------------ */

const isAdmin = (req, config) => {
    const role = req.auth?.role;
    const held = Array.isArray(role) ? role : [role];
    return held.some((entry) => config.roles.admin.includes(entry));
};

export const updateUser = handler(async (req, res, config) => {
    const id = validateObjectId(req.params.id);

    // Your own record, or anyone's if you administer them.
    if (String(req.auth.userId) !== String(id) && !isAdmin(req, config)) {
        throw new HttpError(403, "You may only update your own account.");
    }

    const payload = {
        ...writableFrom(req.body, config.updateFields, config),
        ...identifierValues(req.body, config, { required: false }),
    };

    if (Object.keys(payload).length === 0) {
        throw new HttpError(400, "Request body contains no writable fields.");
    }

    const user = await config.model
        .findByIdAndUpdate(
            id,
            { $set: payload },
            { returnDocument: "after", runValidators: true, context: "query" },
        )
        .select(publicProjection(config));

    if (!user) return failure(res, 404, "Entry not found.");
    return ok(res, publicUser(user, config));
});

/* ------------------------------------------------------------------ *
 * PATCH /users/:id/roles
 * ------------------------------------------------------------------ */

export const modifyRoles = handler(async (req, res, config) => {
    const id = validateObjectId(req.params.id);
    const requested = req.body?.roles ?? req.body?.role;
    const list = Array.isArray(requested) ? requested : [requested];

    if (list.length === 0 || list.some((entry) => typeof entry !== "string" || entry === "")) {
        throw new HttpError(400, "A role is required.");
    }
    if (config.roles.list) {
        const unknown = list.filter((entry) => !config.roles.list.includes(entry));
        if (unknown.length > 0) {
            throw new HttpError(
                400,
                `Unknown role: ${unknown.join(", ")}. Allowed: ${config.roles.list.join(", ")}.`,
            );
        }
    }
    if (!config.roles.multiple && list.length > 1) {
        throw new HttpError(400, "This model holds one role per user.");
    }

    // An administrator removing their own administrator role locks everyone
    // out of this endpoint, including whoever has to undo it.
    if (String(req.auth.userId) === String(id)) {
        const keepsAdmin = list.some((entry) => config.roles.admin.includes(entry));
        if (!keepsAdmin) throw new HttpError(400, "You cannot remove your own admin role.");
    }

    const user = await config.model
        .findByIdAndUpdate(
            id,
            { $set: { [config.roles.field]: config.roles.multiple ? list : list[0] } },
            { returnDocument: "after", runValidators: true, context: "query" },
        )
        .select(publicProjection(config));

    if (!user) return failure(res, 404, "Entry not found.");
    return ok(res, publicUser(user, config));
});

/* ------------------------------------------------------------------ *
 * GET /users  and  GET /users/:id
 * ------------------------------------------------------------------ */

export const listUsers = (readConfig) =>
    handler(async (req, res, config) => {
        const shape = { populates: [], selects: publicProjection(config) };
        const paging = req.query.page
            ? {
                  page: Math.max(1, parseInt(req.query.page, 10) || 1),
                  pageSize: Math.min(
                      readConfig.maxLimit,
                      Math.max(1, parseInt(req.query.pageSize, 10) || readConfig.defaultPageSize),
                  ),
              }
            : null;

        const filters = {};
        for (const spec of config.identifiers) {
            const value = req.query[spec.field];
            if (typeof value === "string" && value !== "") {
                filters[spec.field] = spec.normalize(value);
            }
        }
        const roleFilter = req.query[config.roles.field];
        if (typeof roleFilter === "string" && roleFilter !== "") {
            filters[config.roles.field] = roleFilter;
        }

        const sort = { _id: -1 };
        if (paging) {
            const page = await findPage({ filters, sort, ...paging, shape, config: readConfig });
            return res.status(200).json({ success: true, ...page });
        }

        const users = await findMany({
            filters,
            sort,
            limit: readConfig.maxLimit,
            shape,
            config: readConfig,
        });
        return ok(res, users);
    });

export const getUser = handler(async (req, res, config) => {
    const id = validateObjectId(req.params.id);

    const user = await config.model.findById(id).select(publicProjection(config));
    if (!user) return failure(res, 404, "Entry not found.");

    return ok(res, publicUser(user, config));
});
