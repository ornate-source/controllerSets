import express from "express";
import mongoose from "mongoose";
import { ControllerSets, createRouter, createRouterS3upload } from "./src/index.js";

const app = express();
app.use(express.json());

// 1. Define a Mongoose Model
const ProductSchema = new mongoose.Schema({
    name: String,
    price: Number,
    category: String,
    image: String, // For file upload example
    createdAt: { type: Date, default: Date.now }
});
const Product = mongoose.model("Product", ProductSchema);

// 2. Use Dynamic Router (Standard CRUD)
// This automatically creates GET /, POST /, GET /:id, PATCH /:id, DELETE /:id
const productRouter = createRouter({
    model: Product,
    orderBy: "-createdAt", // Sort by newest first
    search: "name",        // Enable search on 'name' field (?name=xyz)
    query: ["category"],   // Enable filtering on 'category' field (?category=electronics)
});

app.use("/api/products", productRouter);

// 3. Use Dynamic Router with S3 File Upload
// This handles the file upload to S3 and then saves the link to the DB automatically
const productWithImageRouter = createRouterS3upload({
    model: Product,
    path: "products/images/", // S3 folder path
    fields: [{ name: "image", maxCount: 1 }], // Field name in the form-data
    orderBy: "-createdAt",
});

app.use("/api/products-upload", productWithImageRouter);

// 4. Using the Controller Class directly (For custom logic)
const productController = new ControllerSets(Product);

app.get("/api/custom-products", productController.getAll.bind(productController));

console.log("Example routers configured!");
