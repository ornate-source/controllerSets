import test from "node:test";
import assert from "node:assert";
import express from "express";
import mongoose from "mongoose";
import { createRouter, errorHandler } from "../src/index.js";
import { withServer } from "./helpers/mockModel.js";

/**
 * Integration tests against a real MongoDB instance.
 *
 * The unit tests assert on the filter objects the controller builds, which proves
 * intent but not outcome — they cannot show how Mongoose casts those filters or
 * how the driver executes them. These close that gap.
 *
 * Skipped when `mongodb-memory-server` is unavailable so the suite still runs
 * offline; CI installs it.
 */
let MongoMemoryServer;
try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
} catch {
    MongoMemoryServer = null;
}

const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

test(
    "Integration: real Mongoose + MongoDB",
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
                name: String,
                email: { type: String, unique: true },
                password: String,
                role: { type: String, default: "user" },
                age: Number,
                tag: String,
            },
            { timestamps: true },
        );

        // A transform is the common way to strip secrets from responses. `.lean()`
        // bypasses it entirely, which is why reads are no longer lean by default.
        userSchema.set("toJSON", {
            transform: (doc, ret) => {
                delete ret.password;
                return ret;
            },
        });

        const User = mongoose.model("User", userSchema);
        await User.init(); // build the unique index before testing 11000

        const buildApp = (options) => {
            const app = express();
            app.use(express.json());
            app.use("/users", createRouter({ model: User, logger: silentLogger, ...options }));
            app.use(errorHandler);
            return app;
        };

        await t.test("C1: role cannot be escalated through create", async () => {
            const app = buildApp({ allowedFields: ["name", "email", "age"] });

            await withServer(app, async (base) => {
                const res = await fetch(`${base}/users`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: "Mallory",
                        email: "mallory@example.com",
                        role: "admin",
                    }),
                });
                assert.strictEqual(res.status, 201);

                // Read straight from the database, bypassing the API's own shaping.
                const stored = await User.findOne({ email: "mallory@example.com" }).lean();
                assert.strictEqual(stored.role, "user");
            });
        });

        await t.test("C1: dotted and operator keys do not write through $set", async () => {
            const user = await User.create({ name: "Bob", email: "bob@example.com", role: "user" });
            const app = buildApp({ allowedFields: ["name"] });

            await withServer(app, async (base) => {
                const res = await fetch(`${base}/users/${user._id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: "Bobby",
                        role: "admin",
                        $set: { role: "admin" },
                        "profile.role": "admin",
                    }),
                });
                assert.strictEqual(res.status, 200);

                const stored = await User.findById(user._id).lean();
                assert.strictEqual(stored.name, "Bobby");
                assert.strictEqual(stored.role, "user");
            });
        });

        await t.test("H1: escaped search matches literally in MongoDB", async () => {
            await User.create([
                { name: "a+b", email: "plus@example.com" },
                { name: "aaaaaaaa", email: "aaa@example.com" },
            ]);
            const app = buildApp({ search: ["name"] });

            await withServer(app, async (base) => {
                // The literal string is found...
                const literal = await (
                    await fetch(`${base}/users?s=${encodeURIComponent("a+b")}`)
                ).json();
                assert.deepStrictEqual(
                    literal.data.map((u) => u.name),
                    ["a+b"],
                );

                // ...while the same input read as a pattern would have matched "aaaaaaaa".
                const pattern = await (
                    await fetch(`${base}/users?s=${encodeURIComponent("(a+)+")}`)
                ).json();
                assert.strictEqual(pattern.data.length, 0);
            });
        });

        await t.test("H3: repeated params cast to a working $in", async () => {
            await User.create([
                { name: "x", email: "x@example.com", tag: "red" },
                { name: "y", email: "y@example.com", tag: "blue" },
                { name: "z", email: "z@example.com", tag: "green" },
            ]);
            const app = buildApp({ query: ["tag"] });

            await withServer(app, async (base) => {
                const body = await (await fetch(`${base}/users?tag=red&tag=blue`)).json();
                assert.deepStrictEqual(
                    body.data.map((u) => u.tag).sort(),
                    ["blue", "red"],
                );
            });
        });

        await t.test("C2: comparison casts correctly for an allowlisted field", async () => {
            await User.create([
                { name: "young", email: "young@example.com", age: 20 },
                { name: "old", email: "old@example.com", age: 60 },
            ]);
            const app = buildApp({ query: ["age"] });

            await withServer(app, async (base) => {
                const body = await (
                    await fetch(`${base}/users?compareField=age&compareOperator=gt&compareValue=50`)
                ).json();
                assert.deepStrictEqual(
                    body.data.map((u) => u.name),
                    ["old"],
                );
            });
        });

        await t.test("toJSON transforms apply, so passwords stay stripped", async () => {
            await User.create({
                name: "secretive",
                email: "secret@example.com",
                password: "hunter2",
            });

            await withServer(buildApp({ query: [] }), async (base) => {
                const body = await (await fetch(`${base}/users`)).json();
                const raw = JSON.stringify(body);
                assert.ok(!raw.includes("hunter2"), "password leaked through the list endpoint");
            });

            // With lean: true the transform is bypassed — the 2.x behaviour.
            await withServer(buildApp({ query: [], lean: true }), async (base) => {
                const body = await (await fetch(`${base}/users`)).json();
                assert.ok(
                    JSON.stringify(body).includes("hunter2"),
                    "expected lean:true to bypass the toJSON transform",
                );
            });
        });

        await t.test("duplicate key returns 409 against a real unique index", async () => {
            await User.create({ name: "first", email: "dupe@example.com" });
            const app = buildApp({ allowedFields: ["name", "email"] });

            await withServer(app, async (base) => {
                const res = await fetch(`${base}/users`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: "second", email: "dupe@example.com" }),
                });
                assert.strictEqual(res.status, 409);
                assert.match((await res.json()).error, /Duplicate value for: email/);
            });
        });

        await t.test("H2: maxLimit bounds a real result set", async () => {
            await User.create(
                Array.from({ length: 30 }, (_, i) => ({
                    name: `bulk-${i}`,
                    email: `bulk-${i}@example.com`,
                })),
            );
            const app = buildApp({ maxLimit: 5 });

            await withServer(app, async (base) => {
                const body = await (await fetch(`${base}/users`)).json();
                assert.strictEqual(body.data.length, 5);
            });
        });

        await t.test("update and delete 404 on a valid but absent id", async () => {
            const app = buildApp({ allowedFields: ["name"] });
            const absent = new mongoose.Types.ObjectId();

            await withServer(app, async (base) => {
                const patched = await fetch(`${base}/users/${absent}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: "ghost" }),
                });
                assert.strictEqual(patched.status, 404);

                const deleted = await fetch(`${base}/users/${absent}`, { method: "DELETE" });
                assert.strictEqual(deleted.status, 404);
            });
        });
    },
);
