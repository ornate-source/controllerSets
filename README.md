# Express Controller Sets

An advanced, unified toolkit for Express.js that accelerates API development by providing automated CRUD operations, dynamic routing capabilities, and robust Amazon S3 file upload handling out of the box.

[![Node Version](https://img.shields.io/badge/Node-20%2B-blue)](https://nodejs.org)
[![Mongoose Version](https://img.shields.io/badge/Mongoose-9%2B-green)](https://mongoosejs.com)
[![Express Version](https://img.shields.io/badge/Express-5%2B-black)](https://expressjs.com)
[![License](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT)

**[Full Documentation & Live Demo](https://ornate-source.github.io/controllerSets/)**

Designed to help you build APIs faster by automating repetitive controller logic and middleware configuration while maintaining type safety and flexibility.

---

## 📋 Changelog

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

> [!IMPORTANT]
> This package generates **public** endpoints. Authentication and authorization are yours to
> supply via the `middlewares` option, and `allowedFields` is what stands between a client and
> every writable field on your schema. Neither is applied for you.

> [!TIP]
> **View the [Full Documentation & Live Demo](https://ornate-source.github.io/controllerSets/)** for a complete list of endpoints, filtering options, and S3 configuration.

---

Released under the [MIT License](LICENSE). © 2024-present Sabbir Mahmud
