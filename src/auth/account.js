import { HttpError, isUnsafeKey } from "../utils/sanitize.js";
import { hashPassword, verifyPassword, MAX_PASSWORD_LENGTH } from "./password.js";

// Everything the handlers do to a user record: find one by an identifier, keep
// the secrets out of responses, count failed attempts, set a password.

const scalar = (value) => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    // An object here is an injected operator, not a login.
    throw new HttpError(400, "Invalid credentials format.");
};

/**
 * Builds the lookup for a login identifier.
 *
 * With several identifiers configured the value is matched against each in
 * turn, so one field accepts an email and a phone number without the client
 * having to say which it sent.
 */
export const identifierQuery = (raw, config) => {
    const value = scalar(raw);
    if (value === "") throw new HttpError(400, "An identifier is required.");

    const clauses = config.identifiers.map((spec) => ({ [spec.field]: spec.normalize(value) }));
    return clauses.length === 1 ? clauses[0] : { $or: clauses };
};

/** The identifier values to store on a new record, keyed by field. */
export const identifierValues = (body, config, { required = true } = {}) => {
    const values = {};

    for (const spec of config.identifiers) {
        const raw = body?.[spec.field];
        if (raw === undefined || raw === null || raw === "") continue;
        values[spec.field] = spec.normalize(scalar(raw));
    }

    if (required && Object.keys(values).length === 0) {
        const names = config.identifiers.map((spec) => spec.field).join(" or ");
        throw new HttpError(400, `A ${names} is required.`);
    }
    return values;
};

/** A projection that drops every secret field, whatever the caller asked for. */
export const publicProjection = (config) =>
    config.secretFields.map((field) => `-${field}`).join(" ");

/** Strips secrets from a document on its way into a response. */
export const publicUser = (document, config) => {
    if (!document) return null;

    const plain =
        typeof document.toObject === "function" ? document.toObject({ virtuals: true }) : { ...document };

    for (const field of config.secretFields) delete plain[field];
    return plain;
};

export const findByIdentifier = (raw, config) =>
    config.model.findOne(identifierQuery(raw, config));

/**
 * The fields a sign-in decides with, explicitly selected.
 *
 * A password is nearly always `select: false` on the schema, and the lockout
 * counters usually are too — without this the login reads `undefined` for both
 * and the lock never engages.
 */
export const credentialSelect = (config) =>
    [config.fields.password, config.fields.failedLogins, config.fields.lockedUntil]
        .filter(Boolean)
        .map((field) => `+${field}`)
        .join(" ");

export const assertPasswordPolicy = (password, config) => {
    if (typeof password !== "string") {
        throw new HttpError(400, "A password is required.");
    }
    if (password.length < config.password.minLength) {
        throw new HttpError(
            400,
            `Password must be at least ${config.password.minLength} characters.`,
        );
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
        throw new HttpError(400, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
    }
    return password;
};

export const hashFor = (password, config) =>
    config.password.hash ? config.password.hash(password) : hashPassword(password);

export const passwordMatches = (password, stored, config) =>
    config.password.verify
        ? config.password.verify(password, stored)
        : verifyPassword(password, stored);

/* ------------------------------------------------------------------ *
 * Lockout
 * ------------------------------------------------------------------ */

export const isLocked = (user, config) => {
    const until = user?.[config.fields.lockedUntil];
    return until instanceof Date ? until.getTime() > Date.now() : false;
};

/**
 * One failed attempt. The counter and the lock live on the user record, so
 * this survives a restart and works across every instance behind a balancer —
 * which an in-memory counter does not.
 */
export const recordFailure = async (user, config) => {
    const { maxAttempts, lockSeconds } = config.lockout;
    const attempts = (user[config.fields.failedLogins] ?? 0) + 1;

    const update = { [config.fields.failedLogins]: attempts };
    if (attempts >= maxAttempts) {
        update[config.fields.lockedUntil] = new Date(Date.now() + lockSeconds * 1000);
        update[config.fields.failedLogins] = 0;
    }

    await config.model.updateOne({ _id: user._id }, { $set: update });
};

export const clearFailures = async (user, config) => {
    const update = { [config.fields.failedLogins]: 0 };
    if (user[config.fields.lockedUntil]) update[config.fields.lockedUntil] = null;
    await config.model.updateOne({ _id: user._id }, { $set: update });
};

/* ------------------------------------------------------------------ *
 * Writable input
 * ------------------------------------------------------------------ */

/**
 * The subset of a body this endpoint will write.
 *
 * Secret fields and the role field are removed unconditionally: registering is
 * not the place to choose your own role, and no allowlist should have to
 * remember that.
 */
export const writableFrom = (body, allowlist, config) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return {};

    const blocked = new Set([...config.secretFields, config.roles.field, "_id", "__v"]);
    const out = {};

    for (const [key, value] of Object.entries(body)) {
        if (isUnsafeKey(key) || blocked.has(key)) continue;
        if (allowlist && !allowlist.includes(key)) continue;
        if (value && typeof value === "object" && !(value instanceof Date)) continue;
        out[key] = value;
    }
    return out;
};
