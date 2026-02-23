# Express Controller Sets

A unified toolkit for Express.js that provides pre-built CRUD logic, robust S3 file upload handling, and dynamic routing helpers.

## Installation

```bash
npm install express-controller-sets mongoose express
```

*Compatible with Node.js 18+, Mongoose 7.x/8.x, and Express 4.x/5.x.*

## 1. ControllerSets

The `ControllerSets` class provides the core logic for handling Mongoose operations. It standardizes common patterns like pagination, filtering, and searching.

### Constructor Options

When instantiating `ControllerSets`, you can pass the following arguments:

| Option | Type | Description |
| :--- | :--- | :--- |
| `model` | Mongoose Model | The Mongoose model to perform operations on. |
| `orderBy` | String | Default sorting order (e.g., `'-createdAt'` or `'name'`). Use `'-'` prefix for descending. |
| `query` | Array | List of field names from `req.query` that should be used as automatic filters. |
| `search` | String | The field name to enable regex-based searching on (e.g., `'title'`). |
| `runAfterCreate` | Function | Optional callback that executes after a successful creation. Receives the created document. |

### Demo: Controller with Router File

**controllers/productController.js**
```javascript
import { ControllerSets } from 'express-controller-sets';
import Product from '../models/Product.js';

const productController = new ControllerSets(
    Product,
    '-createdAt',        // Order by newest
    ['category', 'brand'], // Enable filtering by ?category=...&brand=...
    'name',              // Enable search by ?name=...
    (doc) => console.log('Product created:', doc._id)
);

export default productController;
```

**routes/productRoutes.js**
```javascript
import express from 'express';
import productController from '../controllers/productController.js';

const router = express.Router();

router.get('/', productController.getAll);
router.get('/:id', productController.getById);
router.post('/', productController.create);
router.patch('/:id', productController.update);
router.delete('/:id', productController.delete);

export default router;
```

## 2. S3 Upload Middleware

The `fileUploadMiddleware` handles the complexity of uploading files to S3-compatible storage and returns the file locations in `req.body`.

### Configuration Requirements

The middleware requires the following environment variables:
- `S3_ENDPOINT`
- `S3_SPACES_KEY`
- `S3_SPACES_SECRET`
- `S3_BUCKET_NAME`
- `S3_REGION` (Default: us-east-1)

### Demo: Middleware with Router File

**routes/uploadRoutes.js**
```javascript
import express from 'express';
import { fileUploadMiddleware } from 'express-controller-sets';

const router = express.Router();

router.post('/profile-picture', 
    (req, res, next) => {
        const uploadPath = 'users/avatars/';
        const fields = [{ name: 'avatar', maxCount: 1 }];
        fileUploadMiddleware(req, res, next, uploadPath, fields);
    },
    (req, res) => {
        // req.body.avatar now contains the S3 URL
        res.status(200).json({ 
            success: true, 
            url: req.body.avatar 
        });
    }
);

export default router;
```

## 3. Dynamic Router Helpers

For maximum speed, use the dynamic router helpers to generate a full set of routes in a single call.

### createRouter

Generates standard CRUD routes without file uploads.

```javascript
import { createRouter } from 'express-controller-sets';
import Category from '../models/Category.js';

const router = createRouter({
    model: Category,
    orderBy: 'name',
    middlewares: [authenticate] // Applied to all routes in this router
});

app.use('/api/categories', router);
```

### createRouterS3upload

Generates CRUD routes and automatically attaches S3 upload middleware to the `POST` and `PATCH` endpoints.

```javascript
import { createRouterS3upload } from 'express-controller-sets';
import Post from '../models/Post.js';

const router = createRouterS3upload({
    model: Post,
    path: 'blog/posts/',
    fields: [
        { name: 'thumbnail', maxCount: 1 },
        { name: 'attachments', maxCount: 5 }
    ],
    orderBy: '-createdAt',
    search: 'title'
});

app.use('/api/posts', router);
```

## API Reference

### createRouter(options)
- `model`: (Mongoose Model) Required.
- `orderBy`: (String) Default sorting.
- `query`: (Array) Allowed filter fields.
- `search`: (String) Searchable field.
- `middlewares`: (Array) List of middlewares to use.
- `runAfterCreate`: (Function) Post-creation callback.

### createRouterS3upload(options)
Includes all options from `createRouter` plus:
- `path`: (String) S3 folder path.
- `fields`: (Array) Array of field objects `{ name, maxCount }`.

## License

MIT
