# Express Controller Sets

A unified toolkit for Express.js that provides pre-built CRUD logic, robust S3 file upload handling, and dynamic routing. designed for developers who want to eliminate repetitive boilerplate without sacrificing control.

## Installation

This is a Node.js module available through the npm registry. Installation is done using the npm install command:

```bash
npm install express-controller-sets mongoose express
```

## 1. ControllerSet

The `ControllerSets` class is the core of this package. It provides standardized methods for handling Mongoose CRUD operations.

### Usage

```javascript
import { ControllerSets } from 'express-controller-sets';
import Product from './models/Product.js';

const productController = new ControllerSets(Product);

// Example: Get all products
// router.get('/products', productController.getAll);
```

### Methods

- `getAll(req, res)`: Retrieves a list of records with support for filtering, sorting, searching, and pagination.
- `getById(req, res)`: Retrieves a single record by ID.
- `create(req, res)`: Creates a new record using the request body.
- `update(req, res)`: Updates an existing record.
- `delete(req, res)`: Deletes a record.

## 2. S3 File Upload

The package includes a built-in middleware for handling file uploads to AWS S3 or compatible services (like DigitalOcean Spaces).

### Usage

```javascript
import { fileUploadMiddleware } from 'express-controller-sets';

// Single file upload
app.post('/upload', 
    (req, res, next) => fileUploadMiddleware(req, res, next, 'folder/path/', [{ name: 'image', maxCount: 1 }]),
    (req, res) => {
        res.json({ url: req.body.image });
    }
);
```

The middleware automatically process files, uploads them to S3, and populates the `req.body` with the resulting S3 URLs.

## 3. Dynamic Router

The dynamic router automates the creation of standard RESTful routes by combining the `ControllerSets` logic with optional S3 integration.

### Standard Router

Creates GET (list), POST, GET (by id), PATCH, and DELETE routes automatically.

```javascript
import { createRouter } from 'express-controller-sets';
import Product from './models/Product.js';

const router = createRouter({
    model: Product,
    orderBy: '-createdAt',
    search: 'name',
    query: ['category'],
    middlewares: [authMiddleware]
});

app.use('/api/products', router);
```

### S3 Integrated Router

Combines CRUD operations with automatic S3 file upload handling for POST and PATCH requests.

```javascript
import { createRouterS3upload } from 'express-controller-sets';
import Product from './models/Product.js';

const router = createRouterS3upload({
    model: Product,
    path: 'products/images/',
    fields: [{ name: 'image', maxCount: 1 }],
    orderBy: '-createdAt'
});

app.use('/api/products', router);
```

## Configuration

The S3 functionality requires the following environment variables to be defined:

- `S3_ENDPOINT`: Your S3 endpoint (e.g., sfo3.digitaloceanspaces.com)
- `S3_SPACES_KEY`: Your access key
- `S3_SPACES_SECRET`: Your secret key
- `S3_BUCKET_NAME`: Your bucket name
- `S3_REGION`: The region (defaults to us-east-1)

## API Reference

### createRouter(options)

- `model`: (Required) The Mongoose model to use.
- `orderBy`: (Optional) Default sorting string (e.g., '-id').
- `query`: (Optional) Array of field names allowed for query filtering.
- `search`: (Optional) Field name used for regex search.
- `middlewares`: (Optional) Array of Express middlewares to apply to the router.
- `runAfterCreate`: (Optional) A callback function executed after a record is successfully created.

### createRouterS3upload(options)

Includes all options from `createRouter` plus:

- `path`: (Optional) The folder path in S3.
- `fields`: (Optional) Array of Multer field objects (e.g., `{ name: 'file', maxCount: 1 }`).

## License

MIT
