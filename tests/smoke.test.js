import test from "node:test";
import assert from "node:assert";
import express from "express";
import mongoose from "mongoose";
import { createRouter, errorHandler } from "../src/index.js";

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
        lastSort: null,
        find: function(filters) {
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
                        if (typeof filters[key] === 'object' && filters[key] !== null) {
                            const val = item[key];
                            if (val === undefined) return false;
                            if (filters[key].$gte !== undefined && val < filters[key].$gte) return false;
                            if (filters[key].$lte !== undefined && val > filters[key].$lte) return false;
                        } else if (item[key] !== filters[key]) {
                            return false;
                        }
                    }
                    return true;
                });
            }

            const query = {
                sort: (s) => {
                    this.lastSort = s;
                    return query;
                },
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
            if (body.name === "TRIGGER_ERROR") {
                const err = new Error("Validation failed");
                err.name = "ValidationError";
                err.errors = { name: { message: "Name is required" } };
                return Promise.reject(err);
            }
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

    // Global Error Handler Test
    app.use(errorHandler);

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

    await t.test("GET /items with range query - should filter records by numeric range", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            mockData.set("item_low", { _id: "item_low", name: "Low price item", price: 15 });
            mockData.set("item_mid", { _id: "item_mid", name: "Mid price item", price: 50 });
            mockData.set("item_high", { _id: "item_high", name: "High price item", price: 120 });

            // Query range 20-100
            const res1 = await fetch(`http://localhost:${port}/items?rangeField=price&range=20-100`);
            const body1 = await res1.json();
            assert.strictEqual(res1.status, 200);
            assert.strictEqual(body1.data.length, 1);
            assert.strictEqual(body1.data[0].price, 50);

            // Query range 20- (min only)
            const res2 = await fetch(`http://localhost:${port}/items?rangeField=price&range=20-`);
            const body2 = await res2.json();
            assert.strictEqual(res2.status, 200);
            const prices2 = body2.data.map(item => item.price);
            assert.ok(prices2.includes(50));
            assert.ok(prices2.includes(120));
            assert.ok(!prices2.includes(15));

            // Query range -80 (max only)
            const res3 = await fetch(`http://localhost:${port}/items?rangeField=price&range=-80`);
            const body3 = await res3.json();
            assert.strictEqual(res3.status, 200);
            const prices3 = body3.data.map(item => item.price);
            assert.ok(prices3.includes(15));
            assert.ok(prices3.includes(50));
            assert.ok(!prices3.includes(120));

        } finally {
            mockData.delete("item_low");
            mockData.delete("item_mid");
            mockData.delete("item_high");
            server.close();
        }
    });

    await t.test("GET /items?sort=-name - should sort records dynamically", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            await fetch(`http://localhost:${port}/items?sort=-name`);
            assert.deepStrictEqual(mockModel.lastSort, { name: -1 });
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

    await t.test("POST /items (Error) - should return JSON error on validation failure", async () => {
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://localhost:${port}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: "TRIGGER_ERROR" })
            });
            const body = await res.json();

            assert.strictEqual(res.status, 400);
            assert.strictEqual(body.success, false);
            assert.ok(body.error.includes("Validation Error"));
        } finally {
            server.close();
        }
    });
});
