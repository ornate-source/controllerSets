# express-controller-sets — Security Audit & Implementation Plan

**Reviewed version:** 2.3.7
**Date:** 2026-07-20
**Scope:** `src/ControllerSets.js`, `src/router.js`, `src/s3upload.js`, `src/utils/errorHandler.js`, `src/index.js`, packaging

---

## Executive summary

This is a published npm package that generates public HTTP endpoints on top of arbitrary
Mongoose models. That amplifies every defect: a bug here is not one app's bug, it is a
vulnerability shipped to every consumer, most of whom will assume the library is safe by
default because it markets itself as "professional" and "robust."

The core architectural problem is a **missing trust boundary**. The library treats
`req.query` and `req.body` as configuration rather than as attacker-controlled input.
Three of the findings below let a client reach fields the API author never intended to
expose, and one lets a client host arbitrary HTML on the consumer's S3 domain.

**Verdict:** 3 critical, 3 high, 5 medium, ~10 low. The critical set should be treated as
a security release (`3.0.0`, secure-by-default, with documented escape hatches).

### What I actually verified vs. inferred

I ran the code rather than pattern-matching, and two things came back different from the
initial read — both are recorded honestly below:

| Claim | Result |
|---|---|
| `?compareField=password&compareOperator=gt&compareValue=` reaches the filter | **Confirmed** — verified against Express 5's default parser |
| `?s=(a+)+$` reaches Mongo's `$regex` unescaped | **Confirmed** |
| `?status[$ne]=x` operator injection | **Only under `query parser: 'extended'`.** Express 5 defaults to `simple`, which yields the literal key `"status[$ne]"`. Real, but conditional — do not overstate it |
| Path traversal via `file.originalname` | **NOT exploitable.** `path.extname()` strips directories; `"../../../etc/passwd"` → `""`. No finding here |
| GIF + `imgOptimizations` produces JPEG bytes under a `.gif` key | **Confirmed** by transcoding a real GIF through `compressImage()` |

---

## CRITICAL

### C1 — Mass assignment on `create` and `update`

`src/ControllerSets.js:239`, `src/ControllerSets.js:259`

```js
const result = await this.model.create(req.body);                    // create
findByIdAndUpdate(object._id, { $set: req.body }, { ... })           // update
```

The entire request body is passed to Mongoose with no field filtering. Any schema-defined
field is client-writable — `isAdmin`, `role`, `status`, `balance`, `emailVerified`,
`ownerId`. Mongoose's `strict` mode drops *unknown* paths, which is exactly what makes
this dangerous: it drops the harmless typos and faithfully persists the privilege
escalation.

```bash
curl -X POST /api/users -d '{"email":"x@y.z","password":"p","role":"admin"}'
```

This is the highest-impact finding because it requires no cleverness and the library
offers no mechanism to prevent it.

**Fix:** add `allowedFields` / `blockedFields`, resolved per-verb.

```js
// ControllerSets.js
#pickWritable(body, verb) {
    if (!body || typeof body !== "object") return {};
    const rules = this.writable[verb] ?? this.writable.default;
    let out = { ...body };
    // Always strip immutable/internal paths
    for (const k of ["_id", "__v", "createdAt", "updatedAt"]) delete out[k];
    if (rules.allow) {
        out = Object.fromEntries(
            Object.entries(out).filter(([k]) => rules.allow.includes(k))
        );
    }
    if (rules.block) {
        for (const k of rules.block) delete out[k];
    }
    return out;
}
```

Also reject body keys beginning with `$` or containing `.` before they reach `$set` —
dotted keys let a client write into nested subdocuments that no allowlist entry covers.

Emit a **startup warning** when neither `allowedFields` nor `blockedFields` is configured.
Consumers upgrading from 2.x will not read the changelog; the console will reach them.

---

### C2 — Arbitrary field-name injection via `compareField` / `rangeField` / `sort`

`src/ControllerSets.js:81-138`, `src/ControllerSets.js:207-213` — **verified exploitable
under default Express 5 config**

The `query` option exists precisely as a field allowlist. `compareField`, `rangeField`,
and `sort` bypass it entirely and accept any field name from the query string:

```js
const field = req.query.compareField;   // fully attacker-controlled
filters[field] = { [mongoOp]: val };
```

This is a **blind data-exfiltration oracle**. Even when `onGet` selects a field away from
the response, the field is still *filterable*, and the response tells you whether the
predicate matched:

```
GET /api/users?compareField=passwordResetToken&compareOperator=gt&compareValue=a   → 12 results
GET /api/users?compareField=passwordResetToken&compareOperator=gt&compareValue=m   → 5 results
```

Binary-search each character. Password hashes, reset tokens, TOTP secrets, and internal
flags are all recoverable from an endpoint that "only returns public fields." `sort` gives
a second oracle over the same fields, plus unindexed-field sorts as a DoS lever.

**Fix:** resolve every client-supplied field name against an explicit allowlist. Reuse
`query` as the default filterable set, with optional `filterableFields` / `sortableFields`
overrides. Reject unknown fields with 400 rather than silently ignoring — silent drops
train consumers to think the allowlist is working when it is not.

```js
#assertFilterable(field) {
    const allowed = this.filterableFields ?? this.query;
    if (!allowed.includes(field)) {
        const e = new Error(`Field '${field}' is not filterable.`);
        e.status = 400;
        throw e;
    }
    return field;
}
```

---

### C3 — Client-controlled `Content-Type` + `public-read` + no file-type filter → stored XSS

`src/s3upload.js:265-271`

```js
ACL: "public-read",                                  // hardcoded, not configurable
ContentType: file.mimetype || "application/octet-stream",   // from the client
```

`file.mimetype` is taken from the `Content-Type` header of the multipart part — the
attacker writes it. There is no `fileFilter` on the multer instance, so content is
unvalidated too. The three defects compose:

1. Upload a file whose bytes are HTML and whose part header says `text/html`
2. It is stored with `ACL: public-read` and served back as `text/html`
3. Any visitor to that S3 URL executes attacker JavaScript **on the bucket's origin**

If the bucket is mapped to a subdomain of the app (`cdn.example.com`) and cookies are
scoped to `.example.com`, this is session theft. `image/svg+xml` gives the same primitive
past a naive `startsWith("image/")` check — which is exactly the check on line 241.

`ACL: "public-read"` being hardcoded is independently wrong. Consumers uploading ID
documents, medical records, or invoices get world-readable objects with no opt-out.

**Fix (all four parts — any one alone is insufficient):**

- Sniff the real type from the buffer (`file-type`) and **ignore `file.mimetype`** for
  both `ContentType` and the extension. Reject on mismatch.
- Default `allowedMimeTypes` to a conservative image/document set; make it configurable.
  Deny `text/html`, `image/svg+xml`, `application/xhtml+xml` unless explicitly opted in.
- Make ACL configurable, **default `private`**. This is a breaking change and is the
  correct default; document the migration prominently.
- Set `ContentDisposition: "attachment"` for anything not on a strict inline allowlist.

---

## HIGH

### H1 — ReDoS via unescaped user input in `$regex`

`src/ControllerSets.js:158`, `:180`, `:202` — **verified**

```js
{ $regex: String(searchTerm), $options: "i" }
```

`String()` prevents object injection but does nothing about regex metacharacters. The raw
client string becomes a server-side pattern. `?s=(a+)+$` triggers catastrophic
backtracking **inside mongod**, burning a database core per request — a database-tier DoS
from an unauthenticated GET. `?s=^` and `?s=.*` are also full-collection scans.

Note the commit history describes case-insensitive regex search as a documented feature,
so this may be partly intentional. Even so, exposing raw regex to unauthenticated clients
is not a safe default.

**Fix:** escape by default; make raw regex opt-in and clearly labelled as trusted-callers-only.

```js
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
```

Also cap search-term length (~128 chars) and prefer a MongoDB **text index** where the
consumer has one — it is both faster and immune to this class of bug.

---

### H2 — Unbounded `getAll` when `?page` is absent

`src/ControllerSets.js:217-222`

Pagination caps `pageSize` at 100 — but only on the paginated path. Omit `?page` and you
get `find(filters)` with no limit at all: the entire collection serialized into one JSON
response. On a large collection this OOMs the Node process. It is a one-request DoS, and
the naive caller (`GET /api/products`) triggers it by accident in production.

**Fix:** always apply a `maxLimit` (default 100). Consider making pagination the default
response shape in 3.0.0, with `?all=true` gated behind an explicit `allowUnbounded` option.

---

### H3 — NoSQL operator injection through the `query` allowlist values

`src/ControllerSets.js:74-79`

```js
acc[queryKey] = req.query[queryKey];   // value not validated
```

The allowlist covers the *key* but never the *value*. Under Express 5's default `simple`
parser this is not exploitable (verified: `?status[$ne]=x` produces the literal key
`"status[$ne]"`). But `app.set('query parser', 'extended')` is common, widely
recommended in older tutorials, and entirely outside this library's control — and under it
`?status[$ne]=archived` becomes `{ status: { $ne: "archived" } }`.

A library cannot assume its host app's parser configuration. Treat the value as hostile
regardless.

**Fix:** coerce scalars — reject or stringify any value that is a non-array object, and
strip keys starting with `$`. Related: `?tag=a&tag=b` yields an array, which Mongo
interprets as exact array-equality rather than an `IN` — surprising, and worth handling
explicitly as `$in`.

---

## MEDIUM

### M1 — Client-controlled `imgOptimizations` → CPU amplification
`src/s3upload.js:200-207`

The optimization level is read from query, body, **and two headers** before falling back to
the server-configured default — so a client can override server config and force `high` on
every upload. `high` runs up to 7 sequential `sharp` re-encodes of a 10 MB buffer. A
handful of concurrent uploads saturates the event loop and the native thread pool.

**Fix:** server configuration only. If per-request control is genuinely needed, allowlist
the values and gate it behind an explicit `allowClientImageOptions: true`.

### M2 — `errorHandler` leaks internal error messages on 5xx
`src/utils/errorHandler.js:10-11`

`err.message` is returned verbatim for unclassified errors. Mongoose and the AWS SDK put
connection strings, hostnames, bucket names, and index details in messages. Stack traces
are correctly gated on `NODE_ENV`; the message is not.

**Fix:** for `statusCode >= 500`, always return a generic `"Internal Server Error"` and log
the detail server-side. Add a `requestId` to correlate. Also map Mongo duplicate-key
(`code: 11000`) to **409** with a field name instead of the current 500.

### M3 — Import-time side effects and eager S3 client
`src/s3upload.js:7-37`

`src/index.js` re-exports `s3upload.js`, so **merely importing `ControllerSets` runs
`dotenv.config()`, constructs an `S3Client`, and prints two warnings** — confirmed in
testing above. Consumers who never touch S3 get spurious warnings, and a library silently
mutating the host app's `process.env` is a real overreach.

Worse, `missingEnv` is computed once at import time: an app that loads env vars *after*
importing gets a permanent 503 from a correctly-configured server.

**Fix:** remove `dotenv.config()` entirely (the host app owns env loading), lazily
construct the S3 client on first use, and re-check config per request. Move `sharp` and the
AWS SDK to dynamic `import()` so the CRUD path never loads them.

### M4 — Image transcode corrupts extension and Content-Type
`src/s3upload.js:102-114` — **verified**

`format` is derived from the client's mimetype and only `png`/`webp` are special-cased;
everything else falls to the `.jpeg()` branch. A GIF becomes **JPEG bytes stored under a
`.gif` key with `ContentType: image/gif`** (confirmed by round-tripping a real GIF).
Animation is silently lost. `image/svg+xml` → `"svg+xml"` → also rasterized to JPEG, and
routing untrusted SVG through librsvg carries its own external-entity risk.

**Fix:** derive format from the sniffed buffer, not the header; preserve the input format
(`gif()` for GIF, or skip animated images); and derive the stored extension and
`ContentType` from the **actual output format** after transcoding.

### M5 — Nested relational search silently truncates to depth 1
`src/ControllerSets.js:149`

```js
const [relation, childField] = field.split(".");
```

`search: ["author.profile.name"]` becomes `relation="author"`, `childField="profile"` —
the rest is dropped and the query silently searches the wrong field. Since the README
advertises relational dot-notation search, this fails in the documented use case.

**Fix:** split on the first `.` only (`const idx = field.indexOf(".")`) and pass the
remainder through as a nested path. Validate the path against the ref'd schema at
construction time and throw on an unresolvable path — fail loudly at boot, not silently per
request.

---

## LOW / correctness & hygiene

| # | Location | Issue |
|---|---|---|
| L1 | `ControllerSets.js:84` | `console.log(rangeParts)` — debug statement shipped to production |
| L2 | `ControllerSets.js:62` | `getObjectById` applies `select(selects)`; an `onGet` returning `"-_id ..."` makes `object._id` undefined → `findByIdAndUpdate(undefined)` |
| L3 | `ControllerSets.js:256-265` | `update`/`delete` fetch then re-query by id: two round trips plus a TOCTOU window. Use a single atomic `findByIdAndUpdate` / `findByIdAndDelete` and 404 on null |
| L4 | `ControllerSets.js:229`, `:221` | `getById` returns a hydrated doc, `getAll` returns `.lean()` — inconsistent serialization (getters/virtuals apply to one, not the other) |
| L5 | `ControllerSets.js:196-205` | String-form `search` reads `req.query[this.search]` while array-form reads `?s`/`?search`. Two incompatible contracts on one option |
| L6 | `ControllerSets.js:263` | `runValidators: true` without `context: "query"` — custom validators using `this` misbehave on update |
| L7 | `ControllerSets.js:240-248` | `runAfterCreate` errors are swallowed with a log; a failed side effect returns 201. Add `strict` mode or document loudly |
| L8 | `ControllerSets.js:294` | `countDocuments` on every paginated request is expensive on large collections. Offer `withCount: false` |
| L9 | `package.json` | No `files` field — `docs/` and `tests/` ship to npm (33 kB of the 26 kB tarball). Add `"files": ["src"]`. Also risks publishing stray dotfiles |
| L10 | `package.json` | `sharp` is a hard dependency (large native binary) for an optional feature. Move to `optionalDependencies` + dynamic import |
| L11 | `s3upload.js:177` | `fileSize` hardcoded at 10 MB; no `files` count limit → many-small-files memory exhaustion via `memoryStorage` |
| L12 | `s3upload.js:258` | Extension taken from client filename with no charset/length bound (`.php`, 40-char extensions accepted). Not traversable — verified — but should still be allowlisted `/^\.[a-z0-9]{1,8}$/i` |
| L13 | repo | No CI, no linter, no `CHANGELOG.md`; README changelog stops at 2.3.5 while the package is 2.3.7 |
| L14 | `index.d.ts` | Types omit `errorHandler` and `compressImage`, both exported from `src/index.js` / `s3upload.js` |
| L15 | tests | Mocks are hand-rolled and diverge from Mongoose (e.g. the mock ignores `$set` operators and casting), so they cannot catch any finding above. No test asserts a *rejection* |

---

## Implementation plan

Sequenced by risk-reduction per unit of effort. Phase 1 is the security release; ship it
before anything else.

### Phase 1 — Security release `3.0.0` (breaking, intentional) — ✅ SHIPPED

| Step | Finding | Files | Status |
|---|---|---|---|
| 1.1 | Add `escapeRegex()`; escape all search input; cap term length | `utils/sanitize.js`, `ControllerSets.js` | ✅ |
| 1.2 | Add `#assertAllowed`; gate `compareField`, `rangeField`, `sort` | `ControllerSets.js` | ✅ |
| 1.3 | Add `allowedFields`/`blockedFields`; strip `$`-prefixed and dotted body keys | `utils/sanitize.js`, `ControllerSets.js` | ✅ |
| 1.4 | Sanitize allowlisted query *values*; array → `$in` | `utils/sanitize.js` | ✅ |
| 1.5 | Enforce `maxLimit` on the unpaginated path | `ControllerSets.js` | ✅ |
| 1.6 | Sniff file type; add `allowedMimeTypes`; derive `ContentType`/extension from bytes | `utils/fileType.js`, `s3upload.js` | ✅ |
| 1.7 | Make ACL configurable, default `private`; add `ContentDisposition` | `s3upload.js` | ✅ |
| 1.8 | Move `imgOptimizations` to server-side config | `s3upload.js` | ✅ |
| 1.9 | Generic 5xx messages; `11000` → 409; `requestId` | `utils/errorHandler.js` | ✅ |
| 1.10 | Startup warning when no field policy is configured | `ControllerSets.js` | ✅ |

Phase 2 items were pulled forward and shipped alongside, since they touched the same
functions: import-time side effects (M3), lazy `sharp`/AWS SDK loading, format preservation
(M4), full-depth relational search (M5), atomic update/delete (L3), unified search contract
(L5), `context: "query"` (L6), removed `console.log` (L1), `files` field (L9), `sharp` moved
to `optionalDependencies` (L10), completed `index.d.ts` (L14), rebuilt test doubles (L15).

**Verification:** 69 tests passing, including regression tests for C1, C2, C3, H1, H2, H3, M1,
M2 and M4. `npm pack` down from 26.4 kB / 13 files to 18.2 kB / 11 files. `tsc --strict` clean.

#### Residual risk accepted in 3.0

**Mass assignment is still possible when unconfigured.** `allowedFields` defaults to
"everything writable" rather than deny-all, because a deny-all default would return 400 on
every write for every existing 2.x app. The mitigation is a startup warning naming the model.
This is the one finding not fully closed by default, and it should become deny-all in 4.0
once the ecosystem has migrated.

#### Two discoveries made during implementation

- **`multer-s3` was a phantom dependency** — declared in `peerDependencies` and in the README
  install line, but never imported anywhere in the source. Removed.
- **`.lean()` on `getAll` was itself a leak vector.** It bypasses
  `schema.set("toJSON", { transform })`, which is how many consumers strip `password` and
  similar fields. 2.x was silently defeating that on list endpoints. Reads are now non-lean by
  default, with `lean: true` to opt back in.

### Phase 3 — Hardening & maintainability — ✅ DONE

- `tests/helpers/mockModel.js`: chainable, thenable model double that records the filter,
  sort, limit, populate, select and update actually handed to Mongoose. The previous mocks
  resolved only via `.lean()` and ignored `$set`, which is precisely why they caught nothing.
- `tests/integration.test.js`: **10 tests against real MongoDB** via `mongodb-memory-server`,
  skipped cleanly when the package is absent so the suite still runs offline (verified).
- `.github/workflows/ci.yml`: Node 18/20/22 matrix, `tsc --strict`, `npm audit`, plus two
  guards that assert the tarball carries no `docs/`/`tests/`/dotfiles and that importing the
  package emits no console output.
- `CHANGELOG.md` added; `package.json` version bumped to 3.0.0.

**Total: 79 tests passing** (was 22).

### Phase 4 — Documentation — ✅ DONE

- New **Security Model** section in `docs/index.html` plus sidebar entry, covering the two
  things the library deliberately does not do for you (auth, field policy).
- Every copyable example updated with `allowedFields` / `filterableFields` / `sortableFields`.
- Constructor table extended with all 11 new options; upload options documented separately.
- Status-code table added; error-response shape updated with `requestId`.
- `MIGRATION.md` (11 breaking changes, before/after each) and README changelog.

### What real MongoDB confirmed that the mocks could not

The unit tests assert on the filter objects the controller *builds*. Only the integration
tests show what Mongoose and the driver then *do* with them:

- `{ role: "admin" }` in a create body does not reach the stored document — verified by
  reading the collection directly, bypassing the API's own response shaping.
- An escaped `(a+)+` matches zero documents while the literal `a+b` matches exactly one,
  proving the escape reaches mongod rather than merely looking right in a filter object.
- Repeated params cast to a working `$in` against real schema types.
- A real unique index produces `code: 11000` → 409 with the offending field named.
- **The `.lean()` finding was confirmed empirically**: with `lean: true` the string
  `hunter2` appears in the list response; with the new default it does not. 2.x was
  defeating consumers' `toJSON` transforms on list endpoints.

### Bugs found in my own work during verification

Recorded because they are the reason to run tests rather than trust a diff:

- `{ new: true }` on `findByIdAndUpdate` triggered a Mongoose deprecation warning; the 2.x
  code had it right with `returnDocument: "after"`. Reverted.
- Three assertions in the upload suite were wrong, not the code: the AWS SDK appends
  `?x-id=PutObject` to request URLs, and the 16×16 test PNG is 102 bytes against a
  1024-byte limit it was supposed to exceed.
- A pre-existing unclosed `<section>` in `docs/index.html` (present in `HEAD`, not
  introduced here) left the footer nested inside the last section. Fixed.
- `docs/index.html` documented `pageSize` as defaulting to 10; the code has always used 50.

### Remaining work

Nothing blocking release. Optional follow-ups:

- `supertest` in place of `app.listen(0)` + `fetch` — cosmetic; the current helper is fine.
- `tsd` type tests. `tsc --strict` in CI covers declaration validity but not inference.
- **4.0 candidate:** make `allowedFields` deny-by-default, closing the one residual risk
  above.

**Migration story matters as much as the fixes.** Every item above can break a working
2.x app. Ship with: a `MIGRATION.md` with before/after for each option, a single
`legacyMode: true` escape hatch that restores 2.x behavior while printing a loud
deprecation warning, and a GitHub security advisory so `npm audit` reaches people who
never read release notes.

### Phase 2 — Correctness

2.1 Remove `dotenv.config()`; lazy S3 client + per-request config check (M3)
2.2 Dynamic-import `sharp`/AWS SDK; move `sharp` to `optionalDependencies` (M3, L10)
2.3 Fix format preservation and extension/ContentType agreement (M4)
2.4 Fix nested-search depth; validate search paths at construction (M5)
2.5 Atomic single-query update/delete; drop the double fetch (L3, L2)
2.6 Consistent `.lean()` across read paths (L4)
2.7 Remove `console.log`; route logging through an injectable `logger` (L1)
2.8 Unify the string/array `search` contract (L5)

### Phase 3 — Hardening & maintainability

3.1 Replace hand-rolled mocks with `mongodb-memory-server` — the current mocks cannot
    reproduce a single finding above, which is why none were caught
3.2 Add regression tests per finding: operator injection, `compareField` on a non-allowlisted
    field, ReDoS payload, mass-assignment `role: "admin"`, `text/html` upload, unbounded list
3.3 `supertest` instead of `app.listen(0)` + `fetch` per test
3.4 GitHub Actions: test matrix (Node 18/20/22), `npm audit`, lint
3.5 `"files": ["src"]`; add `.npmignore` (L9)
3.6 Complete `index.d.ts`; add `tsd` type tests (L14)
3.7 `CHANGELOG.md`; align README

### Phase 4 — Documentation

4.1 A **Security Considerations** page: this library generates *public* endpoints; auth is
    the consumer's responsibility via `middlewares`, and field policy is mandatory, not optional
4.2 Every example in README and `docs/index.html` updated to show `allowedFields` — most
    users copy the first example verbatim and never revisit it
4.3 Document the S3 ACL default change and how to opt back into public objects

---

## Design note

Beyond the individual bugs, the pattern worth changing is **implicit-deny vs. implicit-allow**.
Today, everything is exposed unless the consumer thinks to restrict it, and there is no
mechanism to restrict most of it. A generator that produces public API surface should invert
that: nothing is filterable, sortable, writable, or publicly readable until the author names
it. That single principle is what C1, C2, C3, and H2 all reduce to, and adopting it would
have prevented all four.
