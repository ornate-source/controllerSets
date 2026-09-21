# express-controller-sets — guide for AI coding assistants

You are writing code that uses **express-controller-sets** (v3.2), a library that turns a Mongoose
model into a complete, secure REST API, and adds a full authentication API against the user's own
user model. Follow this guide exactly. When the guide and your prior knowledge disagree, the guide
wins. Do not invent options, exports or endpoints that are not listed here.

Docs: https://ornate-source.github.io/controllerSets/

## Environment

- ES modules only (`import`, `"type": "module"`). From CommonJS use `await import('express-controller-sets')`.
- Node 18+ (the HTTP `QUERY` route needs Node 22.2+; on older Node it is skipped with one warning).
- Peer dependencies the app installs: `express` 5, `mongoose` 9.
- Optional peers, only when used: `multer` + `@aws-sdk/client-s3` (uploads), `sharp` (image compression), `nodemailer` (the default mail sender built from `SMTP_*`), `ioredis` or `redis` (response cache).
- The library never calls `dotenv`. The app loads env first: `import 'dotenv/config'` as the first import, or `node --env-file=.env`.
- TypeScript types ship with the package.

```bash
npm install express-controller-sets express mongoose
```

## Exports

```js
import {
  createRouter,          // CRUD router for one model
  createRouterS3upload,  // CRUD router + multipart S3 uploads
  ControllerSets,        // the handlers, for custom routers
  createAuthRouter,      // authentication API
  errorHandler,          // JSON error middleware — mount LAST
  HttpError,             // throw new HttpError(status, safeMessage)
  ValidationError,       // throw new ValidationError(message, { field: 'msg' }, status = 400)
  identifier,            // identifier('field', normalizeFn) for auth
  isQueryMethodSupported,
  escapeRegex, compressImage, fileUploadMiddleware,
  requireAuth, requireRole, buildAuthConfig,
  hashPassword, verifyPassword, signToken, verifyToken,
  BUILT_IN_PROVIDERS, DEFAULT_TEMPLATES, AUTH_ROUTES,
  createMemoryCacheStore, createRedisCacheStore,
} from 'express-controller-sets';
```

## The minimal correct app

```js
import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import { createRouter, errorHandler } from 'express-controller-sets';
import Product from './models/Product.js';

const app = express();
app.use(express.json());                        // required: bodies are read from req.body

app.use('/api/products', createRouter({
  model: Product,
  orderBy: '-createdAt',                        // default sort
  query: ['category', 'isFeatured'],            // ?category=… equality filters
  search: ['name', 'description'],              // ?s=term or ?search=term
  allowedFields: ['name', 'price', 'description', 'category', 'isFeatured'], // writable fields
  filterableFields: ['price', 'category'],      // usable in range/compare filters and QUERY filter
  sortableFields: ['price', 'name', 'createdAt'],
}));

app.use(errorHandler);                          // always after every router

await mongoose.connect(process.env.MONGODB_URI);
app.listen(3000);
```

Every router serves: `GET /` (list), `QUERY /` (list with a JSON body), `POST /` (create),
`GET /:id`, `PATCH /:id` (partial update with `$set`), `DELETE /:id`. There is no `PUT`.

## Security rules — always apply

1. **Always set `allowedFields`** (or `blockedFields`). Without it every schema field — `role`, `isAdmin`, `ownerId` — is client-writable, and the library logs a warning.
2. **Every generated endpoint is public** until `middlewares` guards it. Guards apply to all six routes of that router.
3. When reads are public and writes are not, use **two routers on the same model**: a public one with `allowedFields: []`, and a guarded admin one.
4. Filters, range/compare fields and sort fields are allowlists (`query`, `filterableFields`, `sortableFields`). A field not listed is a `400`, never silently used.
5. Server-owned values (`ownerId`, `tenantId`, `createdBy`) are set in `validate.create`, never accepted from the client — keep them out of `allowedFields`.
6. Per-user record scoping is not built in. For lists, shadow `req.query` in a middleware (Express 5's `req.query` is a re-parsing getter — assigning to it or its properties does nothing):

   ```js
   const onlyMine = (req, res, next) => {
     Object.defineProperty(req, 'query', {
       value: { ...req.query, ownerId: String(req.auth.userId) },
       writable: true, configurable: true, enumerable: true,
     });
     next();
   };
   createRouter({ model: Note, middlewares: [auth.requireAuth, onlyMine],
                  query: ['ownerId'], enableQuery: false, /* … */ });
   ```

   `GET/PATCH/DELETE /:id` address one record directly — add a middleware that loads it and checks its owner, or keep those verbs on an admin-only router.
7. Never set `legacyMode: true` or `allowRawRegex: true` on endpoints reachable by untrusted clients.
8. Mount `errorHandler` last. Throw `HttpError` for client-safe messages; other errors become a generic 500 without leaking internals.

## Router options

| Option | Default | Meaning |
|---|---|---|
| `model` | required | Mongoose model |
| `orderBy` | none (unsorted) | Default sort, e.g. `'-createdAt'` |
| `query` | `[]` | Query-string equality filters; default for filterable/sortable |
| `search` | none | Field(s) for `?s=` / `?search=`; `'category.name'` searches a ref |
| `allowedFields` | all fields | Writable fields; `['a']` or `{ create: [...], update: [...] }` |
| `blockedFields` | none | Never writable; applied after `allowedFields` |
| `filterableFields` | `query` | Fields for `rangeField` / `compareField` and QUERY `filter` |
| `sortableFields` | `query` + `orderBy` field | Fields for `?sort=` and QUERY `sort` |
| `validate` | none | `fn(payload, ctx)` or `{ create, update }`; see below |
| `onGet` | none | `(req, res) => ({ populates, selects })` for GET routes |
| `runAfterCreate` | none | `async (doc) => {}` after POST; failures logged unless `strictAfterCreate` |
| `middlewares` | `[]` | Express middleware run before every route of the router |
| `enableQuery` | `true` | Mount the `QUERY /` route |
| `pagination` | `'offset'` | `'cursor'` for keyset pagination on large collections |
| `countStrategy` | `'exact'` | `'estimated'` or `'none'` (returns `hasMore` instead of totals) |
| `maxLimit` | `100` | Hard cap on returned documents |
| `defaultPageSize` | `50` | Page size when `?page=` has no `pageSize` |
| `maxPage` | off | Refuse deeper offset pages with 400 |
| `maxTimeMS` | off | MongoDB per-query time limit |
| `maxSearchLength` | `128` | Longest accepted search term |
| `maxRelationMatches` | `1000` | Cap on ids a relational search pulls |
| `lean` | `false` | Plain objects (skips schema `toJSON`) |
| `allowDiskUse`, `batchSize` | off | Driver passthroughs |
| `logger` | console | `{ warn, error, debug? }` |
| `cache` | off | `true` (uses `REDIS_URL`) or `{ ttl, url, client, store, prefix, vary, timeoutMs }` — see Caching |

## Caching (Redis)

```js
// npm install ioredis   (or redis) · .env: REDIS_URL=redis://localhost:6379
createRouter({ model: Product, cache: true, allowedFields: ['name', 'price'] });   // or cache: { ttl: 300 }
```

- Caches `GET /`, `QUERY /`, `GET /:id` (successful responses only); header `X-Cache: HIT|MISS`.
- Any successful `POST`/`PATCH`/`DELETE` clears that model's cache on every router, before responding.
- Keys include the mount path, parsed `req.query` (after middleware), `:id`, QUERY body, and
  `vary(req)` — default `req.auth?.userId`, so signed-in users never share entries. `vary: () => ''` shares.
- Redis down/slow → served from MongoDB (each call bounded by `timeoutMs`, default 150). Never an error.
- Changes made outside the routes: `await router.invalidateCache()` (or `controller.invalidateCache()`), else `ttl` expiry.
- Env: `REDIS_URL`, `CACHE_TTL` (60), `CACHE_PREFIX` (`cs:`), `CACHE_ENABLED=false` kill switch.
- No Redis locally: `cache: { store: createMemoryCacheStore() }`.

## Query string (GET /)

```
?page=2&pageSize=20                 paginate (adds a pagination block); pageSize alone does NOT paginate
?s=laptop  or  ?search=laptop       literal, case-insensitive, OR across search fields
?sort=-price                        one field, must be in sortableFields; '-' = descending (multi-key: QUERY only)
?category=65af…                     equality on a `query` field; repeat for $in
?rangeField=price&range=10-100      inclusive; either side optional
?compareField=price&compareValue=50&compareOperator=gt   gt|gte|lt|lte|ne|eq
?cursor=…                           cursor mode only (then ?page= is refused)
```

Filters combine with AND; search is an OR group ANDed with the rest.

## HTTP QUERY (body-based read)

```http
QUERY /api/products
Content-Type: application/json

{ "filter": { "category": "chairs", "price": { "gte": 50, "lte": 250 }, "tags": ["a", "b"] },
  "search": "oak", "sort": ["-price", "name"], "page": 1, "pageSize": 20 }
```

Operators: `eq ne gt gte lt lte in nin` — written **without `$`**. Filter fields must be in
`filterableFields`, sort fields in `sortableFields`; unknown keys are a 400. Response equals the
matching `GET`. Keys: `filter`, `search`, `sort`, `page`, `pageSize`, `limit`, `cursor`.

## Responses

```jsonc
{ "success": true, "data": [ … ] }                                          // list
{ "success": true, "data": [ … ], "pagination": { "currentPage": 2, "pageSize": 20, "totalPages": 7, "totalRecords": 132 } }
{ "success": true, "data": [ … ], "pagination": { "pageSize": 50, "hasMore": true, "nextCursor": "…" } } // cursor
{ "success": true, "data": { … } }                                          // get / create / update
{ "success": true, "message": "Item successfully deleted." }                // delete
{ "success": false, "error": "Entry not found." }                          // any error
{ "success": false, "error": "Check the submitted values.", "fields": { "price": "must not be negative" } }
```

Status codes: 400 bad input, 401 unauthenticated, 403 forbidden, 404 not found, 409 duplicate key,
413 JSON body over the `express.json()` limit, 503 misconfigured dependency (e.g. S3 env missing), 500 unexpected.

## Validation and hooks

```js
import { createRouter, ValidationError } from 'express-controller-sets';

createRouter({
  model: Product,
  allowedFields: ['name', 'price'],
  validate: {
    create: (payload, { req }) => {
      if (payload.price < 0) throw new ValidationError('Check the submitted values.', { price: 'must not be negative' });
      return { ...payload, ownerId: req.auth.userId };   // returning an object replaces the payload
    },
    update: (payload, { id }) => { /* return nothing to accept as-is */ },
  },
  onGet: (req) => ({ populates: [{ path: 'category', select: 'name' }], selects: '-internalNotes' }),
  runAfterCreate: async (doc) => { await notify(doc); },
});
```

`validate` receives the payload after the field policy and before Mongoose validators; a
schema-`required` field may still be missing there.

## Uploads (S3-compatible)

```js
import { createRouterS3upload } from 'express-controller-sets';

app.use('/api/documents', createRouterS3upload({
  model: Document,
  path: 'documents/',                                  // key prefix
  fields: [{ name: 'file', maxCount: 1 }, { name: 'pages', maxCount: 10, formatToUrlObject: true }],
  imgOptimizations: 'medium',                          // 'low' | 'medium' | 'high' (needs sharp)
  upload: { acl: 'private', allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
            maxFileSize: 5 * 1024 * 1024, maxFiles: 5 },
  allowedFields: ['title', 'file', 'pages'],
}));
```

Clients send `multipart/form-data`; the file field names must match `fields`. Env:
`S3_ENDPOINT`, `S3_SPACES_KEY`, `S3_SPACES_SECRET`, `S3_BUCKET_NAME`, optional `S3_REGION`.
Uploads are private by default; types are checked by content sniffing.

## Authentication

```js
import { createAuthRouter, createRouter } from 'express-controller-sets';

const auth = createAuthRouter({
  model: User,
  identifiers: ['email', 'phone'],                     // sign in with either
  token: { secret: process.env.JWT_SECRET, expiresIn: '15m' },   // secret ≥ 32 chars, from env
  roles: { list: ['user', 'staff', 'admin'], default: 'user', admin: ['admin'] },
  registerFields: ['name'],                            // extra fields a registrant may set
  updateFields: ['name'],                              // fields a user may change on themselves
  refresh: { enabled: true, rotate: true, expiresIn: '30d' },
  appName: 'Acme',
  mail: { transporter: nodemailer.createTransport(process.env.SMTP_URL), from: 'Acme <no-reply@acme.com>' },
  sms: { sender: async ({ to, text }) => twilio.messages.create({ to, from: process.env.TWILIO_FROM, body: text }) },
  social: { google: { clientId: process.env.GOOGLE_CLIENT_ID } },
});

app.use('/api/auth', auth);
app.use('/api/notes', createRouter({ model: Note, middlewares: [auth.requireAuth], allowedFields: ['title', 'body'] }));
app.use('/api/admin/users-report', createRouter({ model: Report, middlewares: [auth.requireAuth, auth.requireRole('admin')], allowedFields: [] }));
```

After `auth.requireAuth`, `req.auth = { userId, role, claims }`. Clients send
`Authorization: Bearer <token>`. Always use `auth.requireAuth` / `auth.requireRole(...)` from the
router instance — they share its configuration.

### User schema the app must define

The library defines no schema. Defaults (rename any via `fields: { … }`):

```js
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, sparse: true },
  phone: { type: String, unique: true, sparse: true },
  name: String,
  password: { type: String, select: false },
  role: { type: String, default: 'user' },
  googleId: String, appleId: String, facebookId: String, githubId: String,
  otpHash: { type: String, select: false },
  otpPurpose: { type: String, select: false },
  otpExpiresAt: { type: Date, select: false },
  otpAttempts: { type: Number, default: 0, select: false },
  failedLoginAttempts: { type: Number, default: 0, select: false },
  lockedUntil: { type: Date, select: false },
  passwordChangedAt: Date,
  refreshTokens: {                                    // only if refresh tokens are enabled
    type: [{ id: String, hash: String, previousHash: String, rotatedAt: Date,
             createdAt: Date, lastUsedAt: Date, expiresAt: Date, userAgent: String }],
    select: false,
  },
}, { timestamps: true });
```

### Auth endpoints and bodies

| Method & path | Body | Access |
|---|---|---|
| `POST /register` | `{ email?, phone?, password, ...registerFields }` | public |
| `POST /login` | `{ identifier, password }` | public |
| `POST /social/:provider` | google/apple `{ idToken }`, facebook `{ accessToken }`, github `{ accessToken }` or `{ code }` | public |
| `POST /password/forgot` | `{ identifier, channel?: 'email' \| 'sms' }` | public |
| `POST /password/reset` | `{ identifier, code, newPassword }` | public |
| `POST /password/change` | `{ currentPassword, newPassword }` | signed in |
| `POST /token/refresh` | `{ refreshToken }` | public (refresh enabled) |
| `POST /logout` | `{ refreshToken }` | public (refresh enabled) |
| `POST /logout/all` | — | signed in (refresh enabled) |
| `GET /me` | — | signed in |
| `GET /users`, `GET /users/:id` | — | admin / signed in |
| `PATCH /users/:id` | `updateFields` only | self or admin |
| `PATCH /users/:id/roles` | `{ role }` or `{ roles: [] }` | admin |

Sign-in responses: `{ success: true, data: { token, expiresIn, user, refreshToken?, refreshExpiresIn? } }`.

Rename or remove routes with `routes: { register: '/signup', social: false }`; add per-route
middleware with `middlewares: { all: [cors()], login: [rateLimiter] }`. `auth.urls` lists what was
mounted.

### Refresh tokens

Off by default. Enable with `refresh: { enabled: true }` or `AUTH_REFRESH_ENABLED=true`. Rotation
with `refresh.rotate` or `AUTH_REFRESH_ROTATE=true|false` (default true). Lifetime with
`refresh.expiresIn` or `AUTH_REFRESH_EXPIRES_IN` (default `30d`). Code options override env.
Other options: `graceSeconds` (10), `revokeAllOnReuse` (true), `maxSessions` (5). Requires the
`refreshTokens` schema field. Replaying a rotated-away token revokes the user's sessions; password
change/reset revokes all refresh tokens.

Client pattern: keep the access token short-lived (`15m`); on a 401, call `POST /token/refresh`
once with the stored refresh token, store the returned `refreshToken` (it changes when rotating),
retry the request; if refresh fails, sign the user out.

### Sending one-time codes (mail and SMS)

- Mail default sender = a nodemailer-style transporter: `mail: { transporter, from }`, or env
  `SMTP_URL` / `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` + `MAIL_FROM`
  (install `nodemailer`).
- Swap mail sender: `mail.sender: async ({ to, subject, text, html, user, code, purpose, req }) => {}`.
- SMS has no default: `sms.sender: async ({ to, text, user, code, purpose, req }) => {}`.
- Templates per purpose (`passwordReset`): mail `{ subject, text?, html? }` strings, or a function
  returning them; SMS a string or a function returning one. Placeholders: `{{code}}`,
  `{{minutes}}`, `{{appName}}`, `{{user.<field>}}` (HTML-escaped in `html`).
- Recipient fields: `mail.toField` (default `email`), `sms.toField` (default `phone`).
- Legacy `otp.deliver({ user, code, channel, req })` overrides all of the above.

```js
mail: {
  transporter, from: 'Acme <no-reply@acme.com>',
  templates: { passwordReset: { subject: 'Reset your {{appName}} password',
                                html: '<p>Hi {{user.name}}, your code is <b>{{code}}</b> ({{minutes}} min).</p>' } },
},
sms: { sender, templates: { passwordReset: '{{appName}}: {{code}} is your code' } },
```

## Custom routes (every ControllerSets method)

Methods are pre-bound arrow functions — pass them directly. `get`, `update`, `delete` read
`req.params.id`, so the route parameter must be named `:id`. They send the response themselves;
client errors (400/404/409) are answered directly, unexpected errors are thrown to `errorHandler`.

`fileUploadMiddleware(req, res, next, { uploadPath, fields, acl, allowedMimeTypes, maxFileSize,
maxFiles, imgOptimizations, allowClientImageOptions })` uploads multipart files to S3 on any route
and puts the URL(s) on `req.body[field]` (plus `req.file(s)[].key` / `.location`).


```js
import express from 'express';
import { ControllerSets } from 'express-controller-sets';

const products = new ControllerSets({ model: Product, allowedFields: ['name', 'price'] });
const router = express.Router();
router.get('/', (req, res, next) => products.getAll(req, res).catch(next));
router.get('/:id', (req, res, next) => products.get(req, res).catch(next));
router.put('/:id', (req, res, next) => products.update(req, res).catch(next));
```

Methods: `getAll`, `query`, `get`, `create`, `update`, `delete`.

## Common mistakes to avoid

- Forgetting `app.use(express.json())` → "Request body contains no writable fields."
- Mounting `errorHandler` before routers.
- Omitting `allowedFields` → every field writable.
- `?sort=name` when `name` is not in `sortableFields` → 400.
- Writing `$gte` in a QUERY filter → use `gte`.
- Expecting more than `maxLimit` (100) rows without paginating.
- Hard-coding `token.secret`; it must come from env and be ≥ 32 characters.
- Mutating `req.query` on Express 5 — use `Object.defineProperty` as shown above.
- Using `auth.requireAuth()` with parentheses — it is already a middleware: `auth.requireAuth`.
- Enabling refresh tokens without adding `refreshTokens` to the user schema (startup error).
