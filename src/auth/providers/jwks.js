import { createPublicKey, createVerify } from "node:crypto";
import { HttpError } from "../../utils/sanitize.js";

// RS256 identity tokens (Google, Apple), verified against the provider's
// published keys.
//
// The signature is checked before a single claim is believed. A provider's
// token is an assertion by that provider, and an unverified one is just a
// string the client typed.

const JWKS_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

const fetchKeys = async (url) => {
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) return cached.keys;

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
        throw new HttpError(503, "Could not reach the identity provider.");
    }

    const body = await response.json();
    const keys = Array.isArray(body?.keys) ? body.keys : [];
    cache.set(url, { keys, expires: Date.now() + JWKS_TTL_MS });
    return keys;
};

const decodeSegment = (segment) => {
    try {
        return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    } catch {
        throw new HttpError(401, "Malformed identity token.");
    }
};

/**
 * Verifies an RS256 identity token and returns its claims.
 *
 * @param {object} expect `{ issuers, audience, jwksUrl }`
 */
export const verifyIdentityToken = async (token, { issuers, audience, jwksUrl }) => {
    if (typeof token !== "string" || token.split(".").length !== 3) {
        throw new HttpError(401, "Malformed identity token.");
    }

    const [rawHeader, rawPayload, rawSignature] = token.split(".");
    const header = decodeSegment(rawHeader);

    // Only RS256, and only from this provider's key set: accepting the header's
    // word on the algorithm is how `alg: none` and HS/RS confusion get in.
    if (header.alg !== "RS256" || !header.kid) {
        throw new HttpError(401, "Unsupported identity token algorithm.");
    }

    const keys = await fetchKeys(jwksUrl);
    const jwk = keys.find((key) => key.kid === header.kid && (key.kty ?? "RSA") === "RSA");
    if (!jwk) throw new HttpError(401, "Identity token was signed with an unknown key.");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${rawHeader}.${rawPayload}`);
    verifier.end();

    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    if (!verifier.verify(publicKey, Buffer.from(rawSignature, "base64url"))) {
        throw new HttpError(401, "Identity token signature is invalid.");
    }

    const claims = decodeSegment(rawPayload);
    const now = Math.floor(Date.now() / 1000);

    if (typeof claims.exp !== "number" || claims.exp < now - 5) {
        throw new HttpError(401, "Identity token has expired.");
    }
    if (!issuers.includes(claims.iss)) {
        throw new HttpError(401, "Identity token came from an unexpected issuer.");
    }
    // Without this check any app's Google token would log a user into yours.
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) {
        throw new HttpError(401, "Identity token was issued for another application.");
    }
    if (!claims.sub) throw new HttpError(401, "Identity token carries no subject.");

    return claims;
};

/** Testing seam: drop cached provider keys. */
export const clearJwksCache = () => cache.clear();
