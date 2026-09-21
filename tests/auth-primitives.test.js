import test from "node:test";
import assert from "node:assert";
import { createHmac } from "node:crypto";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { durationToSeconds, signToken, verifyToken } from "../src/auth/token.js";
import { generateOtp, hashOtp, otpMatches } from "../src/auth/otp.js";
import { buildAuthConfig } from "../src/auth/config.js";
import { createMockModel } from "./helpers/mockModel.js";

// The primitives underneath the endpoints. Everything here is the part where a
// mistake is silent: a hash that verifies anything, a token that trusts its own
// header, a code that can be guessed.

const SECRET = "a".repeat(48);

test("Password hashing", async (t) => {
    await t.test("verifies the right password and rejects the wrong one", async () => {
        const stored = await hashPassword("correct horse battery staple");

        assert.ok(await verifyPassword("correct horse battery staple", stored));
        assert.ok(!(await verifyPassword("correct horse battery stapl", stored)));
        assert.ok(!(await verifyPassword("", stored)));
    });

    await t.test("salts, so identical passwords do not collide", async () => {
        const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);

        assert.notStrictEqual(a, b);
        assert.ok(await verifyPassword("same", a));
        assert.ok(await verifyPassword("same", b));
    });

    await t.test("stores its cost parameters, so they can be raised later", async () => {
        const stored = await hashPassword("x");
        const [scheme, N, r, p] = stored.split("$");

        assert.strictEqual(scheme, "scrypt");
        assert.deepStrictEqual([N, r, p], ["16384", "8", "1"]);

        // A hash written under weaker parameters still verifies.
        const weaker = await hashPassword("x", { N: 1024, r: 8, p: 1, keyLength: 64 });
        assert.ok(await verifyPassword("x", weaker));
    });

    await t.test("a corrupt stored value is a failed login, not a crash", async () => {
        for (const stored of ["", "not-a-hash", "scrypt$x$y$z$q$w", null, undefined, 42]) {
            assert.strictEqual(await verifyPassword("x", stored), false, String(stored));
        }
    });

    await t.test("an absurdly long password is refused rather than hashed", async () => {
        const stored = await hashPassword("x");
        assert.strictEqual(await verifyPassword("x".repeat(100_000), stored), false);
    });
});

test("Tokens", async (t) => {
    const options = { secret: SECRET, expiresIn: "15m", issuer: "api", audience: "app" };

    await t.test("round-trips its claims", () => {
        const token = signToken({ sub: "u1", role: "admin" }, options);
        const claims = verifyToken(token, options);

        assert.strictEqual(claims.sub, "u1");
        assert.strictEqual(claims.role, "admin");
        assert.strictEqual(claims.iss, "api");
        assert.strictEqual(claims.aud, "app");
        assert.ok(claims.exp > claims.iat);
    });

    await t.test("rejects a tampered payload", () => {
        const token = signToken({ sub: "u1", role: "user" }, options);
        const [header, , signature] = token.split(".");
        const forged = Buffer.from(JSON.stringify({ sub: "u1", role: "admin", exp: 9e9 })).toString(
            "base64url",
        );

        assert.throws(() => verifyToken(`${header}.${forged}.${signature}`, options), /Invalid/);
    });

    await t.test("rejects alg:none, the oldest JWT trick there is", () => {
        const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
            "base64url",
        );
        const payload = Buffer.from(JSON.stringify({ sub: "u1", exp: 9e9 })).toString("base64url");

        assert.throws(() => verifyToken(`${header}.${payload}.`, options), /Invalid/);
        assert.throws(() => verifyToken(`${header}.${payload}.x`, options), /Invalid/);
    });

    await t.test("rejects a token signed with another secret", () => {
        const token = signToken({ sub: "u1" }, { ...options, secret: "b".repeat(48) });
        assert.throws(() => verifyToken(token, options), /Invalid/);
    });

    await t.test("rejects an expired token", () => {
        const token = signToken({ sub: "u1" }, { ...options, expiresIn: 1 });
        const claims = verifyToken(token, options);
        assert.ok(claims.exp);

        // Re-sign with an expiry in the past rather than waiting for one.
        const expired = signToken({ sub: "u1", exp: 1 }, { ...options, expiresIn: -3600 });
        assert.throws(() => verifyToken(expired, options), /Invalid/);
    });

    await t.test("rejects another issuer or audience", () => {
        const token = signToken({ sub: "u1" }, options);

        assert.throws(() => verifyToken(token, { ...options, issuer: "other" }), /Invalid/);
        assert.throws(() => verifyToken(token, { ...options, audience: "other" }), /Invalid/);
    });

    await t.test("rejects structural nonsense", () => {
        for (const token of ["", "a.b", "a.b.c.d", "....", null, 7, "a.b.c"]) {
            assert.throws(() => verifyToken(token, options), /Invalid/, String(token));
        }
    });

    await t.test("parses durations", () => {
        assert.strictEqual(durationToSeconds("30s"), 30);
        assert.strictEqual(durationToSeconds("15m"), 900);
        assert.strictEqual(durationToSeconds("2h"), 7200);
        assert.strictEqual(durationToSeconds("7d"), 604800);
        assert.strictEqual(durationToSeconds(120), 120);
        assert.strictEqual(durationToSeconds("soon"), null);
    });
});

test("One-time codes", async (t) => {
    await t.test("are the requested length and numeric", () => {
        for (let i = 0; i < 50; i += 1) {
            const code = generateOtp(6);
            assert.match(code, /^\d{6}$/);
        }
        assert.strictEqual(generateOtp(8).length, 8);
    });

    await t.test("are not stored in the clear", () => {
        const hashed = hashOtp("123456", "password-reset", SECRET);

        assert.notStrictEqual(hashed, "123456");
        assert.ok(!hashed.includes("123456"));
        // Keyed by the server secret: a table of hashed six-digit codes is
        // useless without it.
        const unkeyed = createHmac("sha256", "").update("password-reset:123456").digest("base64url");
        assert.notStrictEqual(hashed, unkeyed);
    });

    await t.test("match only the same code, purpose and secret", () => {
        const stored = hashOtp("123456", "password-reset", SECRET);

        assert.ok(otpMatches("123456", "password-reset", SECRET, stored));
        assert.ok(!otpMatches("123457", "password-reset", SECRET, stored));
        assert.ok(!otpMatches("123456", "login", SECRET, stored), "purpose must bind");
        assert.ok(!otpMatches("123456", "password-reset", "z".repeat(48), stored));
        assert.ok(!otpMatches("123456", "password-reset", SECRET, ""));
        assert.ok(!otpMatches(null, "password-reset", SECRET, stored));
    });
});

test("Auth configuration", async (t) => {
    const model = createMockModel({ modelName: "User" });

    await t.test("refuses a weak or missing token secret", () => {
        assert.throws(() => buildAuthConfig({ model }), /token.secret/);
        assert.throws(() => buildAuthConfig({ model, token: { secret: "short" } }), /32 characters/);
    });

    await t.test("refuses an unparseable expiry", () => {
        assert.throws(
            () => buildAuthConfig({ model, token: { secret: SECRET, expiresIn: "soon" } }),
            /expiresIn/,
        );
    });

    await t.test("requires a model", () => {
        assert.throws(() => buildAuthConfig({ token: { secret: SECRET } }), /user model/);
    });

    await t.test("normalizes identifiers, with email and phone understood", () => {
        const config = buildAuthConfig({
            model,
            token: { secret: SECRET },
            identifiers: ["email", "phone", "username"],
        });

        const [email, phone, username] = config.identifiers;
        assert.strictEqual(email.normalize("  Ada@Example.COM "), "ada@example.com");
        assert.strictEqual(phone.normalize("+1 (555) 010-1234"), "+15550101234");
        assert.strictEqual(username.normalize("  ada  "), "ada");
    });

    await t.test("knows which fields may never be returned", () => {
        const config = buildAuthConfig({ model, token: { secret: SECRET } });

        for (const field of ["password", "otpHash", "otpExpiresAt", "lockedUntil"]) {
            assert.ok(config.secretFields.includes(field), field);
        }
    });
});
