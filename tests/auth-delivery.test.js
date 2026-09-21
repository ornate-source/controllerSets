import test from "node:test";
import assert from "node:assert";
import express from "express";
import mongoose from "mongoose";
import { buildAuthConfig, createAuthRouter, errorHandler } from "../src/index.js";
import { interpolate } from "../src/auth/delivery.js";
import { withServer } from "./helpers/mockModel.js";

// Sending one-time codes: the default mail sender, swapped senders, templates.

let MongoMemoryServer;
try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
} catch {
    MongoMemoryServer = null;
}

const SECRET = "delivery-secret-long-enough-for-hmac-32";
const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

test("interpolate fills placeholders and escapes them in HTML", () => {
    const context = { code: "123456", user: { name: "<b>Ada</b>" } };

    assert.strictEqual(interpolate("{{ code }} for {{user.name}}", context), "123456 for <b>Ada</b>");
    assert.strictEqual(
        interpolate("{{user.name}}", context, { html: true }),
        "&lt;b&gt;Ada&lt;/b&gt;",
    );
    assert.strictEqual(interpolate("[{{missing.path}}]", context), "[]");
});

test("delivery configuration is checked at startup", () => {
    const model = { schema: { path: () => true } };
    const build = (extra) => buildAuthConfig({ model, token: { secret: SECRET }, ...extra });

    assert.throws(() => build({ mail: { transporter: {} } }), /sendMail/);
    assert.throws(() => build({ mail: { transporter: { sendMail() {} } } }), /'from' address/);
    assert.throws(() => build({ sms: { sender: "twilio" } }), /sms.sender/);
    assert.throws(() => build({ sms: { templates: { passwordReset: 42 } } }), /not a valid template/);

    const config = build({ mail: { transporter: { sendMail() {} }, from: "a@b.c" } });
    assert.strictEqual(config.delivery.mail.enabled, true);
    assert.strictEqual(config.delivery.sms.enabled, false);
});

test(
    "Auth code delivery",
    { skip: MongoMemoryServer ? false : "mongodb-memory-server not installed" },
    async (t) => {
        const mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());

        t.after(async () => {
            await mongoose.disconnect();
            await mongod.stop();
        });

        const User = mongoose.model(
            "DeliveryUser",
            new mongoose.Schema({
                email: { type: String, unique: true, sparse: true },
                phone: { type: String, unique: true, sparse: true },
                name: String,
                password: { type: String, select: false },
                role: { type: String, default: "user" },
                otpHash: { type: String, select: false },
                otpPurpose: { type: String, select: false },
                otpExpiresAt: { type: Date, select: false },
                otpAttempts: { type: Number, default: 0, select: false },
                failedLoginAttempts: { type: Number, default: 0, select: false },
                lockedUntil: { type: Date, select: false },
                passwordChangedAt: Date,
            }),
        );
        await User.init();

        const build = (options) => {
            const app = express();
            app.use(express.json());
            app.use(
                "/auth",
                createAuthRouter({
                    model: User,
                    logger: silentLogger,
                    identifiers: ["email", "phone"],
                    registerFields: ["name"],
                    token: { secret: SECRET },
                    appName: "Acme",
                    ...options,
                }),
            );
            app.use(errorHandler);
            return app;
        };

        const call = async (base, path, body) => {
            const res = await fetch(`${base}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            return { status: res.status, body: await res.json().catch(() => null) };
        };

        await User.create([
            { email: "ada@example.com", phone: "+15550100001", name: "Ada" },
            { email: "grace@example.com", name: "Grace" },
        ]);

        await t.test("the default sender mails through the transporter", async () => {
            const sent = [];
            const app = build({
                mail: {
                    transporter: { sendMail: async (message) => sent.push(message) },
                    from: "Acme <no-reply@acme.test>",
                },
            });

            await withServer(app, async (base) => {
                const res = await call(base, "/auth/password/forgot", { identifier: "ada@example.com" });
                assert.strictEqual(res.status, 200);
            });

            assert.strictEqual(sent.length, 1);
            const [message] = sent;
            assert.strictEqual(message.from, "Acme <no-reply@acme.test>");
            assert.strictEqual(message.to, "ada@example.com");
            assert.strictEqual(message.subject, "Your Acme password reset code");
            const code = message.text.match(/\d{6}/)[0];
            assert.ok(message.html.includes(code));
            assert.match(message.text, /10 minutes/);
        });

        await t.test("a custom mail sender replaces the transporter", async () => {
            const sent = [];
            const app = build({
                mail: {
                    transporter: { sendMail: () => assert.fail("transporter used") },
                    from: "x@acme.test",
                    sender: async (message) => sent.push(message),
                },
            });

            await withServer(app, async (base) => {
                await call(base, "/auth/password/forgot", { identifier: "ada@example.com" });
            });

            assert.strictEqual(sent.length, 1);
            assert.strictEqual(sent[0].to, "ada@example.com");
            assert.strictEqual(sent[0].purpose, "passwordReset");
            assert.match(sent[0].code, /^\d{6}$/);
            assert.strictEqual(sent[0].user.name, "Ada");
        });

        await t.test("mail templates: strings are filled, functions are called", async () => {
            const sent = [];
            const sender = async (message) => sent.push(message);

            const strings = build({
                mail: {
                    sender,
                    templates: {
                        passwordReset: {
                            subject: "Hi {{user.name}}",
                            text: "Code {{code}}, {{minutes}} min",
                        },
                    },
                },
            });
            const fn = build({
                mail: {
                    sender,
                    templates: {
                        passwordReset: async ({ code, user, appName }) => ({
                            subject: `${appName} for ${user.name}`,
                            html: `<i>${code}</i>`,
                        }),
                    },
                },
            });

            for (const app of [strings, fn]) {
                await withServer(app, async (base) => {
                    await call(base, "/auth/password/forgot", { identifier: "ada@example.com" });
                });
            }

            assert.strictEqual(sent[0].subject, "Hi Ada");
            assert.match(sent[0].text, /^Code \d{6}, 10 min$/);
            assert.strictEqual(sent[0].html, undefined);
            assert.strictEqual(sent[1].subject, "Acme for Ada");
            assert.match(sent[1].html, /^<i>\d{6}<\/i>$/);
        });

        await t.test("sms goes through the sms sender with its template", async () => {
            const texts = [];
            const app = build({
                sms: {
                    sender: async (message) => texts.push(message),
                    templates: { passwordReset: "{{appName}} code {{code}}" },
                },
            });

            await withServer(app, async (base) => {
                const res = await call(base, "/auth/password/forgot", { identifier: "+15550100001" });
                assert.strictEqual(res.status, 200);
            });

            assert.strictEqual(texts.length, 1, "sms is the only channel, so it is the default");
            assert.strictEqual(texts[0].to, "+15550100001");
            assert.match(texts[0].text, /^Acme code \d{6}$/);
        });

        await t.test("the client picks a channel among the configured ones", async () => {
            const mails = [];
            const texts = [];
            const app = build({
                mail: { sender: async (m) => mails.push(m) },
                sms: { sender: async (m) => texts.push(m) },
            });

            await withServer(app, async (base) => {
                await call(base, "/auth/password/forgot", { identifier: "ada@example.com" });
                await call(base, "/auth/password/forgot", { identifier: "ada@example.com", channel: "sms" });
                const bad = await call(base, "/auth/password/forgot", {
                    identifier: "ada@example.com",
                    channel: "pigeon",
                });
                assert.strictEqual(bad.status, 400);
            });

            assert.strictEqual(mails.length, 1);
            assert.strictEqual(texts.length, 1);
        });

        await t.test("an unconfigured channel is refused, for every account alike", async () => {
            const app = build({ mail: { sender: async () => {} } });

            await withServer(app, async (base) => {
                for (const identifier of ["ada@example.com", "nobody@example.com"]) {
                    const res = await call(base, "/auth/password/forgot", { identifier, channel: "sms" });
                    assert.strictEqual(res.status, 400);
                }
            });
        });

        await t.test("no number on file answers as if sent", async () => {
            const texts = [];
            const app = build({ sms: { sender: async (m) => texts.push(m) } });

            await withServer(app, async (base) => {
                const res = await call(base, "/auth/password/forgot", { identifier: "grace@example.com" });
                assert.strictEqual(res.status, 200);
            });
            assert.strictEqual(texts.length, 0);
        });

        await t.test("a failing sender is a 503", async () => {
            const app = build({
                mail: {
                    sender: async () => {
                        throw new Error("smtp down");
                    },
                },
            });

            await withServer(app, async (base) => {
                const res = await call(base, "/auth/password/forgot", { identifier: "ada@example.com" });
                assert.strictEqual(res.status, 503);
            });
        });

        await t.test("otp.deliver still overrides everything", async () => {
            const delivered = [];
            const app = build({
                mail: { sender: () => assert.fail("mail sender used") },
                otp: { deliver: async (payload) => delivered.push(payload) },
            });

            await withServer(app, async (base) => {
                await call(base, "/auth/password/forgot", { identifier: "ada@example.com" });
            });
            assert.strictEqual(delivered.length, 1);
            assert.strictEqual(delivered[0].channel, "email");
        });
    },
);
