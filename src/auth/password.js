import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

// scrypt ships with Node, so a password is hashed correctly with no dependency
// to install, audit or keep current. The cost parameters are encoded into every
// hash, which is what lets them be raised later without invalidating the hashes
// already stored.
const DEFAULT_COST = { N: 16384, r: 8, p: 1, keyLength: 64 };
const SALT_BYTES = 16;

// Long inputs cost CPU to hash and buy nothing: a passphrase past this length is
// already far beyond what the KDF can be strengthened to protect.
export const MAX_PASSWORD_LENGTH = 256;

const encode = (parts) => parts.join("$");

export const hashPassword = async (plain, cost = DEFAULT_COST) => {
    const salt = randomBytes(SALT_BYTES);
    const derived = await scrypt(plain, salt, cost.keyLength, {
        N: cost.N,
        r: cost.r,
        p: cost.p,
        maxmem: 256 * cost.N * cost.r,
    });

    return encode([
        "scrypt",
        cost.N,
        cost.r,
        cost.p,
        salt.toString("base64url"),
        derived.toString("base64url"),
    ]);
};

const parse = (stored) => {
    if (typeof stored !== "string") return null;

    const [scheme, N, r, p, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !hash) return null;

    const cost = { N: Number(N), r: Number(r), p: Number(p) };
    if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) {
        return null;
    }

    return { cost, salt: Buffer.from(salt, "base64url"), hash: Buffer.from(hash, "base64url") };
};

/**
 * Verifies a password. Returns false rather than throwing for anything
 * malformed, so a corrupt stored value is a failed login and not a 500.
 */
export const verifyPassword = async (plain, stored) => {
    const parsed = parse(stored);
    if (!parsed || typeof plain !== "string" || plain.length > MAX_PASSWORD_LENGTH) return false;

    try {
        const derived = await scrypt(plain, parsed.salt, parsed.hash.length, {
            N: parsed.cost.N,
            r: parsed.cost.r,
            p: parsed.cost.p,
            maxmem: 256 * parsed.cost.N * parsed.cost.r,
        });
        return timingSafeEqual(derived, parsed.hash);
    } catch {
        return false;
    }
};

// A real hash to verify against when the account does not exist. Without it an
// unknown identifier answers in a fraction of the time a known one does, and
// that difference alone enumerates your users.
let decoyPromise = null;

export const verifyAgainstDecoy = async (plain) => {
    decoyPromise ??= hashPassword(randomBytes(32).toString("base64url"));
    await verifyPassword(typeof plain === "string" ? plain : "", await decoyPromise);
    return false;
};
