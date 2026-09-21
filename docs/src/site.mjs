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
        title: "Getting started",
        icon: "rocket",
        pages: [
            { slug: "index", title: "Overview", icon: "home", summary: "Why controller-sets, and how to install it." },
            { slug: "how-to-use", title: "How to use", icon: "play", summary: "Build a working products API with createRouter in five steps." },
        ],
    },
    {
        title: "Guides",
        icon: "book-open",
        pages: [
            { slug: "router", title: "Dynamic Router", icon: "route", summary: "Every option of createRouter and createRouterS3upload, why you would use it, and every API endpoint they create." },
            { slug: "uploads", title: "S3 Upload", icon: "upload-cloud", summary: "Upload files on your own routes with the upload middleware, and connect your bucket." },
            { slug: "auth", title: "Auth setup", icon: "key-round", summary: "Sign-up, login, roles, refresh tokens and social sign-in on your own user model." },
            { slug: "email", title: "Email sender", icon: "mail", summary: "Send password-reset codes by email or SMS, with your own transporter and templates." },
            { slug: "env", title: ".env.example", icon: "file-cog", summary: "Every environment variable, with ready-made setups for common providers." },
            { slug: "advanced", title: "Advanced", icon: "wrench", summary: "Use each ControllerSets method — getAll, query, get, create, update, delete — on your own routes." },
        ],
    },
    {
        title: "More",
        icon: "circle-help",
        pages: [
            { slug: "faq", title: "FAQ", icon: "messages-square", summary: "Answers to the questions people hit first." },
            { slug: "llm", title: "Use with an LLM", icon: "bot", summary: "One prompt so ChatGPT, Claude or Copilot write correct code for this package." },
        ],
    },
];

/** Every page in reading order, each knowing its group. */
export const PAGES = NAV.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.title })));
