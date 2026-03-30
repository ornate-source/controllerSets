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

> [!TIP]
> **View the [Full Documentation & Live Demo](https://ornate-source.github.io/controllerSets/)** for a complete list of endpoints, filtering options, and S3 configuration.

Released under the [MIT License](LICENSE). © 2024 Sabbir Mahmud
