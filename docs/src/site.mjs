// The documentation site map: the one place that decides what pages exist, in
// what order, and under which heading. The sidebar, prev/next links, search
// index and llms.txt are all derived from this list.
//
// Each page's body lives in content/<slug>.html as a run of
// <section class="section" id="…"><h2>…</h2>…</section> blocks. Pages open
// with the short version; deeper material sits in collapsed
// <details class="advanced"> blocks under an "Advanced" heading.

export const SITE = {
    name: "controller-sets",
    package: "express-controller-sets",
    version: "3.2.0",
    url: "https://ornate-source.github.io/controllerSets/",
    repo: "https://github.com/ornate-source/controllerSets",
    npm: "https://www.npmjs.com/package/express-controller-sets",
    description:
        "Generate list, read, create, update and delete endpoints for any Mongoose model in one call — with filtering, search, pagination, S3 uploads, authentication and a security model that denies by default.",
};

export const NAV = [
    {
        title: "Get started",
        icon: "rocket",
        pages: [
            { slug: "index", title: "Overview", icon: "home", summary: "What the library is and what one call gives you." },
            { slug: "quickstart", title: "Quickstart", icon: "zap", summary: "A working API in one file, in five minutes." },
            { slug: "how-to-use", title: "How to use", icon: "map", summary: "Put CRUD, auth, uploads and email together — plus ready-made answers to common tasks." },
        ],
    },
    {
        title: "CRUD",
        icon: "database",
        pages: [
            { slug: "endpoints", title: "Endpoints & responses", icon: "network", summary: "The six routes every router serves, and what they return." },
            { slug: "filtering", title: "Filter, search & paginate", icon: "filter", summary: "Let clients find records — only by the fields you allow." },
            { slug: "writing", title: "Create, update & validate", icon: "file-pen", summary: "Choose which fields clients may write, and check them before saving." },
        ],
    },
    {
        title: "S3 Upload",
        icon: "upload-cloud",
        pages: [
            { slug: "uploads", title: "Upload files", icon: "upload", summary: "Accept files with a record and store them in S3-compatible storage." },
            { slug: "s3", title: "S3 setup", icon: "hard-drive", summary: "Connect AWS S3, Cloudflare R2, DigitalOcean Spaces or MinIO." },
        ],
    },
    {
        title: "Dynamic Router",
        icon: "route",
        pages: [
            { slug: "router", title: "Router & middlewares", icon: "lock", summary: "Mount, guard and split the generated routes." },
            { slug: "http-query", title: "HTTP QUERY", icon: "file-search", summary: "Reads whose filters travel in a JSON body." },
            { slug: "custom-routes", title: "Custom routes", icon: "puzzle", summary: "Use the handlers on your own router." },
        ],
    },
    {
        title: "Auth",
        icon: "key-round",
        pages: [
            { slug: "auth", title: "Auth setup", icon: "key-round", summary: "Sign-up, login, roles and route guards on your own user model." },
            { slug: "auth-refresh", title: "Refresh tokens", icon: "refresh-cw", summary: "Short access tokens, long sessions — with rotation on or off." },
            { slug: "auth-social", title: "Social sign-in", icon: "users", summary: "Google, Apple, Facebook, GitHub — or any provider." },
        ],
    },
    {
        title: "Email Sender",
        icon: "mail",
        pages: [
            { slug: "email", title: "Email Sender", icon: "mail", summary: "Send password-reset codes with your transporter, sender and templates." },
        ],
    },
    {
        title: ".env examples",
        icon: "file-cog",
        pages: [
            { slug: "env", title: ".env examples", icon: "file-cog", summary: "Every environment variable, with ready-made setups for common providers." },
        ],
    },
    {
        title: "Reference",
        icon: "library",
        pages: [
            { slug: "options", title: "All options", icon: "sliders-horizontal", summary: "Every option, default and export." },
            { slug: "faq", title: "FAQ", icon: "messages-square", summary: "Answers to the questions people hit first." },
            { slug: "llm", title: "Use with an LLM", icon: "bot", summary: "One prompt so ChatGPT, Claude or Copilot write correct code for this package." },
        ],
    },
];

/** Every page in reading order, each knowing its group. */
export const PAGES = NAV.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.title })));
