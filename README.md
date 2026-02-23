# 🚀 Express Controller Sets

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![NPM Version](https://img.shields.io/npm/v/express-controller-sets.svg)](https://www.npmjs.com/package/express-controller-sets)

**Express Controller Sets** is a premium backend toolkit designed to eliminate boilerplate in Node.js/Express.js applications. It provides a unified, robust, and OS-agnostic solution for CRUD operations, dynamic routing, and AWS S3/Spaces file uploads.

---

## 📑 Table of Contents
1. [Installation](#-installation)
2. [Core Features](#-core-features)
3. [Quick Start](#-quick-start)
4. [Advanced Usage](#-advanced-usage)
    - [Dynamic Routing](#dynamic-routing)
    - [S3 File Uploads](#s3-file-uploads)
    - [Class-Based Controllers](#class-based-controllers)
5. [Configuration](#-configuration)
6. [API Reference](#-api-reference)
7. [License](#-license)

---

## 📦 Installation

```bash
npm install express-controller-sets mongoose express
```
*Requires Node.js 16+ and Mongoose 7+.*

---

## ✨ Core Features
- **Zero-Boilerplate CRUD**: Instantly generate all 5 standard API routes.
- **Dynamic Filtering**: Auto-detect query params for filtering, sorting, and regex searching.
- **S3 Uploads**: Integrated Multer-S3 middleware with cross-platform (Mac/Linux/Windows) support.
- **Senior-Level Robustness**: Global async error handling and standardized JSON responses.
- **Pagination**: Built-in, high-performance paginated results with metadata.

---

## ⚡ Quick Start

Setting up a complete REST API for your Mongoose model in under 10 seconds:

```javascript
import express from "express";
import { createRouter } from "express-controller-sets";
import Product from "./models/Product.js";

const app = express();

// Set up all 5 CRUD routes with one command
app.use("/api/products", createRouter({
    model: Product,
    orderBy: "-createdAt", // Sort newest first
    search: "name",        // Enable searching by name
    query: ["category"]    // Enable filtering by category
}));
```

---

## 🛠 Advanced Usage

### Dynamic Routing
The `createRouter` function generates:
- `GET /` - List all (supports pagination/filtering)
- `GET /:id` - Get details
- `POST /` - Create new
- `PATCH /:id` - Update existing
- `DELETE /:id` - Remove record

### S3 File Uploads
Use `createRouterS3upload` for models that require image or file attachments.

```javascript
import { createRouterS3upload } from "express-controller-sets";
import User from "./models/User.js";

app.use("/api/users", createRouterS3upload({
    model: User,
    path: "avatars/", // S3 folder
    fields: [{ name: "photo", maxCount: 1 }],
    middlewares: [myAuthMiddleware] // Secure your routes easily
}));
```

### Class-Based Controllers
For custom route logic, instantiate the class directly:

```javascript
import { ControllerSets } from "express-controller-sets";
const productController = new ControllerSets(ProductModel);

router.get("/special-list", productController.getAll);
```

---

## ⚙️ Configuration

For S3/DigitalOcean Spaces functionality, define these in your `.env`:

```env
S3_ENDPOINT=sfo3.digitaloceanspaces.com
S3_SPACES_KEY=YOUR_KEY
S3_SPACES_SECRET=YOUR_SECRET
S3_BUCKET_NAME=YOUR_BUCKET
S3_REGION=us-east-1
```

---

## 📖 API Reference

### `createRouter(options)`
| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `model` | Mongoose Model | **Required** | The model for CRUD operations. |
| `orderBy` | String | `"none"` | Default sort (e.g., `"-createdAt"`). |
| `query` | Array | `[]` | Allowed query params for filtering. |
| `search` | String | `"none"` | Field name to enable regex search. |
| `middlewares` | Array | `[]` | List of Express middlewares. |

### `createRouterS3upload(options)`
Includes all `createRouter` options plus:
| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `path` | String | `"files/"` | Destination folder on S3. |
| `fields` | Array | `[...]` | Multer fields array. |

---

## 🤝 Contributing
Built with ❤️ by **Sabbir Mahmud** at **One Islam**.

## 📄 License
This project is licensed under the [MIT License](LICENSE).
