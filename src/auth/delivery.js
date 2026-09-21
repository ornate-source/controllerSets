// Getting a one-time code to the person it belongs to.
//
// Two channels, each a sender plus templates:
//
//     mail — defaults to a nodemailer-style transporter (anything with
//            `sendMail`), passed in or built from SMTP_* in the environment.
//     sms  — no default: there is no SMS equivalent of SMTP, so the sender is
//            always the application's (Twilio, Vonage, SNS, a gateway…).
//
// Either sender can be swapped, and every message can be re-templated. The
// older `otp.deliver` callback, when given, still replaces all of this.

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const lookup = (context, path) =>
    path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), context);

/**
 * Fills `{{code}}`, `{{minutes}}`, `{{appName}}`, `{{user.name}}` and the like.
 * An unknown placeholder becomes empty rather than leaking the template syntax.
 */
export const interpolate = (template, context, { html = false } = {}) =>
    String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
        const value = lookup(context, path);
        if (value == null) return "";
        // Values come partly from the user record; in HTML they are text, never markup.
        return html ? escapeHtml(value) : String(value);
    });

export const DEFAULT_TEMPLATES = Object.freeze({
    mail: Object.freeze({
        passwordReset: Object.freeze({
            subject: "Your {{appName}} password reset code",
            text:
                "Your password reset code is {{code}}.\n\n" +
                "It expires in {{minutes}} minutes. If you did not ask for it, ignore this message.",
            html:
                '<div style="font-family:system-ui,sans-serif;max-width:480px">' +
                "<p>Your password reset code is</p>" +
                '<p style="font-size:28px;font-weight:600;letter-spacing:4px">{{code}}</p>' +
                "<p>It expires in {{minutes}} minutes. If you did not ask for it, ignore this message.</p>" +
                "<p>— {{appName}}</p></div>",
        }),
    }),
    sms: Object.freeze({
        passwordReset: "{{appName}}: your password reset code is {{code}}. It expires in {{minutes}} min.",
    }),
});

const renderMail = async (template, context) => {
    const raw = typeof template === "function" ? await template(context) : template;
    if (!raw || typeof raw !== "object" || !raw.subject || !(raw.text || raw.html)) {
        throw new Error("A mail template must produce { subject, text and/or html }.");
    }
    // A function template has already built its own strings; only string
    // templates are interpolated.
    if (typeof template === "function") return raw;

    return {
        subject: interpolate(raw.subject, context),
        text: raw.text ? interpolate(raw.text, context) : undefined,
        html: raw.html ? interpolate(raw.html, context, { html: true }) : undefined,
    };
};

const renderSms = async (template, context) => {
    const text = typeof template === "function" ? await template(context) : interpolate(template, context);
    if (typeof text !== "string" || !text) throw new Error("An SMS template must produce a string.");
    return text;
};

/* ------------------------------------------------------------------ *
 * The default mail sender
 * ------------------------------------------------------------------ */

const envTransport = () => {
    const env = process.env;
    if (env.SMTP_URL) return env.SMTP_URL;
    if (!env.SMTP_HOST) return null;

    const port = Number(env.SMTP_PORT ?? 587);
    return {
        host: env.SMTP_HOST,
        port,
        secure: env.SMTP_SECURE ? ["1", "true", "yes", "on"].includes(env.SMTP_SECURE.toLowerCase()) : port === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    };
};

/**
 * A sender over a transporter. When only transport options are known, the
 * transporter is built on first use: nodemailer is an optional dependency, and
 * an application that never sends mail should not have to install it.
 */
const transporterSender = ({ transporter, transport, from }) => {
    let pending = transporter ? Promise.resolve(transporter) : null;

    const resolve = () => {
        pending ??= import("nodemailer").then(
            (mod) => (mod.default ?? mod).createTransport(transport),
            () => {
                pending = null;
                throw new Error("Mail is configured by transport options, but 'nodemailer' is not installed.");
            },
        );
        return pending;
    };

    return async ({ to, subject, text, html }) => {
        const t = await resolve();
        await t.sendMail({ from, to, subject, text, html });
    };
};

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const assertFunction = (value, name) => {
    if (value !== undefined && typeof value !== "function") {
        throw new Error(`Auth: '${name}' must be a function.`);
    }
};

const resolveTemplates = (given = {}, defaults, channel) => {
    for (const [name, template] of Object.entries(given)) {
        const ok =
            typeof template === "function" ||
            (channel === "sms" ? typeof template === "string" : template && typeof template === "object");
        if (!ok) throw new Error(`Auth: '${channel}.templates.${name}' is not a valid template.`);
    }
    return Object.freeze({ ...defaults, ...given });
};

const resolveMail = (option = {}) => {
    assertFunction(option.sender, "mail.sender");
    if (option.transporter && typeof option.transporter.sendMail !== "function") {
        throw new Error("Auth: 'mail.transporter' must have a sendMail() method.");
    }

    let sender = option.sender ?? null;
    if (!sender) {
        const transport = option.transport ?? (option.transporter ? null : envTransport());
        if (option.transporter || transport) {
            const from = option.from ?? process.env.MAIL_FROM;
            // Checked now: a missing sender address otherwise surfaces as a
            // rejected message on the first password reset in production.
            if (!from) throw new Error("Auth: mail needs a 'from' address (mail.from or MAIL_FROM).");
            sender = transporterSender({ transporter: option.transporter, transport, from });
        }
    }

    return Object.freeze({
        enabled: Boolean(sender),
        sender,
        toField: option.toField ?? "email",
        templates: resolveTemplates(option.templates, DEFAULT_TEMPLATES.mail, "mail"),
    });
};

const resolveSms = (option = {}) => {
    assertFunction(option.sender, "sms.sender");

    return Object.freeze({
        enabled: Boolean(option.sender),
        sender: option.sender ?? null,
        toField: option.toField ?? "phone",
        templates: resolveTemplates(option.templates, DEFAULT_TEMPLATES.sms, "sms"),
    });
};

export const resolveDelivery = (options) =>
    Object.freeze({
        appName: options.appName ?? process.env.APP_NAME ?? "",
        mail: resolveMail(options.mail),
        sms: resolveSms(options.sms),
    });

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

/** The channels this configuration can actually send on. */
export const availableChannels = (config) => {
    if (config.otp.deliver) return ["email", "sms"];
    return [config.delivery.mail.enabled && "email", config.delivery.sms.enabled && "sms"].filter(Boolean);
};

/**
 * Sends a code. Returns false, without sending, when the user has nowhere to
 * receive it on that channel — the caller decides what, if anything, to say.
 */
export const sendCode = async ({ config, rawUser, user, code, channel, purpose, req }) => {
    if (config.otp.deliver) {
        await config.otp.deliver({ user, code, channel, req });
        return true;
    }

    const settings = channel === "sms" ? config.delivery.sms : config.delivery.mail;
    const to = rawUser?.[settings.toField];
    if (!to) return false;

    const template = settings.templates[purpose];
    if (!template) throw new Error(`No ${channel} template for '${purpose}'.`);

    const context = {
        code,
        purpose,
        minutes: Math.ceil(config.otp.ttlSeconds / 60),
        appName: config.delivery.appName,
        user,
    };

    if (channel === "sms") {
        const text = await renderSms(template, context);
        await settings.sender({ to, text, user, purpose, code, req });
    } else {
        const message = await renderMail(template, context);
        await settings.sender({ to, ...message, user, purpose, code, req });
    }
    return true;
};
