# Express Controller Sets

A unified toolkit for Express.js that provides pre-built CRUD logic, robust S3 file upload handling, and dynamic routing helpers.

[![Node Version](https://img.shields.io/badge/Node-20%2B-blue)](https://nodejs.org)
[![Mongoose Version](https://img.shields.io/badge/Mongoose-9%2B-green)](https://mongoosejs.com)
[![Express Version](https://img.shields.io/badge/Express-5%2B-black)](https://expressjs.com)
[![License](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT)

**[Full Documentation & Live Demo](https://ornate-source.github.io/controllerSets/)**

Designed to help you build APIs faster by automating repetitive controller logic and middleware configuration while maintaining type safety and flexibility.

---

## 🚀 Installation

Install the package using your favorite package manager:

```bash
npm install express-controller-sets mongoose express multer multer-s3 dotenv @aws-sdk/client-s3
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
    search: ['name', 'category.name'], // Enable ?search= or ?s= for multi-field search, including relational fields
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
    ['name', 'tags'],    // Searchable fields array
    async (doc) => {}    // Optional runAfterCreate callback
);

// Pagination is built-in. Use ?page=1&pageSize=50 when fetching lists.

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
    search: ['name', 'description']
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

## 📘 TypeScript Support

The package comes with built-in TypeScript definitions. You can pass your Mongoose document interfaces to strongly type the controllers and routers.

```typescript
import express from 'express';
import { createRouter } from 'express-controller-sets';
import mongoose, { Document } from 'mongoose';

// 1. Define your interface
interface IUser extends Document {
    name: string;
    email: string;
    age: number;
}

// 2. Define or import your model
const UserModel = mongoose.model<IUser>('User', new mongoose.Schema({
    name: String,
    email: String,
    age: Number
}));

// 3. Create a strongly-typed router
const userRouter = createRouter<IUser>({
    model: UserModel,
    orderBy: 'name',
    search: ['name', 'email']
});

const app = express();
app.use('/api/users', userRouter);
```

## 📖 API Reference

| Option | Type | Description |
| :--- | :--- | :--- |
| `model` | Mongoose Model | **Required.** Model for database operations. |
| `orderBy` | String | Default sorting field (e.g. `'-createdAt'`). |
| `query` | Array<String> | Fields allowed for automatic query filtering. |
| `search` | Array<String>\|String | Array of field names (or a single string) for regex-based searching via `?s=` or `?search=`. |
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
