import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../utils/sanitize.js";

// HS256 JWTs, signed and verified here rather than by a dependency.
//
// One algorithm, hard-coded, is the point: every practical JWT vulnerability —
// `alg: none`, RS256-to-HS256 confusion, key-type juggling — starts with a
// library reading the algorithm out of the token it is about to trust. This
// reads nothing from the header.

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

/** Shorter than this and the HMAC is the weak link rather than the password. */
export const MIN_SECRET_LENGTH = 32;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (data, secret) => createHmac("sha256", secret).update(data).digest("base64url");

/** `"15m"`, `"7d"`, `900` → seconds. */
export const durationToSeconds = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
    if (typeof value !== "string") return null;

    const match = /^(\d+)\s*(s|m|h|d)?$/.exec(value.trim());
    if (!match) return null;

    const units = { s: 1, m: 60, h: 3600, d: 86400 };
    return Number(match[1]) * units[match[2] ?? "s"];
};

export const signToken = (claims, { secret, expiresIn, issuer, audience }) => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = {
        ...claims,
        iat: issuedAt,
        exp: issuedAt + durationToSeconds(expiresIn),
    };
    if (issuer) payload.iss = issuer;
    if (audience) payload.aud = audience;

    const body = `${HEADER}.${b64(payload)}`;
    return `${body}.${sign(body, secret)}`;
};

const invalid = () => new HttpError(401, "Invalid or expired token.");

export const verifyToken = (token, { secret, issuer, audience, clockToleranceSeconds = 5 }) => {
    if (typeof token !== "string") throw invalid();

    const parts = token.split(".");
    if (parts.length !== 3) throw invalid();

    const [header, body, signature] = parts;
    // The header is compared, never parsed: there is nothing in it this
    // verifier is willing to be told.
    if (header !== HEADER) throw invalid();

    const expected = Buffer.from(sign(`${header}.${body}`, secret), "base64url");
    const actual = Buffer.from(signature, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();

    let claims;
    try {
        claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        throw invalid();
    }
    if (!claims || typeof claims !== "object") throw invalid();

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || now > claims.exp + clockToleranceSeconds) throw invalid();
    if (typeof claims.nbf === "number" && now + clockToleranceSeconds < claims.nbf) throw invalid();
    if (issuer && claims.iss !== issuer) throw invalid();
    if (audience && claims.aud !== audience) throw invalid();

    return claims;
};
