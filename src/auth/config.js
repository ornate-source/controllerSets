import { MIN_SECRET_LENGTH, durationToSeconds } from "./token.js";
import { resolveDelivery } from "./delivery.js";

// The contract with your user model.
//
// This library never defines a schema. It is told which fields on *your* model
// hold an identifier, a password hash, a role, a one-time code — and it touches
// nothing else. Everything below is a field name or a policy, so the same code
// serves a model with `email`/`password` and one with `msisdn`/`secret`.

const DEFAULT_FIELDS = {
    password: "password",
    role: "role",
    otpHash: "otpHash",
    otpPurpose: "otpPurpose",
    otpExpiresAt: "otpExpiresAt",
    otpAttempts: "otpAttempts",
    failedLogins: "failedLoginAttempts",
    lockedUntil: "lockedUntil",
    passwordChangedAt: "passwordChangedAt",
    refreshTokens: "refreshTokens",
    disabled: null,
};

const DEFAULT_LOCKOUT = { maxAttempts: 10, lockSeconds: 900 };
const DEFAULT_REFRESH = {
    expiresIn: "30d",
    rotate: true,
    // Two requests refreshing at once is ordinary client behaviour, not an
    // attack. The loser of that race gets this long to still be accepted.
    graceSeconds: 10,
    // A leaked token may not be the only one, so a replay ends every session.
    revokeAllOnReuse: true,
    maxSessions: 5,
};

/**
 * Reads a boolean from the environment.
 *
 * Explicit configuration always wins; this is the fallback, so a deployment can
 * flip rotation without a code change. Loading `.env` itself remains the
 * application's job — this library only reads what is already in `process.env`.
 */
const envFlag = (name) => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return undefined;

    const value = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;

    throw new Error(`Auth: ${name} must be true or false, not '${raw}'.`);
};
const DEFAULT_OTP = { length: 6, ttlSeconds: 600, maxAttempts: 5 };
const DEFAULT_PASSWORD_POLICY = { minLength: 8 };

/** Never returned, never client-writable, whatever else is configured. */
export const alwaysSecret = (fields) =>
    [
        fields.password,
        fields.otpHash,
        fields.otpPurpose,
        fields.otpExpiresAt,
        fields.otpAttempts,
        fields.failedLogins,
        fields.lockedUntil,
        fields.refreshTokens,
    ].filter(Boolean);

const requireSecret = (secret) => {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
        throw new Error(
            `Auth: 'token.secret' must be at least ${MIN_SECRET_LENGTH} characters. ` +
                `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
        );
    }
    return secret;
};

const normalizeIdentifiers = (option) => {
    const list = Array.isArray(option) ? option : [option ?? "email"];

    return list.map((entry) => {
        const spec = typeof entry === "string" ? { field: entry } : { ...entry };
        if (!spec.field) throw new Error("Auth: every identifier needs a 'field'.");

        // Email is matched case-insensitively because users do not type it the
        // same way twice; a phone number loses its formatting for the same
        // reason. Anything else is stored as sent unless a normalizer is given.
        spec.normalize ??=
            spec.field === "email"
                ? (value) => value.trim().toLowerCase()
                : spec.field === "phone" || spec.field === "mobile"
                  ? (value) => value.replace(/[\s()-]/g, "")
                  : (value) => value.trim();

        return spec;
    });
};

const normalizeRoles = (option = {}) => {
    const field = option.field ?? DEFAULT_FIELDS.role;
    const list = Array.isArray(option.list) ? option.list : null;
    const admin = Array.isArray(option.admin) ? option.admin : [option.admin ?? "admin"];

    return {
        field,
        list,
        admin,
        default: option.default ?? (list ? list[0] : "user"),
        // A model whose role path is an array holds several roles per user.
        multiple: option.multiple === true,
    };
};

/**
 * Declares an identifier with its own normalizer.
 *
 * `identifiers: ["email", identifier("nationalId", (v) => v.toUpperCase())]`.
 * A plain object works identically; this exists because TypeScript cannot infer
 * the callback's parameter inside an array whose element type is a union.
 */
export const identifier = (field, normalize) => (normalize ? { field, normalize } : { field });

/**
 * Refresh tokens are opt-in: enabling them requires a field on your model, and
 * turning them on silently would break a model that has none.
 */
const resolveRefresh = (option = {}, model, fields) => {
    const enabled = option.enabled ?? envFlag("AUTH_REFRESH_ENABLED") ?? false;
    if (!enabled) return Object.freeze({ enabled: false });

    const expiresIn = option.expiresIn ?? process.env.AUTH_REFRESH_EXPIRES_IN ?? DEFAULT_REFRESH.expiresIn;
    const ttlSeconds = durationToSeconds(expiresIn);
    if (!ttlSeconds) {
        throw new Error("Auth: 'refresh.expiresIn' must be a duration like '30d'.");
    }

    // Mongoose drops a path the schema does not define, so without this the
    // session would be written nowhere and every refresh would fail with no
    // indication why.
    const field = fields.refreshTokens;
    if (model?.schema?.path && !model.schema.path(field)) {
        throw new Error(
            `Auth: refresh tokens need a '${field}' array on your user schema. Add:\n` +
                `  ${field}: [{ id: String, hash: String, previousHash: String, ` +
                `rotatedAt: Date, createdAt: Date, lastUsedAt: Date, expiresAt: Date, ` +
                `userAgent: String }]`,
        );
    }

    return Object.freeze({
        enabled: true,
        ttlSeconds,
        expiresIn,
        rotate: option.rotate ?? envFlag("AUTH_REFRESH_ROTATE") ?? DEFAULT_REFRESH.rotate,
        graceSeconds: option.graceSeconds ?? DEFAULT_REFRESH.graceSeconds,
        revokeAllOnReuse: option.revokeAllOnReuse ?? DEFAULT_REFRESH.revokeAllOnReuse,
        maxSessions: option.maxSessions ?? DEFAULT_REFRESH.maxSessions,
    });
};

export const buildAuthConfig = (options = {}) => {
    if (!options.model) throw new Error("Auth: a Mongoose user model is required.");

    const fields = { ...DEFAULT_FIELDS, ...(options.fields ?? {}) };
    const token = options.token ?? {};
    const secret = requireSecret(token.secret);

    const expiresIn = token.expiresIn ?? "15m";
    if (!durationToSeconds(expiresIn)) {
        throw new Error(`Auth: 'token.expiresIn' must be a duration like '15m' or '7d'.`);
    }

    const otp = { ...DEFAULT_OTP, ...(options.otp ?? {}) };
    if (otp.deliver !== undefined && typeof otp.deliver !== "function") {
        throw new Error("Auth: 'otp.deliver' must be a function.");
    }

    const providers = options.social ?? {};
    const refresh = resolveRefresh(options.refresh, options.model, fields);

    return Object.freeze({
        model: options.model,
        logger: options.logger ?? console,

        identifiers: normalizeIdentifiers(options.identifiers),
        fields,
        secretFields: alwaysSecret(fields),

        token: Object.freeze({
            secret,
            expiresIn,
            issuer: token.issuer ?? null,
            audience: token.audience ?? null,
            // A password change should end every session opened before it.
            invalidateOnPasswordChange: token.invalidateOnPasswordChange !== false,
        }),

        password: Object.freeze({
            minLength: options.password?.minLength ?? DEFAULT_PASSWORD_POLICY.minLength,
            // Bring bcrypt or argon2 if you prefer; scrypt is the default because
            // it needs nothing installed.
            hash: options.password?.hash ?? null,
            verify: options.password?.verify ?? null,
        }),

        otp: Object.freeze(otp),
        delivery: resolveDelivery(options),
        refresh,
        lockout: Object.freeze({ ...DEFAULT_LOCKOUT, ...(options.lockout ?? {}) }),
        roles: Object.freeze(normalizeRoles(options.roles)),
        social: Object.freeze(providers),

        // Fields a client may set when registering, and when updating itself.
        registerFields: options.registerFields ?? null,
        updateFields: options.updateFields ?? null,

        /** Extra work at the end of a successful registration. */
        onRegister: typeof options.onRegister === "function" ? options.onRegister : null,
        /** Last word on whether a login may proceed — suspended accounts, tenancy, anything. */
        onLogin: typeof options.onLogin === "function" ? options.onLogin : null,
    });
};
