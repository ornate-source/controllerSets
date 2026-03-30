import test from "node:test";
import assert from "node:assert";
import express from "express";
import mongoose from "mongoose";
import { createRouter } from "../src/router.js";

// --- Mock Mongoose Model ---
const mockData = new Map();
let idCounter = 1;

const createMockModel = () => {
    const model = {
        schema: {
            path: (fieldName) => {
                // Return a ref for nested search testing if field is 'category'
                if (fieldName === "category") {
                    return { options: { ref: "Category" } };
                }
                return null;
            }
        },
        find: (filters) => {
            let data = Array.from(mockData.values());
            
            // Simple filter implementation
            if (filters && Object.keys(filters).length > 0) {
                data = data.filter(item => {
                    for (let key in filters) {
                        if (key === "$or") {
                            return filters.$or.some(clause => {
                                const field = Object.keys(clause)[0];
                                const regex = clause[field].$regex;
                                return new RegExp(regex, "i").test(item[field]);
                            });
                        }
                        if (item[key] !== filters[key]) return false;
                    }
                    return true;
                });
            }

            const query = {
                sort: () => query,
                skip: () => query,
                limit: () => query,
                lean: () => Promise.resolve(data)
            };
            return query;
        },
        findById: (id) => {
            const item = mockData.get(id.toString());
            return Promise.resolve(item || null);
        },
        create: (body) => {
            const id = (idCounter++).toString().padStart(24, '0');
            const newItem = { _id: id, ...body };
            mockData.set(id, newItem);
            return Promise.resolve(newItem);
        },
        findByIdAndUpdate: (id, update, options) => {
            const existing = mockData.get(id.toString());
            if (!existing) return { lean: () => Promise.resolve(null) };
            const updated = { ...existing, ...update.$set };
            mockData.set(id.toString(), updated);
            return { lean: () => Promise.resolve(updated) };
        },
        findByIdAndDelete: (id) => {
            mockData.delete(id.toString());
            return Promise.resolve(true);
        },
        countDocuments: (filters) => {
            return Promise.resolve(mockData.size);
        }
    };
    return model;
};

// --- Test Suite ---

test("Express Controller Sets - Smoke Test", async (t) => {
    const app = express();
    app.use(express.json());

    const mockModel = createMockModel();
    const router = createRouter({
        model: mockModel,
        search: ["name", "description"]
    });

    app.use("/items", router);

    let createdId = "";

    await t.test("POST /items - should create a new record", async () => {
        const payload = { name: "Test Item", description: "Hello World" };
        
        // Manual simulation of request since we don't have supertest
        const req = { method: 'POST', url: '/items', headers: { 'content-type': 'application/json' }, body: payload };
        
        // We'll use a real express instance but trigger it manually or use a simple fetch if we start the server
        // For absolute zero-dependency we can just call the controller methods, but createRouter tests the wiring.
        // Let's start a small server on a random port.
        const server = app.listen(0);
        const port = server.address().port;
        
        try {
            const res = await fetch(`http://localhost:${port}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const body = await res.json();

            assert.strictEqual(res.status, 201);
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.data.name, payload.name);
            createdId = body.data._id;
        } finally {
            server.close();
        }
    });

    await t.test("GET /items - should list records", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/items`);
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.success, true);
            assert.ok(Array.isArray(body.data));
            assert.strictEqual(body.data.length, 1);
            assert.strictEqual(body.data[0].name, "Test Item");
        } finally {
            server.close();
        }
    });

    await t.test("GET /items/:id - should get single record", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/items/${createdId}`);
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.data.name, "Test Item");
        } finally {
            server.close();
        }
    });

    await t.test("PATCH /items/:id - should update record", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/items/${createdId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "Updated Name" })
            });
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.data.name, "Updated Name");
        } finally {
            server.close();
        }
    });

    await t.test("GET /items?search=... - should search records", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/items?search=Updated`);
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.data.length, 1);
            assert.strictEqual(body.data[0].name, "Updated Name");
        } finally {
            server.close();
        }
    });

    await t.test("DELETE /items/:id - should delete record", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/items/${createdId}`, {
                method: "DELETE"
            });
            const body = await res.json();

            assert.strictEqual(res.status, 200);
            assert.strictEqual(body.success, true);

            // Verify deletion
            const getRes = await fetch(`http://localhost:${port}/items/${createdId}`);
            assert.strictEqual(getRes.status, 404);
        } finally {
            server.close();
        }
    });
});
