import { HttpError } from "../../utils/sanitize.js";
import { verifyIdentityToken } from "./jwks.js";

// Social sign-in.
//
// Each provider answers one question: which account at that provider does this
// credential belong to? What comes back is a normalized profile; matching it to
// a user is the caller's job, not the provider's.
//
// Every built-in verifies with the provider itself. A client-supplied profile
// is a claim about who someone is, and this module never takes one on trust.

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const APPLE_ISSUER = "https://appleid.apple.com";

const withTimeout = (ms = 5000) => ({ signal: AbortSignal.timeout(ms) });

const providerFetch = async (url, init, provider) => {
    let response;
    try {
        response = await fetch(url, { ...withTimeout(), ...init });
    } catch {
        throw new HttpError(503, `Could not reach ${provider}.`);
    }
    if (!response.ok) {
        throw new HttpError(401, `${provider} rejected the credential.`);
    }
    return response.json();
};

/**
 * Google — an ID token (not an access token), verified against Google's keys.
 * `settings.clientId` is the audience it must have been issued for.
 */
export const google = {
    idField: "googleId",
    async verify(credential, settings) {
        if (!settings?.clientId) throw new Error("Auth: social.google.clientId is required.");

        const claims = await verifyIdentityToken(credential.idToken ?? credential.token, {
            issuers: GOOGLE_ISSUERS,
            audience: settings.clientId,
            jwksUrl: settings.jwksUrl ?? "https://www.googleapis.com/oauth2/v3/certs",
        });

        return {
            id: claims.sub,
            email: claims.email_verified ? claims.email : null,
            name: claims.name ?? null,
            picture: claims.picture ?? null,
            raw: claims,
        };
    },
};

/**
 * Apple — the identity token from Sign in with Apple. Apple sends a name only
 * on the very first authorization, so the client has to forward it.
 */
export const apple = {
    idField: "appleId",
    async verify(credential, settings) {
        if (!settings?.clientId) throw new Error("Auth: social.apple.clientId is required.");

        const claims = await verifyIdentityToken(credential.idToken ?? credential.token, {
            issuers: [APPLE_ISSUER],
            audience: settings.clientId,
            jwksUrl: settings.jwksUrl ?? "https://appleid.apple.com/auth/keys",
        });

        return {
            id: claims.sub,
            email: claims.email_verified === false ? null : (claims.email ?? null),
            name: credential.name ?? null,
            picture: null,
            raw: claims,
        };
    },
};

/**
 * Facebook — an access token, checked with `debug_token` so the app it was
 * minted for is confirmed before the profile is read. Skipping that check is
 * the classic Facebook login bug: any app's token would be accepted.
 */
export const facebook = {
    idField: "facebookId",
    async verify(credential, settings) {
        const token = credential.accessToken ?? credential.token;
        if (!settings?.appId || !settings?.appSecret) {
            throw new Error("Auth: social.facebook needs appId and appSecret.");
        }
        if (typeof token !== "string" || token === "") {
            throw new HttpError(400, "An access token is required.");
        }

        const appToken = `${settings.appId}|${settings.appSecret}`;
        const debug = await providerFetch(
            `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`,
            undefined,
            "Facebook",
        );

        const data = debug?.data;
        if (!data?.is_valid || String(data.app_id) !== String(settings.appId)) {
            throw new HttpError(401, "Facebook token was issued for another application.");
        }

        const profile = await providerFetch(
            `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${encodeURIComponent(token)}`,
            undefined,
            "Facebook",
        );

        return {
            id: String(profile.id),
            email: profile.email ?? null,
            name: profile.name ?? null,
            picture: profile.picture?.data?.url ?? null,
            raw: profile,
        };
    },
};

/**
 * GitHub — an OAuth access token, or the `code` from the redirect, which is
 * exchanged here so the client never handles the secret.
 */
export const github = {
    idField: "githubId",
    async verify(credential, settings) {
        let token = credential.accessToken ?? credential.token;

        if (!token && credential.code) {
            if (!settings?.clientId || !settings?.clientSecret) {
                throw new Error("Auth: social.github needs clientId and clientSecret.");
            }
            const exchanged = await providerFetch(
                "https://github.com/login/oauth/access_token",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: JSON.stringify({
                        client_id: settings.clientId,
                        client_secret: settings.clientSecret,
                        code: credential.code,
                        redirect_uri: settings.redirectUri,
                    }),
                },
                "GitHub",
            );
            token = exchanged.access_token;
            if (!token) throw new HttpError(401, "GitHub rejected the authorization code.");
        }

        if (typeof token !== "string" || token === "") {
            throw new HttpError(400, "An access token or code is required.");
        }

        const headers = {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "express-controller-sets",
        };
        const profile = await providerFetch("https://api.github.com/user", { headers }, "GitHub");

        // GitHub omits a private email from the profile; the verified primary
        // one has to be asked for separately.
        let email = profile.email ?? null;
        if (!email) {
            const emails = await providerFetch(
                "https://api.github.com/user/emails",
                { headers },
                "GitHub",
            ).catch(() => []);
            email = emails.find?.((entry) => entry.primary && entry.verified)?.email ?? null;
        }

        return {
            id: String(profile.id),
            email,
            name: profile.name ?? profile.login ?? null,
            picture: profile.avatar_url ?? null,
            raw: profile,
        };
    },
};

export const BUILT_IN_PROVIDERS = { google, apple, facebook, github };

/**
 * Resolves the verifier for a provider name.
 *
 * A provider is available only once it has been configured, so an endpoint
 * never exists for a provider whose credentials the author has not supplied.
 */
export const resolveProvider = (name, config) => {
    const settings = config.social?.[name];
    if (!settings) {
        throw new HttpError(404, `Sign-in with '${name}' is not enabled.`);
    }

    const provider = typeof settings.verify === "function" ? settings : BUILT_IN_PROVIDERS[name];
    if (!provider) {
        throw new HttpError(404, `Sign-in with '${name}' is not supported.`);
    }

    return {
        verify: (credential) => provider.verify(credential, settings),
        idField: settings.idField ?? provider.idField ?? `${name}Id`,
    };
};
