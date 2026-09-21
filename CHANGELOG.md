# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.1.0] — 2026-09-21

Three things: the HTTP **QUERY** method, a **custom validation hook** for writes, and
**read cost controls**. Plus a prototype-pollution fix, and an internal restructure that
leaves every public behaviour as it was in 3.0.0.

### Added — the QUERY method

- **`QUERY /` on every generated router.** QUERY ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008.html))
  is safe and idempotent — GET with a body — for filters that are too long for a URL, too
  structured to flatten into a query string, or too sensitive to leave in proxy and access
  logs. The response is identical to the equivalent `GET /`.
- **A structured `filter` body.** Field-to-condition pairs, where a condition is a scalar
  (equality), a list (`in`), or an object of operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`,
  `in`, `nin`. Operators are written *without* `$` and translated through a fixed table, so a
  client can never hand MongoDB an operator this library did not author. Fields must appear in
  `filterableFields` (which defaults to `query`) — and that allowlist is enforced even under
  `legacyMode`, because QUERY has no 2.x behaviour to stay compatible with.
- **Multi-key sorting**, which the query string cannot express: `"sort": ["category", "-price"]`,
  up to five keys, each checked against `sortableFields`.
- **`limit`** in the body for an unpaginated read, capped at `maxLimit` like everything else,
  and rejected when combined with paging. `page` / `pageSize` behave as they do on GET and
  return the same `pagination` envelope.
- **`enableQuery`** router option (default `true`) to leave the route unmounted.
- **`isQueryMethodSupported()`** export. Serving QUERY needs Node 22.2+: an older runtime
  rejects the method in its HTTP parser before Express sees it, and its Express router has no
  matching verb. When unsupported, the route is skipped and a warning is logged once, rather
  than the router failing to build.
- **`Accept-Query: application/json`** on `OPTIONS /` and on a `415`, per RFC 10008 §4, so a
  client can discover the accepted format. The generated `Allow` header now lists `QUERY`.
- **`QUERY_FILTER_OPERATORS`** export, and `ControllerSets#queryAll` for hand-wired routers.
- TypeScript types for all of the above: `QueryRequestBody`, `FilterCondition`,
  `FilterOperators`, `FilterScalar`.

### Added — custom write validation

- **`validate`** option: a hook that checks a create or an update before it reaches Mongoose,
  as one function or `{ create, update }`. It receives the payload *after* the field policy
  has been applied, so it never sees a field the client was not allowed to send.
  - Return nothing to accept the payload, or a plain object to replace it — which is how a
    hook normalises values or sets server-owned fields (`ownerId`, `slug`) that no client may
    write. A replacement is still stripped of `$`-prefixed, dotted and prototype keys.
  - Throw **`ValidationError`** (new export) to reject with per-field messages, or any
    `HttpError` for a plain status. Anything else thrown is a 500 with no detail leaked.
  - Mongoose's own schema validators still run afterwards, unchanged.
- Error responses carry an optional **`fields`** map alongside `error`. It is populated by a
  `ValidationError`, by Mongoose validation failures, and by duplicate-key conflicts. Clients
  that do not look for it see exactly the shape they always have, and it is never sent on a 5xx.

### Added — cursor pagination, for collections that keep growing

- **`pagination: 'cursor'`** switches a list endpoint from offset to keyset paging. `?page=N`
  makes the database walk every skipped index entry, so page 4,000 costs 4,000 pages' worth of
  work; a keyset page is one index seek at any depth, and runs no count. Measured on 200,000
  documents: **page 4,000 takes 47.8 ms by offset and 0.9 ms by cursor**, and the gap widens
  linearly as the collection grows.
  - The first page takes no parameter. Responses carry
    `pagination: { pageSize, hasMore, nextCursor }`; pass `nextCursor` back as `?cursor=` (or
    `"cursor"` in a QUERY body) for the next one.
  - The sort gains `_id` as a tiebreaker automatically, so documents sharing a sort value are
    neither skipped nor repeated at a page boundary — the failure that makes hand-rolled
    keyset pagination quietly lose records.
  - A cursor carries only the anchor document's `_id`; the server re-reads that record for its
    sort values. A client therefore cannot craft a cursor that range-filters a field it was
    never allowed to filter on.
  - `?page=` in cursor mode is a `400`, as is `?cursor=` in offset mode: silently serving the
    other kind of page would corrupt a scan.
- **`maxRelationMatches`** (default 1000) caps the ids a relational search pulls from a
  referenced collection. That `$in` grew with the collection rather than with the page, which
  made `search: ['author.name']` the slowest thing in the library at scale.
- **`allowDiskUse`** and **`batchSize`** for large sorts and large result sets.

### Added — read cost controls

- **`countStrategy`**: `'exact'` (default, unchanged), `'estimated'` (O(1) collection
  metadata, used only when a page has no filter, since an estimate cannot see one), or
  `'none'` (no count query at all — the `pagination` block carries `hasMore` instead of
  `totalPages` / `totalRecords`, answered by fetching one extra document).
- **`maxTimeMS`**: a server-side time limit applied to every read, including the count beside
  it. Off by default. It is the only bound on a query that is slow in the database rather than
  in this process.
- **`defaultPageSize`**: the page size used when `?page=` arrives without `pageSize`.
  Default 50, still clamped by `maxLimit`.
- **`maxPage`**: the highest page a client may request, refused with 400 beyond it. Off by
  default. `?page=9999999` is a cheap request that makes the database walk every skipped index
  entry before returning anything; this and `maxTimeMS` are what bound it.

### Security

- **Prototype pollution in request bodies.** `JSON.parse` makes `__proto__` a real own
  property, so `{"__proto__": {"isAdmin": true}}` survived the field filter and re-pointed the
  payload object's prototype on assignment — after which `payload.isAdmin` read `true` without
  the key ever appearing in `Object.keys`. `constructor` and `prototype` passed through as
  ordinary field names. All three are now refused wherever a key is read: request bodies,
  nested values, QUERY filters, and the return value of a `validate` hook.

### Changed — structure

- `ControllerSets` is now the surface only: one method per route, each delegating to its own
  module. The logic lives in `src/core/` — `getAll`, `query`, `get`, `create`, `update`,
  `delete` for the routes; `list` for the retrieval both reads share; `config`, `readParams`,
  `search`, `write`, `dataAccess`, `cursor`, `respond`, `handler` beneath them.
- `GET /` and `QUERY /` now run the same `core/list.js`, so the two cannot diverge in what
  they return, what they cap, or what they cost.
- `core/index.js` is the barrel everything outside `core/` imports from. Modules inside it
  import each other directly, so the dependency graph stays acyclic and readable.
- **`getById` is now `get`, and `queryAll` is now `query`.** Both old names remain as
  deprecated aliases, so existing routers keep working.
- The `controller.query` property — the array of names passed as the `query` option — is gone,
  because the name now belongs to the QUERY handler. Read it from `controller.config.query`.
- No behaviour changed otherwise: the same options, routes, responses and error messages. The
  full suite that covered 3.0 passes unmodified.

### Behaviour worth knowing

- An unknown key in a QUERY body is a `400`, not something ignored. A quietly ignored
  `{"filters": …}` is a request to return the whole collection.
- A body sent without a JSON content type is a `415`; so is a JSON body that no mounted parser
  handled, which is the honest answer when `express.json()` is missing rather than a silent
  unfiltered read.
- A QUERY with no body at all is a valid request for an unfiltered, still-capped list.
- `QUERY` is a collection method only. `QUERY /:id` is not routed.

### Changed

- Internal only: `GET /` and `QUERY /` now share one filter, search, sort and pagination path,
  so a future hardening applies to both. `getPaginatedResults` keeps its signature, and page
  bounds are clamped in one place.
- `?sort=` with a non-string value (a repeated `?sort=a&sort=b`) now returns `400` instead of
  a `500`, and the literal `?sort=none` is now validated like any other field name rather than
  being read as "no sorting" — `none` is a sentinel for the `orderBy` option, not a field a
  client can name.

---

## [3.0.0] — 2026-07-20

Security release. Several defaults in 2.x were exploitable on any public endpoint.
**Every fix below is a breaking change**, because the insecure behaviour *was* the default.
See [MIGRATION.md](MIGRATION.md) for the upgrade path, including a `legacyMode` bridge.

### Security

- **Mass assignment.** `POST` and `PATCH` passed the entire request body to Mongoose, so any
  schema-defined field (`role`, `isAdmin`, `balance`) was client-writable. Added
  `allowedFields` / `blockedFields` with per-verb control. `_id`, `__v`, `createdAt`,
  `updatedAt`, `$`-prefixed keys and dotted keys are now stripped unconditionally, including
  in nested values.
- **Field-name injection.** `?compareField=`, `?rangeField=` and `?sort=` accepted any field
  name, bypassing the `query` allowlist. A client could filter on a field excluded from the
  response — such as a password hash or reset token — and recover its value by binary-searching
  the result counts. These now resolve against `filterableFields` / `sortableFields`
  (defaulting to `query`) and return `400` otherwise.
- **Stored XSS via S3 uploads.** The stored `Content-Type` came from the client's multipart
  header and there was no type validation, so HTML labelled `image/png` was served as
  executable content on the bucket's origin. Content type and file extension are now derived
  from the file's bytes; `allowedMimeTypes` defaults to common images plus PDF; anything
  outside a strict inline allowlist is stored `Content-Disposition: attachment`.
- **Default upload ACL is now `private`.** Previously hardcoded to `public-read` with no
  opt-out. Existing objects are unaffected — audit your bucket separately.
- **Regex denial of service.** Search terms went to `$regex` unescaped, so `?s=(a+)+$` caused
  catastrophic backtracking inside mongod. Terms are now escaped and capped at
  `maxSearchLength` (128). Raw patterns remain available via `allowRawRegex`.
- **Unbounded reads.** `GET /` without `?page` returned the entire collection. All reads are
  now capped at `maxLimit` (default 100).
- **Operator injection through filter values.** The `query` allowlist validated keys but not
  values. Under `query parser: 'extended'` — which the host app controls, not this library —
  `?status[$ne]=x` became an operator. Non-scalar values are now rejected; repeated params
  become `$in`.
- **Information disclosure in errors.** `err.message` was returned verbatim on 5xx, leaking
  connection strings, hostnames and bucket names. Unclassified 5xx responses now return a
  generic message plus a `requestId` for log correlation.
- **CPU amplification.** The image optimization level was read from query, body and two
  headers, letting any client force `high` (up to seven re-encodes of a multi-megabyte
  buffer). Now server-configured; opt in with `allowClientImageOptions`.

### Fixed

- Relational search truncated dotted paths to one level: `search: ['author.profile.name']`
  silently queried `profile` instead of `profile.name`.
- Non-optimizable formats (GIF, SVG, AVIF, HEIC) fell through to the JPEG encoder, producing
  JPEG bytes stored under a `.gif` key with `Content-Type: image/gif` — corrupt objects and
  lost animation. These now pass through untouched, and extensions are re-derived from the
  output bytes.
- `update` and `delete` performed a read followed by a separate write, leaving a TOCTOU
  window. Both are now a single atomic query.
- Duplicate-key violations (`code: 11000`) returned `500`; they now return `409`.
- `runValidators` now passes `context: "query"`, so custom update validators using `this`
  behave correctly.
- Removed a stray `console.log` of parsed range values from the request path.
- Reads are no longer `.lean()` by default. `.lean()` bypasses schema `toJSON` transforms,
  which is a common place to strip sensitive fields — meaning 2.x could defeat that stripping
  on list endpoints. Set `lean: true` to restore the previous behaviour.
- String-form `search` read `?<fieldname>` while array-form read `?s` / `?search`. Both now
  use `?s` / `?search`.

### Changed

- `ControllerSets` accepts an options object. The positional signature still works but is
  deprecated.
- `fileUploadMiddleware` accepts an options object as its fourth argument. The positional
  form (`uploadPath`, `fields`, `imgOptimizations`) still works.
- `createRouterS3upload` gained an `upload` option for ACL, mime allowlist and limits.
- No import-time side effects: the package no longer calls `dotenv.config()` or constructs an
  S3 client at module load. S3 configuration is read per request, so environment variables
  loaded after import now take effect.
- `sharp` moved to `optionalDependencies`; `sharp`, `multer` and the AWS SDK are loaded
  lazily, so CRUD-only consumers no longer pay for a native binary.
- A startup warning is logged, once per model, when no field policy is configured.
- Added `maxFileSize`, `maxFiles`, `maxLimit`, `maxSearchLength`, `strictAfterCreate` and
  `logger` options.

### Removed

- `multer-s3` from `peerDependencies`. It was declared and documented but never imported by
  any code path.
- `dotenv` from `peerDependencies`. Loading environment is the host application's
  responsibility.

### Packaging

- Added a `files` field. The published tarball no longer ships `docs/` or `tests/`
  (26.4 kB → 18.2 kB).
- `index.d.ts` now covers `errorHandler`, `compressImage`, `HttpError` and `escapeRegex`,
  along with all new options.

---

## [2.3.5]

### Added

- Optional `onGet` lifecycle hook giving request-time control over `.populate()` and
  `.select()` on all GET operations.
- `sharp`-based image compression before S3 uploads.
