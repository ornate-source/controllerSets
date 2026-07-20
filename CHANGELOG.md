# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
