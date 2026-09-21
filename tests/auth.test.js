import test from "node:test";
import assert from "node:assert";
import express from "express";
import mongoose from "mongoose";
import { createAuthRouter, errorHandler, verifyToken } from "../src/index.js";
import { withServer } from "./helpers/mockModel.js";

// The endpoints, end to end, against a real MongoDB — because what matters here
// is what is actually written to and read from the user record: that a password
// never lands in a response, that a code cannot be reused, that a role cannot be
// granted by asking.

let MongoMemoryServer;
try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
} catch {
    MongoMemoryServer = null;
}

const SECRET = "test-secret-that-is-long-enough-to-pass-32";
const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

test(
    "Authentication",
    { skip: MongoMemoryServer ? false : "mongodb-memory-server not installed" },
    async (t) => {
        const mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());

        t.after(async () => {
            await mongoose.disconnect();
            await mongod.stop();
        });

        const userSchema = new mongoose.Schema(
            {
                email: { type: String, unique: true, sparse: true },
                phone: { type: String, unique: true, sparse: true },
                name: String,
                password: { type: String, select: false },
                role: { type: String, default: "user" },
                googleId: String,
                otpHash: { type: String, select: false },
                otpPurpose: { type: String, select: false },
                otpExpiresAt: { type: Date, select: false },
                otpAttempts: { type: Number, default: 0, select: false },
                failedLoginAttempts: { type: Number, default: 0, select: false },
                lockedUntil: { type: Date, select: false },
                passwordChangedAt: Date,
            },
            { timestamps: true },
        );
        const User = mongoose.model("AuthUser", userSchema);
        await User.init();

        const delivered = [];
        const buildApp = (options = {}) => {
            const app = express();
            app.use(express.json());
            app.use(
                "/auth",
                createAuthRouter({
                    model: User,
                    logger: silentLogger,
                    identifiers: ["email", "phone"],
                    token: { secret: SECRET, expiresIn: "15m", issuer: "test" },
                    roles: { list: ["user", "staff", "admin"], default: "user", admin: ["admin"] },
                    registerFields: ["name"],
                    updateFields: ["name"],
                    otp: {
                        length: 6,
                        ttlSeconds: 600,
                        maxAttempts: 3,
                        deliver: async (payload) => delivered.push(payload),
                    },
                    lockout: { maxAttempts: 3, lockSeconds: 900 },
                    ...options,
                }),
            );
            app.use(errorHandler);
            return app;
        };

        const app = buildApp();

        const call = async (base, method, path, body, token) => {
            const res = await fetch(`${base}/auth${path}`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        };

        /* ---------------- register ---------------- */

        await t.test("registers and returns a session, never the password", async () => {
            await withServer(app, async (base) => {
                const res = await call(base, "POST", "/register", {
                    email: "  Ada@Example.COM ",
                    password: "correct horse battery",
                    name: "Ada",
                    role: "admin", // not a field a registrant may choose
                });

                assert.strictEqual(res.status, 201);
                assert.strictEqual(res.body.data.user.email, "ada@example.com", "email normalized");
                assert.strictEqual(res.body.data.user.role, "user", "role cannot be self-assigned");
                assert.strictEqual(res.body.data.user.password, undefined);
                assert.ok(!JSON.stringify(res.body).includes("correct horse"));

                const claims = verifyToken(res.body.data.token, { secret: SECRET, issuer: "test" });
                assert.strictEqual(claims.sub, String(res.body.data.user._id));
            });
        });

        await t.test("stores a hash, not the password", async () => {
            const stored = await User.findOne({ email: "ada@example.com" }).select("+password");

            assert.notStrictEqual(stored.password, "correct horse battery");
            assert.match(stored.password, /^scrypt\$16384\$8\$1\$/);
        });

        await t.test("rejects a weak password and a missing identifier", async () => {
            await withServer(app, async (base) => {
                const weak = await call(base, "POST", "/register", {
                    email: "b@example.com",
                    password: "short",
                });
                assert.strictEqual(weak.status, 400);
                assert.match(weak.body.error, /at least 8 characters/);

                const anonymous = await call(base, "POST", "/register", {
                    password: "long enough password",
                });
                assert.strictEqual(anonymous.status, 400);
                assert.match(anonymous.body.error, /email or phone/);
            });
        });

        await t.test("a duplicate account is a 409 that names no field", async () => {
            await withServer(app, async (base) => {
                const res = await call(base, "POST", "/register", {
                    email: "ada@example.com",
                    password: "another password entirely",
                });

                assert.strictEqual(res.status, 409);
                assert.ok(!res.body.error.includes("email"));
            });
        });

        /* ---------------- login ---------------- */

        await t.test("logs in by email or by phone", async () => {
            await withServer(app, async (base) => {
                await call(base, "POST", "/register", {
                    phone: "+1 (555) 010-1234",
                    password: "phone user password",
                });

                const byPhone = await call(base, "POST", "/login", {
                    identifier: "+15550101234",
                    password: "phone user password",
                });
                assert.strictEqual(byPhone.status, 200);
                assert.ok(byPhone.body.data.token);

                // The same field accepts either identifier, formatted either way.
                const formatted = await call(base, "POST", "/login", {
                    identifier: "+1 555-010-1234",
                    password: "phone user password",
                });
                assert.strictEqual(formatted.status, 200);

                const byEmail = await call(base, "POST", "/login", {
                    identifier: "ADA@example.com",
                    password: "correct horse battery",
                });
                assert.strictEqual(byEmail.status, 200);
            });
        });

        await t.test("a wrong password and an unknown account answer the same", async () => {
            await withServer(app, async (base) => {
                const wrong = await call(base, "POST", "/login", {
                    identifier: "ada@example.com",
                    password: "not the password",
                });
                const unknown = await call(base, "POST", "/login", {
                    identifier: "nobody@example.com",
                    password: "not the password",
                });

                assert.strictEqual(wrong.status, 401);
                assert.strictEqual(unknown.status, 401);
                assert.strictEqual(wrong.body.error, unknown.body.error);
            });
        });

        await t.test("an object as a password is rejected, not interpreted", async () => {
            await withServer(app, async (base) => {
                const injected = await call(base, "POST", "/login", {
                    identifier: { $ne: null },
                    password: "anything",
                });
                assert.strictEqual(injected.status, 400);

                const operator = await call(base, "POST", "/login", {
                    identifier: "ada@example.com",
                    password: { $ne: null },
                });
                assert.strictEqual(operator.status, 400);
            });
        });

        await t.test("locks an account after repeated failures", async () => {
            await User.create({
                email: "locked@example.com",
                password: (await import("../src/auth/password.js")).hashPassword
                    ? await (await import("../src/auth/password.js")).hashPassword("right password")
                    : "x",
            });

            await withServer(app, async (base) => {
                for (let i = 0; i < 3; i += 1) {
                    const res = await call(base, "POST", "/login", {
                        identifier: "locked@example.com",
                        password: "wrong",
                    });
                    assert.strictEqual(res.status, 401);
                }

                // The right password now, and it still will not open.
                const locked = await call(base, "POST", "/login", {
                    identifier: "locked@example.com",
                    password: "right password",
                });
                assert.strictEqual(locked.status, 429);
                assert.match(locked.body.error, /Too many failed attempts/);
            });
        });

        /* ---------------- password reset by OTP ---------------- */

        await t.test("sends a code without revealing whether the account exists", async () => {
            delivered.length = 0;

            await withServer(app, async (base) => {
                const known = await call(base, "POST", "/password/forgot", {
                    identifier: "ada@example.com",
                });
                const unknown = await call(base, "POST", "/password/forgot", {
                    identifier: "nobody@example.com",
                });

                assert.strictEqual(known.status, 200);
                assert.strictEqual(unknown.status, 200);
                assert.strictEqual(known.body.message, unknown.body.message);
                assert.strictEqual(delivered.length, 1, "only the real account is delivered to");
                assert.match(delivered[0].code, /^\d{6}$/);
                assert.strictEqual(delivered[0].channel, "email");
            });
        });

        await t.test("the code is stored hashed, never in the clear", async () => {
            const stored = await User.findOne({ email: "ada@example.com" }).select("+otpHash");

            assert.ok(stored.otpHash);
            assert.notStrictEqual(stored.otpHash, delivered[0].code);
            assert.ok(!stored.otpHash.includes(delivered[0].code));
        });

        await t.test("a wrong code is counted, and the limit ends the attempt", async () => {
            await withServer(app, async (base) => {
                for (let i = 0; i < 3; i += 1) {
                    const res = await call(base, "POST", "/password/reset", {
                        identifier: "ada@example.com",
                        code: "000000",
                        newPassword: "attacker chosen password",
                    });
                    assert.strictEqual(res.status, 400);
                }

                // Attempts exhausted: even the real code is refused now.
                const real = await call(base, "POST", "/password/reset", {
                    identifier: "ada@example.com",
                    code: delivered[0].code,
                    newPassword: "attacker chosen password",
                });
                assert.strictEqual(real.status, 400);
            });
        });

        await t.test("the right code resets the password, once", async () => {
            delivered.length = 0;

            await withServer(app, async (base) => {
                await call(base, "POST", "/password/forgot", { identifier: "ada@example.com" });
                const { code } = delivered[0];

                const reset = await call(base, "POST", "/password/reset", {
                    identifier: "ada@example.com",
                    code,
                    newPassword: "a brand new password",
                });
                assert.strictEqual(reset.status, 200);

                const signedIn = await call(base, "POST", "/login", {
                    identifier: "ada@example.com",
                    password: "a brand new password",
                });
                assert.strictEqual(signedIn.status, 200);

                // The same code a second time is refused.
                const replay = await call(base, "POST", "/password/reset", {
                    identifier: "ada@example.com",
                    code,
                    newPassword: "yet another password",
                });
                assert.strictEqual(replay.status, 400);
            });
        });

        await t.test("an expired code is refused", async () => {
            delivered.length = 0;

            await withServer(app, async (base) => {
                await call(base, "POST", "/password/forgot", { identifier: "ada@example.com" });
                await User.updateOne(
                    { email: "ada@example.com" },
                    { $set: { otpExpiresAt: new Date(Date.now() - 1000) } },
                );

                const res = await call(base, "POST", "/password/reset", {
                    identifier: "ada@example.com",
                    code: delivered[0].code,
                    newPassword: "too late password",
                });
                assert.strictEqual(res.status, 400);
            });
        });

        /* ---------------- authenticated routes ---------------- */

        const signIn = async (base, identifier, password) => {
            const res = await call(base, "POST", "/login", { identifier, password });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            return res.body.data.token;
        };

        await t.test("/me needs a token, and a valid one", async () => {
            await withServer(app, async (base) => {
                const anonymous = await call(base, "GET", "/me");
                assert.strictEqual(anonymous.status, 401);

                const garbage = await call(base, "GET", "/me", undefined, "not.a.token");
                assert.strictEqual(garbage.status, 401);

                const token = await signIn(base, "ada@example.com", "a brand new password");
                const mine = await call(base, "GET", "/me", undefined, token);

                assert.strictEqual(mine.status, 200);
                assert.strictEqual(mine.body.data.email, "ada@example.com");
                assert.strictEqual(mine.body.data.password, undefined);
            });
        });

        await t.test("changing a password requires the current one", async () => {
            await withServer(app, async (base) => {
                const token = await signIn(base, "ada@example.com", "a brand new password");

                const wrong = await call(
                    base,
                    "POST",
                    "/password/change",
                    { currentPassword: "nope", newPassword: "changed password here" },
                    token,
                );
                assert.strictEqual(wrong.status, 401);

                const right = await call(
                    base,
                    "POST",
                    "/password/change",
                    {
                        currentPassword: "a brand new password",
                        newPassword: "changed password here",
                    },
                    token,
                );
                assert.strictEqual(right.status, 200);
            });
        });

        await t.test("a password change ends the sessions that predate it", async () => {
            await withServer(app, async (base) => {
                const token = await signIn(base, "ada@example.com", "changed password here");
                assert.strictEqual((await call(base, "GET", "/me", undefined, token)).status, 200);

                await User.updateOne(
                    { email: "ada@example.com" },
                    { $set: { passwordChangedAt: new Date(Date.now() + 1000) } },
                );

                const after = await call(base, "GET", "/me", undefined, token);
                assert.strictEqual(after.status, 401);
                assert.match(after.body.error, /Session ended/);

                await User.updateOne(
                    { email: "ada@example.com" },
                    { $set: { passwordChangedAt: new Date(Date.now() - 60_000) } },
                );
            });
        });

        /* ---------------- users and roles ---------------- */

        await t.test("only an admin may list users or change a role", async () => {
            const admin = await User.findOneAndUpdate(
                { email: "ada@example.com" },
                { $set: { role: "admin" } },
                { returnDocument: "after" },
            );
            const plain = await User.findOne({ phone: "+15550101234" });

            await withServer(app, async (base) => {
                const userToken = await signIn(base, "+15550101234", "phone user password");

                const refused = await call(base, "GET", "/users", undefined, userToken);
                assert.strictEqual(refused.status, 403);

                const escalate = await call(
                    base,
                    "PATCH",
                    `/users/${plain._id}/roles`,
                    { role: "admin" },
                    userToken,
                );
                assert.strictEqual(escalate.status, 403, "a user cannot promote themselves");

                const adminToken = await signIn(base, "ada@example.com", "changed password here");

                const list = await call(base, "GET", "/users", undefined, adminToken);
                assert.strictEqual(list.status, 200);
                assert.ok(Array.isArray(list.body.data));
                assert.ok(list.body.data.length >= 3);
                assert.ok(
                    list.body.data.every((u) => u.password === undefined && u.otpHash === undefined),
                    "no secrets in a user listing",
                );

                const promoted = await call(
                    base,
                    "PATCH",
                    `/users/${plain._id}/roles`,
                    { role: "staff" },
                    adminToken,
                );
                assert.strictEqual(promoted.status, 200);
                assert.strictEqual(promoted.body.data.role, "staff");

                const unknown = await call(
                    base,
                    "PATCH",
                    `/users/${plain._id}/roles`,
                    { role: "superuser" },
                    adminToken,
                );
                assert.strictEqual(unknown.status, 400);
                assert.match(unknown.body.error, /Unknown role/);

                const selfDemote = await call(
                    base,
                    "PATCH",
                    `/users/${admin._id}/roles`,
                    { role: "user" },
                    adminToken,
                );
                assert.strictEqual(selfDemote.status, 400, "an admin cannot lock themselves out");
            });
        });

        await t.test("paginates a user list", async () => {
            await withServer(app, async (base) => {
                const adminToken = await signIn(base, "ada@example.com", "changed password here");
                const page = await call(base, "GET", "/users?page=1&pageSize=2", undefined, adminToken);

                assert.strictEqual(page.status, 200);
                assert.strictEqual(page.body.data.length, 2);
                assert.strictEqual(page.body.pagination.pageSize, 2);
                assert.ok(page.body.pagination.totalRecords >= 3);
            });
        });

        await t.test("a user updates themselves, and no one else", async () => {
            const plain = await User.findOne({ phone: "+15550101234" });

            await withServer(app, async (base) => {
                const userToken = await signIn(base, "+15550101234", "phone user password");

                const mine = await call(
                    base,
                    "PATCH",
                    `/users/${plain._id}`,
                    { name: "Renamed", role: "admin", password: "hacked" },
                    userToken,
                );
                assert.strictEqual(mine.status, 200);
                assert.strictEqual(mine.body.data.name, "Renamed");
                assert.strictEqual(mine.body.data.role, "staff", "role is not updatable here");

                const stored = await User.findById(plain._id).select("+password");
                assert.ok(
                    await (
                        await import("../src/auth/password.js")
                    ).verifyPassword("phone user password", stored.password),
                    "password is not updatable here",
                );

                const someoneElse = await User.findOne({ email: "ada@example.com" });
                const theirs = await call(
                    base,
                    "PATCH",
                    `/users/${someoneElse._id}`,
                    { name: "Hijacked" },
                    userToken,
                );
                assert.strictEqual(theirs.status, 403);
            });
        });

        await t.test("fetches a single user without secrets", async () => {
            const plain = await User.findOne({ phone: "+15550101234" });

            await withServer(app, async (base) => {
                const token = await signIn(base, "+15550101234", "phone user password");
                const res = await call(base, "GET", `/users/${plain._id}`, undefined, token);

                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.body.data.password, undefined);
                assert.strictEqual(res.body.data.otpHash, undefined);

                const missing = await call(
                    base,
                    "GET",
                    `/users/${new mongoose.Types.ObjectId()}`,
                    undefined,
                    token,
                );
                assert.strictEqual(missing.status, 404);

                const malformed = await call(base, "GET", "/users/not-an-id", undefined, token);
                assert.strictEqual(malformed.status, 400);
            });
        });

        /* ---------------- social ---------------- */

        await t.test("an unconfigured provider has no endpoint", async () => {
            await withServer(app, async (base) => {
                const res = await call(base, "POST", "/social/google", { idToken: "x" });

                assert.strictEqual(res.status, 404);
                assert.match(res.body.error, /not enabled/);
            });
        });

        await t.test("a configured provider signs in and links by verified email", async () => {
            // The provider contract is one function; the built-ins verify with
            // Google and Apple over the network, and a stub proves the wiring.
            const social = buildApp({
                social: {
                    google: {
                        idField: "googleId",
                        verify: async (credential) => {
                            if (credential.idToken !== "good-token") {
                                throw Object.assign(new Error("bad token"), { status: 401 });
                            }
                            return { id: "google-123", email: "ada@example.com", name: "Ada" };
                        },
                    },
                },
            });

            await withServer(social, async (base) => {
                const res = await call(base, "POST", "/social/google", { idToken: "good-token" });

                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.body.data.provider, "google");
                assert.strictEqual(res.body.data.user.email, "ada@example.com");
                assert.ok(res.body.data.token);

                // Linked to the account that already existed, not a duplicate.
                const linked = await User.findOne({ email: "ada@example.com" });
                assert.strictEqual(linked.googleId, "google-123");
                assert.strictEqual(await User.countDocuments({ email: "ada@example.com" }), 1);
            });
        });

        await t.test("a new social identity creates an account", async () => {
            const social = buildApp({
                social: {
                    google: {
                        verify: async () => ({
                            id: "google-999",
                            email: "newcomer@example.com",
                            name: "Newcomer",
                        }),
                    },
                },
            });

            await withServer(social, async (base) => {
                const res = await call(base, "POST", "/social/google", { idToken: "x" });

                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.body.data.user.email, "newcomer@example.com");
                assert.strictEqual(res.body.data.user.role, "user");

                const stored = await User.findOne({ email: "newcomer@example.com" }).select(
                    "+password",
                );
                assert.strictEqual(stored.googleId, "google-999");
                assert.strictEqual(stored.password, undefined, "no password for a social account");
            });
        });
    },
);
