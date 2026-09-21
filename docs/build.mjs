#!/usr/bin/env node
// Builds the documentation site.
//
//     node docs/build.mjs          (or: npm run docs)
//
// Reads docs/src/content/<slug>.html for every page in docs/src/site.mjs and
// writes docs/<slug>.html, plus the search index, llms.txt, llms-full.txt and
// sitemap.xml. No dependencies: the output is plain HTML that GitHub Pages
// serves as-is, so the generated files are committed.
//
// The build fails on a link to an anchor that does not exist, so a renamed
// section cannot silently strand the links that pointed at it.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, PAGES, SITE } from "./src/site.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const write = (p, s) => writeFileSync(join(ROOT, p), s);

const escapeHtml = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const stripTags = (s) =>
    s
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
const slugify = (s) =>
    stripTags(s)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
// Content hashes on asset URLs, so a deploy is never served yesterday's CSS.
const version = (path) => `${path}?v=${createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex").slice(0, 10)}`;
const href = (slug) => (slug === "index" ? "./" : `${slug}.html`);

/* ------------------------------------------------------------------ *
 * 1. Parse every page: sections, headings, ids.
 * ------------------------------------------------------------------ */

const LLM_PROMPT = read("src", "llm", "prompt.md");

const parsed = PAGES.map((page) => {
    let html = read("src", "content", `${page.slug}.html`);
    html = html.replace("{{LLM_PROMPT}}", escapeHtml(LLM_PROMPT.trim()));

    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const headings = [];

    // Sections and their h2s. The h2 gets an anchor link; the section is
    // what the sidebar and the table of contents point at.
    const sectionRe = /<section class="section[^"]*" id="([^"]+)">\s*<h2>([\s\S]*?)<\/h2>/g;
    html = html.replace(sectionRe, (all, id, title) => {
        headings.push({ depth: 2, id, title: stripTags(title) });
        return all.replace(
            `<h2>${title}</h2>`,
            `<h2>${title}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h2>`,
        );
    });

    // h3s get an id when they have none, then an anchor.
    html = html.replace(/<h3>([\s\S]*?)<\/h3>/g, (all, title) => {
        let id = slugify(title) || "section";
        for (let n = 2; ids.has(id); n++) id = `${slugify(title)}-${n}`;
        ids.add(id);
        headings.push({ depth: 3, id, title: stripTags(title) });
        return `<h3 id="${id}">${title}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h3>`;
    });

    // Collapsed "Advanced" blocks are searchable too.
    for (const [, id, title] of html.matchAll(/<details class="advanced" id="([^"]+)">\s*<summary>([\s\S]*?)<\/summary>/g)) {
        headings.push({ depth: 3, id, title: stripTags(title) });
    }

    // Keep headings in document order (h3 ids were assigned after h2s).
    headings.sort((a, b) => html.indexOf(`id="${a.id}"`) - html.indexOf(`id="${b.id}"`));

    // Language hint for the highlighter.
    html = html.replace(
        /(<div class="code-block" data-lang="([\w-]+)"[^>]*>\s*<pre>)<code>/g,
        (_, open, lang) => `${open}<code class="language-${lang === "jsonc" ? "json" : lang}">`,
    );

    return { ...page, html, ids, headings };
});

/* ------------------------------------------------------------------ *
 * 2. Resolve in-page anchors across pages, and refuse broken ones.
 * ------------------------------------------------------------------ */

const owner = new Map();
for (const page of parsed) for (const id of page.ids) if (!owner.has(id)) owner.set(id, page.slug);
const slugs = new Set(PAGES.map((p) => p.slug));

const broken = [];
for (const page of parsed) {
    page.html = page.html.replace(/href="#([^"]+)"/g, (all, id) => {
        if (page.ids.has(id)) return all;
        const target = owner.get(id);
        if (!target) {
            broken.push(`${page.slug}: #${id}`);
            return all;
        }
        return `href="${target === "index" ? "./" : `${target}.html`}#${id}"`;
    });
    for (const [, target] of page.html.matchAll(/href="([\w-]+)\.html(?:#([^"]+))?"/g)) {
        if (!slugs.has(target)) broken.push(`${page.slug}: ${target}.html`);
    }
    for (const [, target, id] of page.html.matchAll(/href="([\w-]+)\.html#([^"]+)"/g)) {
        const t = parsed.find((p) => p.slug === target);
        if (t && !t.ids.has(id)) broken.push(`${page.slug}: ${target}.html#${id}`);
    }
}
if (broken.length) {
    console.error(`Broken links:\n  ${broken.join("\n  ")}`);
    process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 3. Render.
 * ------------------------------------------------------------------ */

const icon = (name, cls = "") => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ""}></i>`;

const sidebar = (current) =>
    NAV.map((group) => {
        const pages = group.pages
            .map((p) => {
                const isCurrent = p.slug === current.slug;
                return `<li><a class="nav-page" href="${href(p.slug)}"${isCurrent ? ' aria-current="page"' : ""}>${icon(p.icon)}<span class="nav-page-label">${escapeHtml(p.title)}</span>${p.badge ? `<span class="nav-badge">${p.badge}</span>` : ""}</a></li>`;
            })
            .join("\n");
        const key = slugify(group.title) || "env";
        // A group with one page is just a link — a heading over a single item says it twice.
        if (group.pages.length === 1) {
            const p = group.pages[0];
            return `<div class="nav-group nav-single"><a class="nav-page nav-top" href="${href(p.slug)}"${p.slug === current.slug ? ' aria-current="page"' : ""}>${icon(group.icon)}<span class="nav-page-label">${escapeHtml(group.title)}</span></a></div>`;
        }
        return `<div class="nav-group" data-group="${key}">
          <button class="nav-group-toggle" type="button" aria-expanded="true">${icon(group.icon)}<span>${escapeHtml(group.title)}</span>${icon("chevron-down", "chev")}</button>
          <ul class="nav-pages">${pages}</ul>
        </div>`;
    }).join("\n");

const pager = (i) => {
    const prev = PAGES[i - 1];
    const next = PAGES[i + 1];
    return `<nav class="pager" aria-label="Previous and next page">
      ${prev ? `<a class="prev" href="${href(prev.slug)}"><span class="pager-dir">${icon("arrow-left")} Previous</span><span class="pager-title">${escapeHtml(prev.title)}</span></a>` : ""}
      ${next ? `<a class="next" href="${href(next.slug)}"><span class="pager-dir">Next ${icon("arrow-right")}</span><span class="pager-title">${escapeHtml(next.title)}</span></a>` : ""}
    </nav>`;
};

const layout = (page, i) => {
    const isHome = page.slug === "index";
    const title = isHome ? `${SITE.package} — one model in, a whole REST API out` : `${page.title} · ${SITE.package}`;
    const description = page.summary ?? SITE.description;
    const header = isHome
        ? ""
        : `<header class="page-header">
          <p class="breadcrumb">${NAV.find((g) => g.title === page.group).pages.length > 1 ? `${escapeHtml(page.group)} ${icon("chevron-right")} ` : ""}${escapeHtml(page.title)}</p>
          <h1>${escapeHtml(page.title)}</h1>
          <p class="page-summary">${escapeHtml(page.summary ?? "")}</p>
        </header>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${SITE.url}${isHome ? "" : `${page.slug}.html`}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <link rel="alternate" type="text/plain" title="LLM guide" href="llms-full.txt">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700;800&family=Fira+Code:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${version("assets/css/components.css")}">
  <link rel="stylesheet" href="${version("assets/css/shell.css")}">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%236366f1'/%3E%3Ctext x='50' y='68' font-family='monospace' font-size='54' font-weight='700' fill='white' text-anchor='middle'%3E%7B%7D%3C/text%3E%3C/svg%3E">
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js" defer></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js" defer></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/http.min.js" defer></script>
  <script src="assets/search-index.js" defer></script>
  <script src="${version("assets/js/docs.js")}" defer></script>
</head>
<body class="dark" data-page="${page.slug}">
  <script>try{var t=localStorage.getItem('controllersets-theme');document.body.className=t||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')}catch(e){}</script>
  <a href="#main" class="skip-link">Skip to content</a>

  <header class="topbar">
    <button class="icon-btn menu-btn" type="button" id="menu-open" aria-label="Open navigation">${icon("menu")}</button>
    <a class="brand" href="./" aria-label="${SITE.name} home">
      <span class="brand-mark" aria-hidden="true">{}</span>
      <span class="brand-name">${SITE.name}</span>
      <span class="brand-version">v${SITE.version}</span>
    </a>
    <button class="search-trigger" type="button" id="search-open" aria-label="Search the docs">
      ${icon("search")}<span>Search docs…</span><kbd>⌘K</kbd>
    </button>
    <nav class="topbar-links" aria-label="External">
      <a class="topbar-link is-accent hide-sm" href="llm.html">${icon("sparkles")}<span class="label">LLM prompt</span></a>
      <a class="topbar-link hide-sm" href="${SITE.repo}" target="_blank" rel="noopener"><svg class="gh-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg><span class="label">GitHub</span></a>
      <a class="topbar-link hide-sm" href="${SITE.npm}" target="_blank" rel="noopener">${icon("package")}<span class="label">npm</span></a>
      <button class="icon-btn" type="button" id="theme-toggle" aria-label="Toggle colour theme">${icon("sun", "sun-icon")}${icon("moon", "moon-icon")}</button>
    </nav>
  </header>

  <div class="nav-overlay" id="nav-overlay"></div>

  <div class="layout">
    <aside class="sidenav" id="sidenav" aria-label="Documentation">
      <nav>${sidebar(page)}</nav>
    </aside>

    <main class="doc" id="main" tabindex="-1">
      <article class="doc-inner">
        ${header}
        ${page.html}
        ${pager(i)}
        <footer class="doc-footer">
          <span>${SITE.package} v${SITE.version} · MIT licensed · © 2024–present Sabbir Mahmud</span>
          <a href="${SITE.repo}/edit/main/docs/src/content/${page.slug}.html" target="_blank" rel="noopener">${icon("pencil")} Edit this page</a>
        </footer>
      </article>
    </main>

  </div>

  <dialog class="search-dialog" id="search-dialog" aria-label="Search">
    <div class="search-field">${icon("search")}<input id="search-input" type="search" placeholder="Search the docs…" autocomplete="off" spellcheck="false" aria-controls="search-results"><kbd>Esc</kbd></div>
    <ul class="search-results" id="search-results" role="listbox"></ul>
    <div class="search-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>↵</kbd> to open</span></div>
  </dialog>

  <button id="back-to-top" class="back-to-top" type="button" aria-label="Back to top">${icon("arrow-up")}</button>
</body>
</html>
`;
};

parsed.forEach((page, i) => write(`${page.slug}.html`, layout(page, i)));

/* ------------------------------------------------------------------ *
 * 4. Search index, llms.txt, sitemap.
 * ------------------------------------------------------------------ */

const index = [];
for (const page of parsed) {
    index.push({ p: page.title, g: page.group, t: page.title, u: href(page.slug), x: page.summary ?? "" });
    for (const h of page.headings) {
        // The text under a heading, up to the next one — enough to match on.
        const at = page.html.indexOf(`id="${h.id}"`);
        const rest = page.html.slice(at);
        const nextAt = rest.slice(10).search(/<h[23][\s>]|<section /);
        const text = stripTags(rest.slice(rest.indexOf(">") + 1, nextAt > 0 ? nextAt + 10 : 3000)).slice(0, 600);
        index.push({ p: page.title, g: page.group, t: h.title, u: `${href(page.slug)}#${h.id}`, x: text });
    }
}
write("assets/search-index.js", `window.__DOCS_INDEX__=${JSON.stringify(index)};\n`);

const llms = [
    `# ${SITE.package}`,
    "",
    `> ${SITE.description}`,
    "",
    `Install: \`npm install ${SITE.package} express mongoose\`. ES modules, Node 20+, Express 5, Mongoose 9.`,
    `For a complete, self-contained guide written for language models, read ${SITE.url}llms-full.txt.`,
    "",
    ...NAV.flatMap((group) => [
        `## ${group.title}`,
        "",
        ...group.pages.map((p) => `- [${p.title}](${SITE.url}${p.slug === "index" ? "" : `${p.slug}.html`}): ${p.summary ?? ""}`),
        "",
    ]),
    "## Optional",
    "",
    `- [llms-full.txt](${SITE.url}llms-full.txt): The full API guide and coding rules in one file`,
    `- [Source](${SITE.repo}): GitHub repository`,
    "",
].join("\n");
write("llms.txt", llms);
write("llms-full.txt", LLM_PROMPT);

write(
    "sitemap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((p) => `  <url><loc>${SITE.url}${p.slug === "index" ? "" : `${p.slug}.html`}</loc></url>`).join("\n")}
</urlset>
`,
);

console.log(`Built ${parsed.length} pages, ${index.length} search entries.`);
