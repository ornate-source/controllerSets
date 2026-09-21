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

### Version 3.1.0 — HTTP QUERY, custom validation, read cost controls

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
- **New**: `countStrategy` (`exact` / `estimated` / `none`), `maxTimeMS` and `defaultPageSize`
  for controlling what a list request costs.
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

> [!IMPORTANT]
> This package generates **public** endpoints. Authentication and authorization are yours to
> supply via the `middlewares` option, and `allowedFields` is what stands between a client and
> every writable field on your schema. Neither is applied for you.

> [!TIP]
> **View the [Full Documentation & Live Demo](https://ornate-source.github.io/controllerSets/)** for a complete list of endpoints, filtering options, and S3 configuration.

---

Released under the [MIT License](LICENSE). © 2024-present Sabbir Mahmud
