# Express Controller Sets

An advanced, unified toolkit for Express.js that accelerates API development by providing automated CRUD operations, dynamic routing, body-based reads over HTTP QUERY, and robust Amazon S3 file upload handling out of the box.

[![Node Version](https://img.shields.io/badge/Node-20%2B-blue)](https://nodejs.org)
[![Mongoose Version](https://img.shields.io/badge/Mongoose-9%2B-green)](https://mongoosejs.com)
[![Express Version](https://img.shields.io/badge/Express-5%2B-black)](https://expressjs.com)
[![License](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT)

**[Full Documentation & Live Demo](https://ornate-source.github.io/controllerSets/)**

Designed to help you build APIs faster by automating repetitive controller logic and middleware configuration while maintaining type safety and flexibility.

---

## 📋 Changelog

### Version 3.1.0 — HTTP QUERY, custom validation, cursor pagination

- **New**: `QUERY /` — a safe, idempotent read whose parameters travel in a JSON body instead
  of the URL, for filters too long, too structured, or too sensitive for a query string. The
  response matches the equivalent `GET /`.
- **New**: structured `filter` conditions (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`),
  written without `$` and translated through a fixed table. Fields still have to be in
  `filterableFields`, and that allowlist holds even in `legacyMode`.
- **New**: multi-key sorting — `"sort": ["category", "-price"]` — which the query string
  cannot express.
- **New**: `enableQuery` option, `isQueryMethodSupported()` export, `ControllerSets#queryAll`.
  Requires Node 22.2+; on older runtimes the route is skipped with a single warning.
- **New**: a `validate` hook for `POST` and `PATCH` — your own rules, running after the field
  policy and before Mongoose. Throw `ValidationError` for per-field messages; error responses
  gain an optional `fields` map.
- **New**: `pagination: 'cursor'` — keyset pagination for collections too large to page by
  offset. One index seek per page at any depth, with an automatic `_id` tiebreaker so no
  record is skipped or repeated. On 200,000 documents, page 4,000 costs **47.8 ms by offset
  and 0.9 ms by cursor**.
- **New**: `countStrategy` (`exact` / `estimated` / `none`), `maxTimeMS`, `maxPage`,
  `defaultPageSize`, `maxRelationMatches`, `allowDiskUse` and `batchSize` for controlling what
  a list request costs.
- **Changed**: `getById` is now `get` and `queryAll` is now `query`; the old names remain as
  deprecated aliases.
- **Security**: `__proto__`, `constructor` and `prototype` are refused as field names
  everywhere. A JSON body could previously pollute the payload object's prototype.
- **Internal**: the controller is now composed from single-purpose modules under `src/core/`.
  No public behaviour changed.

### Version 3.0.0 — Security release

Fixes several vulnerabilities that were the default behaviour in 2.x. **All consumers on
public endpoints should upgrade.** See **[MIGRATION.md](MIGRATION.md)** for the full guide.

- **Security**: Request bodies are filtered via `allowedFields` / `blockedFields`; previously
  any schema field (`role`, `isAdmin`) was client-writable.
- **Security**: `?compareField=`, `?rangeField=` and `?sort=` are allowlisted; previously they
  accepted any field name and could be used to read values from fields the API never exposed.
- **Security**: Search terms are regex-escaped, closing a denial-of-service vector against the
  database. Opt out with `allowRawRegex`.
- **Security**: Uploads default to a **private** ACL, are validated by content sniffing rather
  than the client's `Content-Type`, and are stored with a matching extension and
  `Content-Disposition`.
- **Security**: Unpaginated reads are capped at `maxLimit` (default 100).
- **Security**: 5xx responses no longer echo internal error messages; duplicate keys return 409.
- **Fix**: Relational search resolves the full nested path (`author.profile.name`).
- **Fix**: Non-optimizable formats (GIF, SVG) are no longer transcoded into corrupt objects.
- **Fix**: No import-time `dotenv.config()` or S3 client construction; `sharp` and the AWS SDK
  load lazily.

### Version 2.3.5
- **New Feature**: Added an optional `onGet` lifecycle hook giving request-time control over `.populate()` and `.select()` on all GET operations (`getAll`, `getById`, and paginated results).
- **New Feature**: Integrated `sharp` for automatic image compression and processing before S3 uploads, optimizing file sizes and delivery.

---

## 🚀 Installation

Install the package using your favorite package manager:

```bash
npm install express-controller-sets mongoose express
```

For S3 upload routes, also install the upload peers:

```bash
npm install multer @aws-sdk/client-s3
```

## ⚡ Quick Start

Build a full-featured API for your model in just a few lines of code.

```javascript
import express from 'express';
import { createRouter, errorHandler } from 'express-controller-sets';
import Product from './models/Product.js';

const app = express();
app.use(express.json());

const productRouter = createRouter({
    model: Product,
    orderBy: '-createdAt',              // Sort by newest
    search: ['name', 'category.name'],  // ?search= / ?s=, including relational fields
    query: ['category'],                // ?category= filtering

    // Fields a client is allowed to write. Without this, every schema field
    // is writable through POST and PATCH.
    allowedFields: ['name', 'price', 'category', 'description'],

    // Fields usable with ?compareField= / ?rangeField= and ?sort=.
    filterableFields: ['price', 'category'],
    sortableFields: ['price', 'createdAt'],
});

app.use('/api/products', productRouter);
app.use(errorHandler);
```

Every router serves six endpoints — `GET /`, `QUERY /`, `POST /`, `GET /:id`, `PATCH /:id`
and `DELETE /:id`.

### Reading with HTTP QUERY

`QUERY` is GET with a body. Use it when a filter does not belong in a URL:

```http
QUERY /api/products HTTP/1.1
Content-Type: application/json

{
  "filter": {
    "category": "chairs",
    "price": { "gte": 50, "lte": 250 }
  },
  "sort": ["-price", "name"],
  "page": 1,
  "pageSize": 20
}
```

The body is not a MongoDB query: operators are spelled without `$` and resolved through a
fixed table, field names are checked against `filterableFields` and `sortableFields`, and an
unknown key is a `400` rather than something ignored. The response is byte-for-byte what
`GET /api/products?...` would have returned.

> [!NOTE]
> QUERY is [RFC 10008](https://www.rfc-editor.org/rfc/rfc10008.html) and needs Node 22.2 or
> newer — older runtimes reject the method inside the HTTP parser, before Express sees it.
> Check with `isQueryMethodSupported()`; when it is false the route is simply not mounted.

### Validating writes

The field policy decides what a client *may* set. A `validate` hook decides whether the values
make sense — it runs after the policy and before Mongoose:

```javascript
import { createRouter, ValidationError } from 'express-controller-sets';

createRouter({
    model: Product,
    allowedFields: ['name', 'price'],

    validate: {
        create: (payload, { req }) => {
            if (payload.price < 0) {
                throw new ValidationError('Check the submitted values.', {
                    price: 'must not be negative',
                });
            }
            // Return an object to replace the payload: normalise input, or set
            // server-owned fields no client is allowed to send.
            return { ...payload, name: payload.name.trim(), ownerId: req.user.id };
        },
        update: (payload) => { /* … */ },
    },
});
```

A rejected write answers `400` (or whatever status you pass) with the field map beside the
message:

```json
{ "success": false, "error": "Check the submitted values.",
  "fields": { "price": "must not be negative" } }
```

Your schema's own Mongoose validators still run afterwards, as the last line of defence. Note
that the hook runs *before* them — which is what lets it supply a `required` field like
`ownerId` — so a field the schema marks required may still be absent when your hook sees it.

### Paging a collection that keeps growing

`?page=4000` makes MongoDB walk every skipped index entry before it returns a row, and
`countDocuments` scans to produce the totals. Both costs grow with the collection. Switch to
keyset pagination when that matters:

```javascript
createRouter({ model: Product, pagination: 'cursor', sortableFields: ['price'] });
```

```jsonc
// GET /api/products?pageSize=50   — the first page takes no cursor
{
  "success": true,
  "data": [ /* … */ ],
  "pagination": { "pageSize": 50, "hasMore": true, "nextCursor": "eyJpIjoi…" }
}

// GET /api/products?pageSize=50&cursor=eyJpIjoi…   — and so on
```

Each page is one index seek whatever its depth, and no count runs. `_id` is appended to your
sort automatically, so records sharing a sort value are never skipped or repeated at a page
boundary. A cursor carries only the anchor record's id — the server re-reads it for the sort
values, so a client cannot craft one that filters on a field you never exposed.

## 📊 Measured performance

100,000 documents, indexed, median of 600 sequential requests over loopback. Run it yourself
with `npm run bench`.

**Listing page 1 — 50 records, filtered and sorted**

| | median | throughput |
|---|---|---|
| Hand-written Express + Mongoose *(with totals)* | 5.52 ms | 179/s |
| **controller-sets** *(with totals)* | **5.45 ms** | 179/s |
| express-restify-mongoose + `/count` *(with totals)* | 5.72 ms | 173/s |
| express-restify-mongoose *(no totals)* | 0.64 ms | 1,488/s |
| **controller-sets**, `countStrategy: 'none'` | 0.55 ms | 1,702/s |
| **controller-sets**, `pagination: 'cursor'` | **0.55 ms** | 1,712/s |

Two groups, and the line between them is the count, not the library — `countDocuments` over
100,000 documents is 5 ms of that 5.5 ms. `express-restify-mongoose` returns a bare array and
keeps its count on a second endpoint, so its fast row and its slow row are the same feature
measured with and without the part that costs.

**Page 1,000 of the same collection**

| | median | throughput |
|---|---|---|
| Hand-written Express + Mongoose | 12.61 ms | 78/s |
| express-restify-mongoose | 12.07 ms | 82/s |
| **controller-sets** *(offset)* | 12.73 ms | 78/s |
| **controller-sets** *(cursor)* | **0.86 ms** | 1,096/s |

Every offset implementation lands in the same place: they all ask MongoDB to walk 49,950 index
entries and discard them. Keyset pagination is **15× faster here**, and the gap widens with the
collection. `GET /:id` and `POST /` are within noise across all three (0.27–0.30 ms and
0.39–0.42 ms).

The library is not faster than the code you would write by hand — it runs the same queries.
What it gives you is the faster strategy already built.

> [!NOTE]
> One machine, loopback, in-memory MongoDB, no concurrency. Real deployments add network and
> disk that dwarf sub-millisecond framework differences, and `express-restify-mongoose` runs
> on its own Mongoose 8. Treat the two-group split and the depth curve as the findings, not
> the third decimal.

> [!IMPORTANT]
> This package generates **public** endpoints. Authentication and authorization are yours to
> supply via the `middlewares` option, and `allowedFields` is what stands between a client and
> every writable field on your schema. Neither is applied for you.

> [!TIP]
> **View the [Full Documentation & Live Demo](https://ornate-source.github.io/controllerSets/)** for a complete list of endpoints, filtering options, and S3 configuration.

---

Released under the [MIT License](LICENSE). © 2024-present Sabbir Mahmud
