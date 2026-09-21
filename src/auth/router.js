import express from "express";
import { buildConfig } from "../core/config.js";
import { buildAuthConfig } from "./config.js";
import { requireAuth, requireRole } from "./middleware.js";
import {
    changePassword,
    forgotPassword,
    getUser,
    listUsers,
    login,
    logout,
    logoutAll,
    me,
    modifyRoles,
    refreshSession,
    register,
    resetPassword,
    socialLogin,
    updateUser,
} from "./handlers.js";

// The endpoints, as data.
//
// Everything about a route lives in one row — its verb, its default URL, who
// may reach it, and what runs it. Mounting walks this table, so an endpoint
// cannot be added without stating who can call it, and the same table answers
// `router.urls` for anyone who wants to know what got mounted.
const ROUTES = [
    { name: "register", method: "post", path: "/register", access: "public", handler: register },
    { name: "login", method: "post", path: "/login", access: "public", handler: login },
    {
        name: "social",
        method: "post",
        path: "/social/:provider",
        access: "public",
        handler: socialLogin,
    },
    {
        name: "forgotPassword",
        method: "post",
        path: "/password/forgot",
        access: "public",
        handler: forgotPassword,
    },
    {
        name: "resetPassword",
        method: "post",
        path: "/password/reset",
        access: "public",
        handler: resetPassword,
    },
    {
        name: "changePassword",
        method: "post",
        path: "/password/change",
        access: "authenticated",
        handler: changePassword,
    },
    {
        name: "refresh",
        method: "post",
        path: "/token/refresh",
        access: "public",
        handler: refreshSession,
    },
    { name: "logout", method: "post", path: "/logout", access: "public", handler: logout },
    {
        name: "logoutAll",
        method: "post",
        path: "/logout/all",
        access: "authenticated",
        handler: logoutAll,
    },
    { name: "me", method: "get", path: "/me", access: "authenticated", handler: me },
    { name: "listUsers", method: "get", path: "/users", access: "admin", handler: listUsers },
    {
        name: "getUser",
        method: "get",
        path: "/users/:id",
        access: "authenticated",
        handler: getUser,
    },
    {
        name: "updateUser",
        method: "patch",
        path: "/users/:id",
        access: "authenticated",
        handler: updateUser,
    },
    {
        name: "modifyRoles",
        method: "patch",
        path: "/users/:id/roles",
        access: "admin",
        handler: modifyRoles,
    },
];

/** `listUsers` needs the read pipeline; the rest are ready as they are. */
const buildHandler = (route, readConfig) =>
    route.name === "listUsers" ? route.handler(readConfig) : route.handler;

/**
 * Resolves one route's URL. `routes: { login: '/signin' }` renames it,
 * `routes: { social: false }` leaves it unmounted.
 */
const resolvePath = (route, overrides) => {
    const override = overrides[route.name];
    if (override === false || override === null) return null;
    if (typeof override === "string" && override !== "") return override;
    return route.path;
};

/**
 * Middleware for one route.
 *
 * An array applies to every endpoint, as `middlewares` does on `createRouter`.
 * An object targets them by name, which is how a rate limiter goes on `/login`
 * and `/password/forgot` without throttling `/me`.
 */
const middlewareFor = (route, option) => {
    if (Array.isArray(option)) return option;
    if (!option || typeof option !== "object") return [];

    return [...(option.all ?? []), ...(option[route.name] ?? [])];
};

export const createAuthRouter = (options = {}) => {
    const config = buildAuthConfig(options);

    // The user list reuses the CRUD read pipeline, so it inherits the same
    // caps: `maxLimit`, `maxTimeMS`, and the rest.
    const readConfig = buildConfig({
        model: config.model,
        maxLimit: options.maxLimit,
        defaultPageSize: options.defaultPageSize,
        maxTimeMS: options.maxTimeMS,
        countStrategy: options.countStrategy,
        lean: options.lean,
        logger: config.logger,
    });

    const overrides = options.routes ?? {};
    const unknown = Object.keys(overrides).filter(
        (name) => !ROUTES.some((route) => route.name === name),
    );
    if (unknown.length > 0) {
        throw new Error(
            `Auth: unknown route '${unknown[0]}'. Known routes: ` +
                `${ROUTES.map((route) => route.name).join(", ")}.`,
        );
    }

    const router = express.Router();
    const authenticated = requireAuth(config);
    const guards = {
        public: [],
        authenticated: [authenticated],
        admin: [authenticated, requireRole(config.roles.admin)],
    };

    const run = (fn) => (req, res, next) => Promise.resolve(fn(req, res, config)).catch(next);
    const urls = [];

    const refreshRoutes = new Set(["refresh", "logout", "logoutAll"]);

    for (const route of ROUTES) {
        // No endpoint for a feature that is switched off.
        if (refreshRoutes.has(route.name) && !config.refresh.enabled) continue;

        const path = resolvePath(route, overrides);
        if (!path) continue;

        router[route.method](
            path,
            ...middlewareFor(route, options.middlewares),
            ...guards[route.access],
            run(buildHandler(route, readConfig)),
        );

        urls.push({
            name: route.name,
            method: route.method.toUpperCase(),
            path,
            access: route.access,
        });
    }

    // The guards travel with the router, so protecting your own routes needs no
    // second copy of the configuration to keep in sync with this one.
    router.requireAuth = authenticated;
    router.requireRole = (...roles) => requireRole(...roles);
    router.config = config;
    /** What was actually mounted, in order. */
    router.urls = Object.freeze(urls);

    return router;
};

/** The endpoints this router can mount, for tooling and documentation. */
export const AUTH_ROUTES = Object.freeze(
    ROUTES.map(({ name, method, path, access }) =>
        Object.freeze({ name, method: method.toUpperCase(), path, access }),
    ),
);
