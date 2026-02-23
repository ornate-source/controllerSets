# Express Controller Sets

A unified toolkit for Express.js that provides pre-built CRUD logic, robust S3 file upload handling, and dynamic routing helpers.

[![Node Version](https://img.shields.io/badge/Node-18%2B-blue)](https://nodejs.org)
[![Mongoose Version](https://img.shields.io/badge/Mongoose-8%2B-green)](https://mongoosejs.com)
[![Express Version](https://img.shields.io/badge/Express-5%2B-black)](https://expressjs.com)
[![License](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT)

Designed to help you build APIs faster by automating repetitive controller logic and middleware configuration while maintaining type safety and flexibility.

---

## 🚀 Installation

Install the package and its peer dependencies using your favorite package manager:

```bash
npm install express-controller-sets mongoose express
```

## ⚡ Quick Start

Build a full-featured API for your model in just a few lines of code.

```javascript
import express from 'express';
import { createRouter } from 'express-controller-sets';
import Product from './models/Product.js';

const app = express();
app.use(express.json());

// Create all CRUD routes automatically
const productRouter = createRouter({
    model: Product,
    orderBy: '-createdAt', // Sort by newest
    search: 'name',        // Enable ?name= searching
    query: ['category']    // Enable ?category= filtering
});

app.use('/api/products', productRouter);
```

## 📦 Controller Sets

The `ControllerSets` class provides the core logic for handling Mongoose operations. You can use it directly for custom route handling.

```javascript
import { ControllerSets } from 'express-controller-sets';
import Product from '../models/Product.js';

const productController = new ControllerSets(
    Product,
    '-createdAt',        // Default sort
    ['category'],        // Filterable fields
    'name'               // Searchable field
);

// Use in manual routes
router.get('/', productController.getAll);
router.post('/', productController.create);
```

## ☁️ S3 Upload Middleware

Handle file uploads to S3-compatible storage with ease. The middleware automatically updates `req.body` with S3 locations.

```javascript
import { fileUploadMiddleware } from 'express-controller-sets';

router.post('/upload', (req, res, next) => {
    fileUploadMiddleware(req, res, next, 'uploads/', [
        { name: 'avatar', maxCount: 1 }
    ]);
}, (req, res) => {
    res.json({ url: req.body.avatar });
});
```

## 🛣️ Dynamic Routers

Use the helper functions to quickly scaffold entire resource routers with pre-configured CRUD and upload logic.

### Basic Router
```javascript
import { createRouter } from 'express-controller-sets';
import Product from './models/Product.js';

const router = createRouter({
    model: Product,
    orderBy: '-createdAt',
    search: 'name'
});
```

### Router with S3 Upload
Automatically combines CRUD logic with S3 file upload middleware.
```javascript
import { createRouterS3upload } from 'express-controller-sets';
import User from './models/User.js';

const router = createRouterS3upload({
    model: User,
    folder: 'avatars/',
    filesState: [{ name: 'avatar', maxCount: 1 }]
});
```

## 📖 API Reference

| Option | Type | Description |
| :--- | :--- | :--- |
| `model` | Mongoose Model | **Required.** Model for database operations. |
| `orderBy` | String | Default sorting field (e.g. `'-createdAt'`). |
| `query` | Array<String> | Fields allowed for automatic query filtering. |
| `search` | String | Field name for regex-based searching. |
| `middlewares` | Array<Function> | Array of middlewares applied to all routes. |

## ⚙️ Environment Variables

Configure your S3 credentials via environment variables:

```text
S3_ENDPOINT=your-endpoint.com
S3_SPACES_KEY=your-key
S3_SPACES_SECRET=your-secret
S3_BUCKET_NAME=your-bucket
S3_REGION=us-east-1
```

---

Released under the [MIT License](LICENSE). © 2024 Sabbir Mahmud
