import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";
import sharp from "sharp";
import { createRouter, createRouterS3upload, errorHandler } from "../src/index.js";
import { createMockModel, withServer } from "./helpers/mockModel.js";

// One router for CRUD with or without files: `upload` switches multipart on for
// the write routes. `createRouterS3upload` is the deprecated 3.x spelling of it.

const silentLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const startFakeS3 = async () => {
    const received = [];
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            received.push({ method: req.method, url: req.url });
            res.writeHead(200, { ETag: '"fake-etag"' });
            res.end();
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { received, port: server.address().port, close: () => server.close() };
};

const buildApp = (router) => {
    const app = express();
    app.use(express.json());
    app.use("/products", router);
    app.use(errorHandler);
    return app;
};

const postCover = async (base, fields = {}) => {
    const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "red" },
    }).png().toBuffer();
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append("cover", new Blob([png], { type: "image/png" }), "cover.png");
    const res = await fetch(`${base}/products`, { method: "POST", body: form });
    return { status: res.status, body: await res.json() };
};

test("createRouter with upload", async (t) => {
    const s3 = await startFakeS3();
    const originalEnv = { ...process.env };
    Object.assign(process.env, {
        S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
        S3_SPACES_KEY: "k",
        S3_SPACES_SECRET: "s",
        S3_BUCKET_NAME: "bucket",
        S3_REGION: "us-east-1",
    });
    t.after(() => {
        s3.close();
        process.env = originalEnv;
    });

    await t.test("stores the file and saves its URL on the record", async () => {
        const router = createRouter({
            model: createMockModel(),
            logger: silentLogger,
            allowedFields: ["name", "cover"],
            upload: { path: "products/", fields: [{ name: "cover", maxCount: 1 }] },
        });

        await withServer(buildApp(router), async (base) => {
            const { status, body } = await postCover(base, { name: "Chair" });
            assert.strictEqual(status, 201);
            assert.strictEqual(body.data.name, "Chair");
            assert.match(body.data.cover, /\/bucket\/products\/.+\.png$/);
        });
        assert.ok(s3.received.some((r) => r.method === "PUT" && r.url.includes("/products/")));
    });

    await t.test("upload: true uses the defaults", async () => {
        const router = createRouter({
            model: createMockModel(),
            logger: silentLogger,
            allowedFields: ["file"],
            upload: true,
        });
        const png = await sharp({
            create: { width: 8, height: 8, channels: 3, background: "red" },
        }).png().toBuffer();

        await withServer(buildApp(router), async (base) => {
            const form = new FormData();
            form.append("file", new Blob([png], { type: "image/png" }), "a.png");
            const res = await fetch(`${base}/products`, { method: "POST", body: form });
            const body = await res.json();
            assert.strictEqual(res.status, 201);
            assert.match(body.data.file, /\/bucket\/files\/.+\.png$/);
        });
    });

    await t.test("without upload, multipart files are not stored", async () => {
        const before = s3.received.length;
        const router = createRouter({
            model: createMockModel(),
            logger: silentLogger,
            allowedFields: ["name", "cover"],
        });

        await withServer(buildApp(router), async (base) => {
            await postCover(base, { name: "Chair" });
        });
        assert.strictEqual(s3.received.length, before);
    });

    await t.test("createRouterS3upload still works and warns once", async () => {
        const warnings = [];
        const onWarning = (w) => w.code === "ECS_DEP001" && warnings.push(w);
        process.on("warning", onWarning);
        t.after(() => process.off("warning", onWarning));

        const build = () =>
            createRouterS3upload({
                model: createMockModel(),
                logger: silentLogger,
                allowedFields: ["name", "cover"],
                path: "legacy/",
                fields: [{ name: "cover", maxCount: 1 }],
                upload: { acl: "private" },
            });
        const router = build();
        build();

        await withServer(buildApp(router), async (base) => {
            const { status, body } = await postCover(base, { name: "Chair" });
            assert.strictEqual(status, 201);
            assert.match(body.data.cover, /\/bucket\/legacy\/.+\.png$/);
        });

        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(warnings[0].name, "DeprecationWarning");
    });
});

test("createRouter rejects an upload option it cannot read", () => {
    assert.throws(
        () => createRouter({ model: createMockModel(), logger: silentLogger, upload: "yes" }),
        TypeError,
    );
});

test("createRouter warns about top-level upload options", () => {
    const warned = [];
    createRouter({
        model: createMockModel(),
        logger: { ...silentLogger, warn: (msg) => warned.push(msg) },
        fields: [{ name: "cover", maxCount: 1 }],
    });
    assert.strictEqual(warned.length, 1);
    assert.match(warned[0], /'fields'.*upload/);
});
