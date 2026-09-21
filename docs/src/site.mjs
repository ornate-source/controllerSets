// The documentation site map: the one place that decides what pages exist, in
// what order, and under which heading. The sidebar, prev/next links, search
// index and llms.txt are all derived from this list.
//
// Each page's body lives in content/<slug>.html as a run of
// <section class="section" id="…"><h2>…</h2>…</section> blocks.
//
// The site is split by what the reader is trying to do:
//
//   Get started — read once, in order.
//   Guides      — task-oriented: "how do I…", with the reasoning behind it.
//   Reference   — look-up tables: every option, parameter, export and variable.
//                 Guides link here instead of repeating it.
//   Help        — when something is wrong, or changing versions.

import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

export const SITE = {
    name: "controller-sets",
    package: pkg.name,
    version: pkg.version,
    url: "https://ornate-source.github.io/controllerSets/",
    repo: "https://github.com/ornate-source/controllerSets",
    npm: "https://www.npmjs.com/package/express-controller-sets",
    description:
        "Generate list, read, create, update and delete endpoints for any Mongoose model in one call — with filtering, search, pagination, caching, S3 uploads, authentication and a security model that denies by default.",
};

export const NAV = [
    {
        title: "Get started",
        icon: "rocket",
        pages: [
            { slug: "index", title: "Overview", icon: "home", summary: "What controller-sets does, which page you need, and how to install it." },
            { slug: "quickstart", title: "Quickstart", icon: "play", summary: "A working, protected products API in ten minutes." },
            { slug: "concepts", title: "Core concepts", icon: "lightbulb", summary: "The four ideas every other page assumes: routers, allowlists, the request lifecycle and the response envelope." },
        ],
    },
    {
        title: "Guides",
        icon: "book-open",
        pages: [
            { slug: "router", title: "createRouter", icon: "route", summary: "Every option of createRouter — including file uploads — why you would use it, and every API endpoint it creates." },
            { slug: "protect", title: "Protecting routes", icon: "shield-check", summary: "Guards, public/admin splits, server-owned fields and per-user data." },
            { slug: "uploads", title: "File uploads", icon: "upload-cloud", summary: "Accept files on a router or your own route, store them in S3, and compress images." },
            { slug: "cache", title: "Caching", icon: "zap", summary: "Answer repeated reads from Redis, cleared automatically on every write." },
            { slug: "auth", title: "Authentication", icon: "key-round", summary: "Sign-up, login, roles, refresh tokens and social sign-in on your own user model." },
            { slug: "email", title: "Email & SMS", icon: "mail", summary: "Deliver password-reset codes with your own transporter, sender and templates." },
            { slug: "custom-routes", title: "Custom routes", icon: "wrench", summary: "Use the ControllerSets handlers on routes you wire yourself." },
        ],
    },
    {
        title: "Reference",
        icon: "library",
        pages: [
            { slug: "http-api", title: "HTTP API", icon: "globe", summary: "For client developers: every endpoint, query parameter, QUERY body, response shape and status code." },
            { slug: "api", title: "JavaScript API", icon: "braces", summary: "Every export of the package, with signatures and TypeScript types." },
            { slug: "env", title: "Environment variables", icon: "file-cog", summary: "Every variable the library reads, with ready-made setups for common providers." },
        ],
    },
    {
        title: "Help",
        icon: "circle-help",
        pages: [
            { slug: "troubleshooting", title: "Troubleshooting", icon: "stethoscope", summary: "Symptoms, causes and fixes for the problems people hit first." },
            { slug: "upgrading", title: "Upgrading", icon: "arrow-up-circle", summary: "Deprecations in 3.3, and moving from 2.x to 3.x." },
            { slug: "llm", title: "Use with an LLM", icon: "bot", summary: "One prompt so ChatGPT, Claude or Copilot write correct code for this package." },
        ],
    },
];

/** Every page in reading order, each knowing its group. */
export const PAGES = NAV.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.title })));

/**
 * Pages that were renamed. Each old URL is kept as a stub that forwards to its
 * replacement, so links from READMEs, issues and search engines keep working.
 * Anchors that moved are mapped too: old-page#old-id → new-page#new-id.
 */
export const REDIRECTS = {
    "how-to-use": { to: "quickstart" },
    advanced: { to: "custom-routes" },
    faq: { to: "troubleshooting" },
};

/** Old anchors on pages that still exist but lost sections to other pages. */
export const MOVED_ANCHORS = {
    router: {
        "api-filtering": "http-api.html#api-filtering",
        "api-search": "http-api.html#api-search",
        "api-sorting": "http-api.html#api-sorting",
        "api-pagination": "http-api.html#api-pagination",
        "api-combined": "http-api.html#api-combined",
        "api-query": "http-api.html#api-query",
        "http-query": "http-api.html#api-query",
        "api-single": "http-api.html#api-single",
        "api-errors": "http-api.html#errors",
        errors: "http-api.html#errors",
        responses: "http-api.html#responses",
        "query-reference": "http-api.html#api-filtering",
        middlewares: "protect.html#middlewares",
        "public-read-admin-write": "protect.html#public-read-admin-write",
        "owner-from-token": "protect.html#owner-from-token",
        "only-my-records": "protect.html#only-my-records",
    },
    index: {
        basics: "concepts.html#glossary",
        "implicit-deny": "concepts.html#implicit-deny",
        lifecycle: "concepts.html#lifecycle",
    },
};
