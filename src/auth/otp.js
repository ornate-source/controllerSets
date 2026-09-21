import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

// One-time codes.
//
// A six-digit code is one of a million, which a rainbow table covers instantly
// and a script guesses in minutes. Two things make it safe to use anyway: the
// stored value is an HMAC under the server secret rather than the code itself,
// and every purpose has a short expiry and a hard attempt limit.

export const generateOtp = (length) => {
    let code = "";
    for (let i = 0; i < length; i += 1) code += String(randomInt(0, 10));
    return code;
};

/** Keyed by the server secret, and bound to a purpose so a reset code cannot verify a login. */
export const hashOtp = (code, purpose, secret) =>
    createHmac("sha256", secret).update(`${purpose}:${code}`).digest("base64url");

export const otpMatches = (code, purpose, secret, storedHash) => {
    if (typeof code !== "string" || typeof storedHash !== "string" || storedHash === "") {
        return false;
    }

    const expected = Buffer.from(hashOtp(code, purpose, secret), "base64url");
    const actual = Buffer.from(storedHash, "base64url");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
};
