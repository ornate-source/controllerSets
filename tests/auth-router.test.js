import test from "node:test";
import assert from "node:assert";
import express from "express";
import mongoose from "mongoose";
import { AUTH_ROUTES, createAuthRouter, errorHandler } from "../src/index.js";
import { withServer } from "./helpers/mockModel.js";

// Mounting: which URLs exist, what runs in front of them, and which ones you
// can leave out. The flows themselves are covered in auth.test.js.

let MongoMemoryServer;
try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
} catch {
    MongoMemoryServer = null;
}

const SECRET = "router-secret-long-enough-for-hmac-32";
const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

test(
    "Auth router",
    { skip: MongoMemoryServer ? false : "mongodb-memory-server not installed" },
    async (t) => {
        const mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());

        t.after(async () => {
            await mongoose.disconnect();
            await mongod.stop();
        });

        const User = mongoose.model(
            "RouterUser",
            new mongoose.Schema({
                email: { type: String, unique: true, sparse: true },
                password: { type: String, select: false },
                role: { type: String, default: "user" },
                failedLoginAttempts: { type: Number, default: 0, select: false },
                lockedUntil: { type: Date, select: false },
                passwordChangedAt: Date,
                sessions: { type: [{ id: String, hash: String, expiresAt: Date }], select: false },
            }),
        );
        await User.init();

        const build = (options = {}) =>
            createAuthRouter({
                model: User,
                logger: silentLogger,
                token: { secret: SECRET },
                ...options,
            });

        const mount = (router) => {
            const app = express();
            app.use(express.json());
            app.use("/auth", router);
            app.use(errorHandler);
            return app;
        };

        const call = async (base, method, path, body) => {
            const res = await fetch(`${base}${path}`, {
                method,
                headers: { "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        };

        await t.test("reports the URLs it mounted", () => {
            const router = build();

            // Refresh is opt-in, so its three endpoints are in the catalogue
            // but not on a router that did not ask for them.
            assert.strictEqual(router.urls.length, AUTH_ROUTES.length - 3);
            assert.ok(!router.urls.some((u) => u.name === "refresh"));
            assert.deepStrictEqual(router.urls[0], {
                name: "register",
                method: "POST",
                path: "/register",
                access: "public",
            });

            // Every row says who may reach it — there is no unclassified route.
            assert.ok(
                router.urls.every((url) =>
                    ["public", "authenticated", "admin"].includes(url.access),
                ),
            );
            assert.deepStrictEqual(
                router.urls.filter((u) => u.access === "admin").map((u) => u.name),
                ["listUsers", "modifyRoles"],
            );
        });

        await t.test("refresh endpoints appear only when refresh is enabled", () => {
            const off = build();
            const on = build({
                refresh: { enabled: true },
                // The schema needs somewhere to keep sessions.
                fields: { refreshTokens: "sessions" },
            });

            for (const name of ["refresh", "logout", "logoutAll"]) {
                assert.ok(!off.urls.some((u) => u.name === name), `${name} off`);
                assert.ok(on.urls.some((u) => u.name === name), `${name} on`);
            }
            assert.strictEqual(on.urls.length, AUTH_ROUTES.length);
        });

        await t.test("the exported table describes what can be mounted", () => {
            assert.ok(AUTH_ROUTES.length >= 11);
            assert.ok(Object.isFrozen(AUTH_ROUTES));
            assert.ok(AUTH_ROUTES.some((r) => r.name === "login" && r.path === "/login"));
        });

        await t.test("routes can be renamed", async () => {
            const router = build({
                routes: { register: "/signup", login: "/signin", me: "/whoami" },
            });

            assert.deepStrictEqual(
                router.urls.filter((u) => ["register", "login", "me"].includes(u.name)).map(
                    (u) => u.path,
                ),
                ["/signup", "/signin", "/whoami"],
            );

            await withServer(mount(router), async (base) => {
                const created = await call(base, "POST", "/auth/signup", {
                    email: "renamed@example.com",
                    password: "a long enough password",
                });
                assert.strictEqual(created.status, 201);

                const signedIn = await call(base, "POST", "/auth/signin", {
                    identifier: "renamed@example.com",
                    password: "a long enough password",
                });
                assert.strictEqual(signedIn.status, 200);

                // The default path is gone, not merely aliased.
                const old = await call(base, "POST", "/auth/login", {
                    identifier: "renamed@example.com",
                    password: "a long enough password",
                });
                assert.strictEqual(old.status, 404);
            });
        });

        await t.test("routes can be left out", async () => {
            const baseline = build().urls.length;
            const router = build({ routes: { social: false, listUsers: false, modifyRoles: false } });

            assert.ok(!router.urls.some((u) => u.name === "social"));
            assert.strictEqual(router.urls.length, baseline - 3);

            await withServer(mount(router), async (base) => {
                const social = await call(base, "POST", "/auth/social/google", { idToken: "x" });
                assert.strictEqual(social.status, 404);

                // What remains still works.
                const created = await call(base, "POST", "/auth/register", {
                    email: "trimmed@example.com",
                    password: "a long enough password",
                });
                assert.strictEqual(created.status, 201);
            });
        });

        await t.test("an unknown route name is caught at startup, not at runtime", () => {
            assert.throws(() => build({ routes: { loginn: "/login" } }), /unknown route 'loginn'/);
            assert.throws(() => build({ routes: { loginn: "/login" } }), /Known routes/);
        });

        await t.test("middlewares apply to every route, as on createRouter", async () => {
            const seen = [];
            const router = build({
                middlewares: [
                    (req, _res, next) => {
                        seen.push(req.path);
                        next();
                    },
                ],
            });

            await withServer(mount(router), async (base) => {
                await call(base, "POST", "/auth/register", {
                    email: "mw@example.com",
                    password: "a long enough password",
                });
                await call(base, "GET", "/auth/me");
            });

            assert.deepStrictEqual(seen, ["/register", "/me"]);
        });

        await t.test("middlewares can target one route by name", async () => {
            let limited = 0;
            const router = build({
                middlewares: {
                    all: [(_req, _res, next) => next()],
                    // A limiter belongs on the endpoints that get guessed at,
                    // not on every read of /me.
                    login: [
                        (_req, res, next) => {
                            limited += 1;
                            if (limited > 2) {
                                return res.status(429).json({ success: false, error: "Slow down." });
                            }
                            next();
                        },
                    ],
                },
            });

            await withServer(mount(router), async (base) => {
                await call(base, "POST", "/auth/register", {
                    email: "throttled@example.com",
                    password: "a long enough password",
                });
                assert.strictEqual(limited, 0, "register is untouched");

                for (let i = 0; i < 2; i += 1) {
                    const res = await call(base, "POST", "/auth/login", {
                        identifier: "throttled@example.com",
                        password: "a long enough password",
                    });
                    assert.strictEqual(res.status, 200);
                }

                const blocked = await call(base, "POST", "/auth/login", {
                    identifier: "throttled@example.com",
                    password: "a long enough password",
                });
                assert.strictEqual(blocked.status, 429);
                assert.strictEqual(blocked.body.error, "Slow down.");

                // Other routes are unaffected by the limiter.
                assert.strictEqual((await call(base, "GET", "/auth/me")).status, 401);
            });
        });

        await t.test("route middleware runs before the guard", async () => {
            const order = [];
            const router = build({
                middlewares: {
                    me: [
                        (_req, _res, next) => {
                            order.push("middleware");
                            next();
                        },
                    ],
                },
            });

            await withServer(mount(router), async (base) => {
                const res = await call(base, "GET", "/auth/me");
                assert.strictEqual(res.status, 401, "the guard still refuses");
            });

            assert.deepStrictEqual(order, ["middleware"]);
        });

        await t.test("the guards are still attached to a customised router", () => {
            const router = build({ routes: { social: false } });

            assert.strictEqual(typeof router.requireAuth, "function");
            assert.strictEqual(typeof router.requireRole, "function");
            assert.strictEqual(typeof router.requireRole("admin"), "function");
            assert.strictEqual(router.config.model, User);
        });

        await t.test("mounting anywhere works, since paths are relative", async () => {
            const app = express();
            app.use(express.json());
            app.use("/api/v2/identity", build());
            app.use(errorHandler);

            await withServer(app, async (base) => {
                const res = await call(base, "POST", "/api/v2/identity/register", {
                    email: "mounted@example.com",
                    password: "a long enough password",
                });
                assert.strictEqual(res.status, 201);
            });
        });
    },
);
