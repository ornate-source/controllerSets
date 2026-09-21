import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";
import { HttpError } from "../utils/sanitize.js";

// Refresh tokens, and the sessions they belong to.
//
// A refresh token is opaque random bytes, not a JWT: it is long-lived, so it
// has to be revocable, and a signature alone cannot be taken back. What is
// stored is an HMAC of the secret half — a leaked database yields no usable
// token.
//
// The token carries the user and session it belongs to, so presenting one is a
// single indexed read rather than a scan:
//
//     <userId>.<sessionId>.<secret>
//     └ lookup ┘ └ lookup ┘ └ hashed, never stored ┘

const SESSION_ID_BYTES = 12;
const SECRET_BYTES = 32;

const hashSecret = (sessionId, secret, serverSecret) =>
    createHmac("sha256", serverSecret).update(`${sessionId}:${secret}`).digest("base64url");

const sameHash = (a, b) => {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

const invalid = () => new HttpError(401, "Invalid or expired refresh token.");

/** Mints a token for a brand-new session. */
export const mintRefreshToken = (userId, serverSecret) => {
    const sessionId = randomBytes(SESSION_ID_BYTES).toString("base64url");
    const secret = randomBytes(SECRET_BYTES).toString("base64url");

    return {
        token: `${Buffer.from(String(userId)).toString("base64url")}.${sessionId}.${secret}`,
        sessionId,
        hash: hashSecret(sessionId, secret, serverSecret),
    };
};

/** Mints a replacement secret for an existing session. */
export const rotateSecret = (userId, sessionId, serverSecret) => {
    const secret = randomBytes(SECRET_BYTES).toString("base64url");

    return {
        token: `${Buffer.from(String(userId)).toString("base64url")}.${sessionId}.${secret}`,
        hash: hashSecret(sessionId, secret, serverSecret),
    };
};

export const parseRefreshToken = (token, serverSecret) => {
    if (typeof token !== "string") throw invalid();

    const parts = token.split(".");
    if (parts.length !== 3) throw invalid();

    const [encodedUser, sessionId, secret] = parts;
    if (!encodedUser || !sessionId || !secret) throw invalid();

    const userId = Buffer.from(encodedUser, "base64url").toString("utf8");
    // Checked before it reaches the database: an id that cannot be one is not
    // worth a query, and a cast error here would be a 500 rather than a 401.
    if (!mongoose.Types.ObjectId.isValid(userId)) throw invalid();

    return { userId, sessionId, hash: hashSecret(sessionId, secret, serverSecret) };
};

/* ------------------------------------------------------------------ *
 * The session list on the user record
 * ------------------------------------------------------------------ */

const sessionsOf = (user, config) => {
    const list = user?.[config.fields.refreshTokens];
    return Array.isArray(list) ? list : [];
};

const plain = (session) =>
    typeof session?.toObject === "function" ? session.toObject() : { ...session };

/**
 * Opens a session, and keeps the list from growing without bound.
 *
 * Expired entries go, and the oldest go once `maxSessions` is reached: this
 * array lives inside the user document, and an unbounded one is a document
 * that eventually cannot be written. Both are done in the database rather than
 * on `user`, which was loaded without the session list and may be stale.
 */
export const openSession = async (user, config, meta = {}) => {
    const { token, sessionId, hash } = mintRefreshToken(user._id, config.token.secret);
    const now = new Date();
    const field = config.fields.refreshTokens;

    await config.model.updateOne(
        { _id: user._id },
        { $pull: { [field]: { expiresAt: { $lte: now } } } },
    );

    await config.model.updateOne(
        { _id: user._id },
        {
            $push: {
                [field]: {
                    $each: [
                        {
                            id: sessionId,
                            hash,
                            createdAt: now,
                            lastUsedAt: now,
                            expiresAt: new Date(now.getTime() + config.refresh.ttlSeconds * 1000),
                            userAgent:
                                typeof meta.userAgent === "string"
                                    ? meta.userAgent.slice(0, 200)
                                    : undefined,
                        },
                    ],
                    $sort: { createdAt: 1 },
                    $slice: -config.refresh.maxSessions,
                },
            },
        },
    );

    return token;
};

const revokeSession = (userId, sessionId, config) =>
    config.model.updateOne(
        { _id: userId },
        { $pull: { [config.fields.refreshTokens]: { id: sessionId } } },
    );

export const revokeAllSessions = (userId, config) =>
    config.model.updateOne({ _id: userId }, { $set: { [config.fields.refreshTokens]: [] } });

/**
 * Spends a refresh token.
 *
 * Returns the user and, when rotating, the replacement token. Every failure is
 * the same 401: which of them it was is not the presenter's business.
 */
export const useRefreshToken = async (rawToken, config) => {
    const { userId, sessionId, hash } = parseRefreshToken(rawToken, config.token.secret);

    const user = await config.model.findById(userId).select(`+${config.fields.refreshTokens}`);
    if (!user) throw invalid();

    const session = sessionsOf(user, config)
        .map(plain)
        .find((entry) => entry.id === sessionId);
    if (!session) throw invalid();

    const now = new Date();
    if (!(session.expiresAt instanceof Date) || session.expiresAt <= now) {
        await revokeSession(userId, sessionId, config);
        throw invalid();
    }

    const matchesCurrent = sameHash(session.hash, hash);

    // A token that was already rotated away is being replayed. Either it was
    // stolen, or the legitimate client is racing itself — the grace window
    // below tells those apart, and outside it the safe reading is theft.
    const withinGrace =
        !matchesCurrent &&
        sameHash(session.previousHash ?? "", hash) &&
        session.rotatedAt instanceof Date &&
        now.getTime() - session.rotatedAt.getTime() <= config.refresh.graceSeconds * 1000;

    if (!matchesCurrent && !withinGrace) {
        // Reuse. The session is gone, and by default so is every other one the
        // user has: if one token leaked, the attacker may hold others.
        if (config.refresh.revokeAllOnReuse) {
            await revokeAllSessions(userId, config);
        } else {
            await revokeSession(userId, sessionId, config);
        }
        config.logger.warn(
            `[Auth] Refresh token reuse detected for user ${userId}; sessions revoked.`,
        );
        throw invalid();
    }

    if (!config.refresh.rotate) {
        await config.model.updateOne(
            { _id: userId, [`${config.fields.refreshTokens}.id`]: sessionId },
            { $set: { [`${config.fields.refreshTokens}.$.lastUsedAt`]: now } },
        );
        return { user, refreshToken: rawToken };
    }

    const replacement = rotateSecret(userId, sessionId, config.token.secret);

    // Matched on the hash this request presented, so of two racing refreshes
    // only one rotates; the loser lands in the grace window rather than
    // tripping reuse detection.
    const result = await config.model.updateOne(
        {
            _id: userId,
            [config.fields.refreshTokens]: {
                $elemMatch: { id: sessionId, hash: session.hash },
            },
        },
        {
            $set: {
                [`${config.fields.refreshTokens}.$.hash`]: replacement.hash,
                [`${config.fields.refreshTokens}.$.previousHash`]: session.hash,
                [`${config.fields.refreshTokens}.$.rotatedAt`]: now,
                [`${config.fields.refreshTokens}.$.lastUsedAt`]: now,
                [`${config.fields.refreshTokens}.$.expiresAt`]: new Date(
                    now.getTime() + config.refresh.ttlSeconds * 1000,
                ),
            },
        },
    );

    if (result.matchedCount === 0) throw invalid();

    return { user, refreshToken: replacement.token };
};

/** Ends one session, given its token. Silent about tokens it does not recognise. */
export const closeSession = async (rawToken, config) => {
    try {
        const { userId, sessionId } = parseRefreshToken(rawToken, config.token.secret);
        await revokeSession(userId, sessionId, config);
    } catch {
        // Signing out is idempotent: an unknown token has already achieved it.
    }
};
