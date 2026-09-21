import test from "node:test";
import assert from "node:assert";
import express from "express";
import mongoose from "mongoose";
import { buildAuthConfig, createAuthRouter, errorHandler } from "../src/index.js";
import { withServer } from "./helpers/mockModel.js";

// Refresh tokens: issuing, spending, rotating, reuse detection and sign-out.

let MongoMemoryServer;
try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
} catch {
    MongoMemoryServer = null;
}

const SECRET = "refresh-secret-long-enough-for-hmac-32";
const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const withEnv = (vars, fn) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
        return fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
};

test(
    "Auth refresh tokens",
    { skip: MongoMemoryServer ? false : "mongodb-memory-server not installed" },
    async (t) => {
        const mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());

        t.after(async () => {
            await mongoose.disconnect();
            await mongod.stop();
        });

        const User = mongoose.model(
            "RefreshUser",
            new mongoose.Schema({
                email: { type: String, unique: true, sparse: true },
                password: { type: String, select: false },
                role: { type: String, default: "user" },
                failedLoginAttempts: { type: Number, default: 0, select: false },
                lockedUntil: { type: Date, select: false },
                passwordChangedAt: Date,
                refreshTokens: {
                    type: [
                        {
                            id: String,
                            hash: String,
                            previousHash: String,
                            rotatedAt: Date,
                            createdAt: Date,
                            lastUsedAt: Date,
                            expiresAt: Date,
                            userAgent: String,
                        },
                    ],
                    select: false,
                },
            }),
        );
        await User.init();

        const app = (refresh) => {
            const router = createAuthRouter({
                model: User,
                logger: silentLogger,
                token: { secret: SECRET },
                refresh: { enabled: true, ...refresh },
            });
            const server = express();
            server.use(express.json());
            server.use("/auth", router);
            server.use(errorHandler);
            return server;
        };

        const call = async (base, method, path, body, token) => {
            const res = await fetch(`${base}${path}`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        };

        let n = 0;
        const signUp = async (base) => {
            const credentials = { identifier: `u${++n}@example.com`, password: "a-good-password" };
            const res = await call(base, "POST", "/auth/register", {
                email: credentials.identifier,
                password: credentials.password,
            });
            assert.strictEqual(res.status, 201, JSON.stringify(res.body));
            return { credentials, session: res.body.data };
        };

        const sessionCount = async (email) =>
            (await User.findOne({ email }).select("+refreshTokens").lean()).refreshTokens.length;

        await t.test("sign-in returns a refresh token alongside the access token", async () => {
            await withServer(app(), async (base) => {
                const { session } = await signUp(base);

                assert.ok(session.token);
                assert.strictEqual(typeof session.refreshToken, "string");
                assert.strictEqual(session.refreshExpiresIn, 30 * 24 * 3600);
                assert.ok(!("refreshTokens" in session.user));
            });
        });

        await t.test("a new sign-in keeps the other sessions", async () => {
            await withServer(app(), async (base) => {
                const { credentials, session } = await signUp(base);
                await call(base, "POST", "/auth/login", credentials);
                await call(base, "POST", "/auth/login", credentials);

                assert.strictEqual(await sessionCount(credentials.identifier), 3);

                const first = await call(base, "POST", "/auth/token/refresh", {
                    refreshToken: session.refreshToken,
                });
                assert.strictEqual(first.status, 200);
            });
        });

        await t.test("sessions are capped at maxSessions", async () => {
            await withServer(app({ maxSessions: 2 }), async (base) => {
                const { credentials, session } = await signUp(base);
                await call(base, "POST", "/auth/login", credentials);
                await call(base, "POST", "/auth/login", credentials);

                assert.strictEqual(await sessionCount(credentials.identifier), 2);
                const oldest = await call(base, "POST", "/auth/token/refresh", {
                    refreshToken: session.refreshToken,
                });
                assert.strictEqual(oldest.status, 401);
            });
        });

        await t.test("with rotation, refreshing issues a new token", async () => {
            await withServer(app({ rotate: true }), async (base) => {
                const { session } = await signUp(base);

                const res = await call(base, "POST", "/auth/token/refresh", {
                    refreshToken: session.refreshToken,
                });
                assert.strictEqual(res.status, 200);
                assert.ok(res.body.data.token);
                assert.notStrictEqual(res.body.data.refreshToken, session.refreshToken);

                const again = await call(base, "POST", "/auth/token/refresh", {
                    refreshToken: res.body.data.refreshToken,
                });
                assert.strictEqual(again.status, 200);
            });
        });

        await t.test("replaying a rotated-away token revokes every session", async () => {
            await withServer(app({ rotate: true, graceSeconds: 0 }), async (base) => {
                const { credentials, session } = await signUp(base);
                const other = (await call(base, "POST", "/auth/login", credentials)).body.data;

                const rotated = await call(base, "POST", "/auth/token/refresh", {
                    refreshToken: session.refreshToken,
                });
                assert.strictEqual(rotated.status, 200);

                const replay = await call(base, "POST", "/auth/token/refresh", {
                    refreshToken: session.refreshToken,
                });
                assert.strictEqual(replay.status, 401);

                for (const token of [rotated.body.data.refreshToken, other.refreshToken]) {
                    const res = await call(base, "POST", "/auth/token/refresh", {
                        refreshToken: token,
                    });
                    assert.strictEqual(res.status, 401);
                }
            });
        });

        await t.test("a racing replay inside the grace window is accepted", async () => {
            await withServer(app({ rotate: true, graceSeconds: 30 }), async (base) => {
                const { session } = await signUp(base);
                const body = { refreshToken: session.refreshToken };

                assert.strictEqual((await call(base, "POST", "/auth/token/refresh", body)).status, 200);
                assert.strictEqual((await call(base, "POST", "/auth/token/refresh", body)).status, 200);
            });
        });

        await t.test("without rotation, the same token keeps working", async () => {
            await withServer(app({ rotate: false }), async (base) => {
                const { session } = await signUp(base);
                const body = { refreshToken: session.refreshToken };

                for (let i = 0; i < 3; i++) {
                    const res = await call(base, "POST", "/auth/token/refresh", body);
                    assert.strictEqual(res.status, 200);
                    assert.strictEqual(res.body.data.refreshToken, session.refreshToken);
                }
            });
        });

        await t.test("garbage and tampered tokens are a 401", async () => {
            await withServer(app(), async (base) => {
                const { session } = await signUp(base);
                const tampered = session.refreshToken.slice(0, -2) + "xx";

                for (const refreshToken of ["nope", "a.b.c", tampered, 42, undefined]) {
                    const res = await call(base, "POST", "/auth/token/refresh", { refreshToken });
                    assert.strictEqual(res.status, 401, String(refreshToken));
                }
            });
        });

        await t.test("logout ends that session only", async () => {
            await withServer(app(), async (base) => {
                const { credentials, session } = await signUp(base);
                const other = (await call(base, "POST", "/auth/login", credentials)).body.data;

                const out = await call(base, "POST", "/auth/logout", {
                    refreshToken: session.refreshToken,
                });
                assert.strictEqual(out.status, 200);

                const dead = await call(base, "POST", "/auth/token/refresh", {
                    refreshToken: session.refreshToken,
                });
                assert.strictEqual(dead.status, 401);

                const alive = await call(base, "POST", "/auth/token/refresh", {
                    refreshToken: other.refreshToken,
                });
                assert.strictEqual(alive.status, 200);
            });
        });

        await t.test("logout/all ends every session", async () => {
            await withServer(app(), async (base) => {
                const { credentials, session } = await signUp(base);
                await call(base, "POST", "/auth/login", credentials);

                const out = await call(base, "POST", "/auth/logout/all", undefined, session.token);
                assert.strictEqual(out.status, 200);
                assert.strictEqual(await sessionCount(credentials.identifier), 0);
            });
        });

        await t.test("changing the password revokes refresh tokens", async () => {
            await withServer(app(), async (base) => {
                const { credentials, session } = await signUp(base);

                const changed = await call(
                    base,
                    "POST",
                    "/auth/password/change",
                    { currentPassword: credentials.password, newPassword: "another-good-password" },
                    session.token,
                );
                assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));

                const res = await call(base, "POST", "/auth/token/refresh", {
                    refreshToken: session.refreshToken,
                });
                assert.strictEqual(res.status, 401);
            });
        });

        await t.test("AUTH_REFRESH_ROTATE and AUTH_REFRESH_ENABLED come from the environment", () => {
            const build = (refresh) =>
                buildAuthConfig({ model: User, token: { secret: SECRET }, refresh });

            withEnv({ AUTH_REFRESH_ENABLED: "true", AUTH_REFRESH_ROTATE: "false" }, () => {
                const config = build(undefined);
                assert.strictEqual(config.refresh.enabled, true);
                assert.strictEqual(config.refresh.rotate, false);
                // Explicit options still win.
                assert.strictEqual(build({ rotate: true }).refresh.rotate, true);
            });

            withEnv({ AUTH_REFRESH_ENABLED: "true", AUTH_REFRESH_ROTATE: "" }, () => {
                assert.strictEqual(build(undefined).refresh.rotate, true);
            });

            withEnv({ AUTH_REFRESH_ENABLED: "true", AUTH_REFRESH_ROTATE: "maybe" }, () => {
                assert.throws(() => build(undefined), /AUTH_REFRESH_ROTATE must be true or false/);
            });
        });
    },
);
