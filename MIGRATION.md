# Migrating to 4.0: `createRouterS3upload` is removed

`createRouter` takes files itself now, through an `upload` option. `createRouterS3upload` is
deprecated in 3.3 — it still works and emits a `DeprecationWarning` (code `ECS_DEP001`) once
per process — and is removed in 4.0.

Move `path`, `fields` and `imgOptimizations` into `upload`, next to the settings already there:

```js
// 3.x
createRouterS3upload({
    model: Product,
    path: "products/",
    fields: [{ name: "cover", maxCount: 1 }],
    imgOptimizations: "medium",
    upload: { acl: "public-read" },
});

// 3.3+ and 4.0
createRouter({
    model: Product,
    upload: {
        path: "products/",
        fields: [{ name: "cover", maxCount: 1 }],
        imgOptimizations: "medium",
        acl: "public-read",
    },
});
```

`upload: true` takes every default (`path: "files/"`, one field named `file`). Without
`upload`, the router takes no files. `createRouter` logs a warning if it sees `path`, `fields`
or `imgOptimizations` at the top level, since it ignores them there. In TypeScript,
`RouterS3Options` is deprecated in favour of `RouterOptions` with `upload`.

---

# Migrating from 2.x to 3.0

3.0 is a security release. It fixes vulnerabilities that let a client read fields your API
never exposed, write fields it was never meant to write, and host arbitrary HTML on your S3
bucket. **Every one of those fixes is a breaking change**, because in 2.x the insecure
behaviour was the default.

If you run this package on a public endpoint, treat this as an urgent upgrade.

---

## The fastest path

Add `legacyMode: true` to restore 2.x behaviour, deploy, then remove it option by option:

```js
createRouter({ model: Product, legacyMode: true });
```

This is a bridge, not a destination. It re-enables every vulnerability listed below and will
be removed in 4.0.

---

## What changed, and what to do

### 1. Request bodies are filtered (`allowedFields` / `blockedFields`)

**Was:** the entire request body went to `Model.create()` and `$set`. Any schema field was
client-writable, including `role`, `isAdmin`, and `balance`.

**Now:** `_id`, `__v`, `createdAt`, `updatedAt`, `$`-prefixed keys, and dotted keys are always
stripped. Anything else is still writable **until you configure a policy** — so this alone does
not close the hole. Configure it:

```js
createRouter({
    model: User,
    allowedFields: ["name", "email", "avatar"],           // both verbs
    // or per verb:
    // allowedFields: { create: ["name", "email"], update: ["name"] },
    // or subtract instead:
    // blockedFields: ["role", "isAdmin"],
});
```

Until you do, the package logs a warning at startup naming the model. A request whose body
contains no writable field now returns **400** instead of silently creating an empty record.

### 2. `?compareField=`, `?rangeField=` and `?sort=` are allowlisted

**Was:** these accepted any field name, bypassing `query` entirely. A client could filter on
`passwordResetToken` and binary-search its value from the result counts.

**Now:** they resolve against `query` by default. Unknown fields return **400**.

```js
createRouter({
    model: Product,
    query: ["category"],                        // equality filters + default allowlist
    filterableFields: ["category", "price"],    // ?compareField= / ?rangeField=
    sortableFields: ["price", "createdAt"],     // ?sort=
});
```

Your configured `orderBy` is always permitted — only client-supplied `?sort=` is checked.

### 3. Search terms are escaped

**Was:** `?s=` went to `$regex` raw, so `?s=(a+)+$` caused catastrophic backtracking inside
mongod.

**Now:** escaped and matched literally; terms over 128 characters return 400
(`maxSearchLength`). If you relied on clients passing real patterns:

```js
createRouter({ model: Post, search: ["title"], allowRawRegex: true });
```

Only do this behind authentication.

### 4. Reads are always bounded

**Was:** `GET /items` without `?page` returned the entire collection.

**Now:** capped at `maxLimit` (default 100), paginated or not. If you depended on unbounded
reads, raise `maxLimit` explicitly or paginate.

### 5. Relational search targets the full path

**Was:** `search: ["author.profile.name"]` silently searched `profile`, not `profile.name`.

**Now:** the full nested path is used. Results will change where you used depth-2 paths —
they were previously querying the wrong field.

### 6. `?s=` is the only search parameter

**Was:** array-form `search` read `?s`/`?search`, but string-form `search: "title"` read
`?title`. Two different contracts on one option.

**Now:** both use `?s=` / `?search=`.

### 7. Uploads are private and content-sniffed

**Was:** `ACL: "public-read"` was hardcoded, `Content-Type` came from the client's multipart
header, and there was no type validation. Uploading HTML labelled `image/png` produced a
world-readable page executing on your bucket's origin.

**Now:**

- ACL defaults to **`private`**
- the stored `Content-Type` and file extension come from the **bytes**, not the client
- only `image/jpeg|png|gif|webp|avif` and `application/pdf` are accepted
- anything not on a strict inline allowlist is stored `Content-Disposition: attachment`

```js
createRouter({
    model: Document,
    upload: {
        path: "docs/",
        acl: "public-read",                    // opt back in deliberately
        allowedMimeTypes: ["image/jpeg", "image/png", "application/pdf"],
        maxFileSize: 5 * 1024 * 1024,
        maxFiles: 5,
    },
});
```

> **Existing objects are unaffected.** Files uploaded under 2.x keep their `public-read` ACL.
> Audit your bucket separately — this change only governs new uploads.

If you switch to `private`, the returned URL is no longer publicly fetchable. Serve those
objects through presigned URLs or a CDN origin-access identity. `file.key` is populated
alongside `file.location` for this purpose.

### 8. Clients no longer choose image optimization

**Was:** read from query, body, and two headers, overriding your server config. Forcing
`high` on every upload is CPU amplification.

**Now:** server config only. To opt back in: `upload: { allowClientImageOptions: true }` —
values are allowlisted even then.

### 9. Non-optimizable formats pass through untouched

**Was:** GIF and SVG fell through to the JPEG encoder, producing JPEG bytes stored under a
`.gif` key with `Content-Type: image/gif`. Animation was lost and the object was corrupt.

**Now:** only JPEG, PNG and WebP are re-encoded; everything else is uploaded as-is, and the
extension is re-derived from the output bytes.

### 10. 5xx responses no longer echo internal messages

**Was:** `err.message` was returned verbatim, leaking connection strings, hostnames, and
bucket names.

**Now:** any unclassified 5xx returns `"Internal Server Error"` plus a `requestId` that
correlates to the server log. Deliberate 4xx messages are unchanged, and duplicate-key errors
now return **409** instead of 500.

### 11. `dotenv` is no longer called, and `multer-s3` was never used

The package no longer calls `dotenv.config()` — loading environment is your application's
job. Ensure you load it yourself before handling requests. S3 config is now read **per
request**, so env vars loaded after import work correctly.

`multer-s3` was listed as a peer dependency but never imported; it has been removed. You can
uninstall it. `sharp` is now an optional dependency and is loaded lazily, so CRUD-only
consumers no longer pay for a native binary.

---

## Behavioural changes worth checking

| Change | Impact |
|---|---|
| `update`/`delete` are a single atomic query | A missing record still returns 404; the previous read-then-write race is gone |
| `runValidators` now passes `context: "query"` | Custom update validators using `this` behave correctly |
| Reads are no longer `.lean()` by default | Schema `toJSON` transforms now apply — **if you strip fields there, they are now correctly stripped**. Set `lean: true` to restore 2.x behaviour and its performance |
| `runAfterCreate` failures | Still logged and swallowed; set `strictAfterCreate: true` to propagate |

The `lean` change is the one most likely to alter your response bodies. In 2.x, `getAll` used
`.lean()`, which bypasses `schema.set("toJSON", { transform })`. If you relied on such a
transform to remove sensitive fields, **2.x was leaking them on list endpoints** and 3.0
stops doing so.

---

## New in 3.1: the QUERY method

3.1 adds one route to every generated router — `QUERY /`, a read whose parameters travel in a
JSON body — and changes nothing else. Two things are worth knowing while upgrading:

- **`legacyMode` does not relax it.** The bridge above re-enables 2.x behaviour on routes that
  existed in 2.x. QUERY did not, so its `filter` and `sort` always resolve against
  `filterableFields` and `sortableFields`. If you are still on `legacyMode` and have declared
  neither, a QUERY body carrying a filter returns `400` — declare the fields, or pass
  `enableQuery: false`.
- **The route appears automatically.** If a proxy, WAF or API gateway in front of your app
  rejects unrecognised methods, nothing changes for you; if you would rather it were never
  mounted, pass `enableQuery: false`. On Node older than 22 it is skipped anyway, with one
  warning, because the runtime cannot parse the method (QUERY needs Node 22.2+).

```js
createRouter({
    model: Product,
    filterableFields: ["price", "category"],  // what a QUERY filter may name
    sortableFields: ["price", "createdAt"],   // what a QUERY sort may name
    enableQuery: true,                        // the default
});
```

---

## Constructor form

The positional signature still works but is deprecated:

```js
// still supported
new ControllerSets(Model, "-createdAt", ["category"], ["name"]);

// preferred — required for any 3.0 option
new ControllerSets({ model: Model, orderBy: "-createdAt", query: ["category"] });
```
