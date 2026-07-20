import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";
import sharp from "sharp";
import { fileUploadMiddleware } from "../src/index.js";
import { withServer } from "./helpers/mockModel.js";

/**
 * Stands in for S3. The AWS SDK talks to it over real HTTP, so the assertions
 * below cover what would actually be written to the bucket — ACL, Content-Type
 * and Content-Disposition included.
 */
const startFakeS3 = async () => {
    const received = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            received.push({
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: Buffer.concat(chunks),
            });
            res.writeHead(200, { ETag: '"fake-etag"' });
            res.end();
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { received, port: server.address().port, close: () => server.close() };
};

const buildUploadApp = (options) => {
    const app = express();
    app.post(
        "/upload",
        (req, res, next) => fileUploadMiddleware(req, res, next, options),
        (req, res) => res.status(201).json({ success: true, body: req.body }),
    );
    return app;
};

const postFile = async (base, { bytes, filename, contentType, field = "file" }) => {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type: contentType }), filename);
    const res = await fetch(`${base}/upload`, { method: "POST", body: form });
    return { status: res.status, body: await res.json() };
};

const pngBytes = () =>
    sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } })
        .png()
        .toBuffer();

test("S3 upload hardening", async (t) => {
    const s3 = await startFakeS3();
    const originalEnv = { ...process.env };

    process.env.S3_ENDPOINT = `http://127.0.0.1:${s3.port}`;
    process.env.S3_SPACES_KEY = "test-key";
    process.env.S3_SPACES_SECRET = "test-secret";
    process.env.S3_BUCKET_NAME = "test-bucket";
    process.env.S3_REGION = "us-east-1";

    t.after(() => {
        s3.close();
        process.env = originalEnv;
    });

    await t.test("C3: HTML disguised as an image is rejected", async () => {
        const app = buildUploadApp({});
        await withServer(app, async (base) => {
            const before = s3.received.length;
            const { status, body } = await postFile(base, {
                bytes: Buffer.from("<!DOCTYPE html><script>alert(document.cookie)</script>"),
                filename: "avatar.png",
                contentType: "image/png",
            });

            assert.strictEqual(status, 400);
            assert.match(body.error, /text\/html' is not allowed/);
            // Nothing reached the bucket.
            assert.strictEqual(s3.received.length, before);
        });
    });

    await t.test("C3: SVG is rejected by default", async () => {
        const app = buildUploadApp({});
        await withServer(app, async (base) => {
            const { status, body } = await postFile(base, {
                bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
                filename: "logo.svg",
                contentType: "image/svg+xml",
            });
            assert.strictEqual(status, 400);
            assert.match(body.error, /image\/svg\+xml' is not allowed/);
        });
    });

    await t.test("C3: unrecognised binary content is rejected", async () => {
        const app = buildUploadApp({});
        await withServer(app, async (base) => {
            const { status } = await postFile(base, {
                bytes: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]),
                filename: "payload.png",
                contentType: "image/png",
            });
            assert.strictEqual(status, 400);
        });
    });

    await t.test("C3: a genuine image uploads privately with a sniffed content type", async () => {
        const app = buildUploadApp({});
        await withServer(app, async (base) => {
            const { status, body } = await postFile(base, {
                bytes: await pngBytes(),
                // Client lies about both the extension and the type.
                filename: "not-really.txt",
                contentType: "application/x-lying",
            });

            assert.strictEqual(status, 201);

            const put = s3.received.at(-1);
            assert.strictEqual(put.method, "PUT");
            assert.match(put.url, /^\/test-bucket\/files\/\d+-\d+\.png\b/);
            assert.strictEqual(put.headers["content-type"], "image/png");
            assert.strictEqual(put.headers["x-amz-acl"], "private");
            assert.strictEqual(put.headers["content-disposition"], "inline");
            assert.match(body.body.file, /\/test-bucket\/files\/.*\.png$/);
        });
    });

    await t.test("C3: an explicitly allowlisted SVG is still forced to attachment", async () => {
        const app = buildUploadApp({ allowedMimeTypes: ["image/svg+xml"] });
        await withServer(app, async (base) => {
            const { status } = await postFile(base, {
                bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
                filename: "logo.svg",
                contentType: "image/svg+xml",
            });

            assert.strictEqual(status, 201);
            const put = s3.received.at(-1);
            assert.strictEqual(put.headers["content-disposition"], "attachment");
            assert.strictEqual(put.headers["content-type"], "image/svg+xml");
        });
    });

    await t.test("public-read remains available as an explicit opt-in", async () => {
        const app = buildUploadApp({ acl: "public-read" });
        await withServer(app, async (base) => {
            const { status } = await postFile(base, {
                bytes: await pngBytes(),
                filename: "a.png",
                contentType: "image/png",
            });
            assert.strictEqual(status, 201);
            assert.strictEqual(s3.received.at(-1).headers["x-amz-acl"], "public-read");
        });
    });

    await t.test("M1: clients cannot choose the optimization level by default", async () => {
        const app = buildUploadApp({});
        await withServer(app, async (base) => {
            const form = new FormData();
            form.append("file", new Blob([await pngBytes()], { type: "image/png" }), "a.png");

            const res = await fetch(`${base}/upload?imgOptimizations=high`, {
                method: "POST",
                body: form,
                headers: { "x-img-optimizations": "high" },
            });
            assert.strictEqual(res.status, 201);

            // Uncompressed: the client's requested level was ignored.
            const put = s3.received.at(-1);
            const original = await pngBytes();
            assert.strictEqual(put.body.length, original.length);
        });
    });

    await t.test("M4: stored extension always matches the stored bytes", async () => {
        const app = buildUploadApp({ imgOptimizations: "high" });
        await withServer(app, async (base) => {
            const gif = await sharp({
                create: { width: 32, height: 32, channels: 3, background: "green" },
            })
                .gif()
                .toBuffer();

            const { status } = await postFile(base, {
                bytes: gif,
                filename: "anim.gif",
                contentType: "image/gif",
            });
            assert.strictEqual(status, 201);

            const put = s3.received.at(-1);
            assert.match(put.url, /\.gif\b/);
            assert.strictEqual(put.headers["content-type"], "image/gif");
            // Still a GIF, not silently transcoded to JPEG under a .gif key.
            assert.strictEqual((await sharp(put.body).metadata()).format, "gif");
        });
    });

    await t.test("oversized files are rejected with 400", async () => {
        // The sample PNG is ~102 bytes, so the cap has to sit below it.
        const app = buildUploadApp({ maxFileSize: 50 });
        await withServer(app, async (base) => {
            const { status, body } = await postFile(base, {
                bytes: await pngBytes(),
                filename: "big.png",
                contentType: "image/png",
            });
            assert.strictEqual(status, 400);
            assert.match(body.error, /File upload error/);
        });
    });
});

test("M3: missing S3 configuration yields 503 and is re-read per request", async (t) => {
    const originalEnv = { ...process.env };
    t.after(() => {
        process.env = originalEnv;
    });

    delete process.env.S3_ENDPOINT;
    delete process.env.S3_SPACES_KEY;
    delete process.env.S3_SPACES_SECRET;
    delete process.env.S3_BUCKET_NAME;

    const app = buildUploadApp({});
    await withServer(app, async (base) => {
        const { status } = await postFile(base, {
            bytes: Buffer.from("x"),
            filename: "a.png",
            contentType: "image/png",
        });
        assert.strictEqual(status, 503);
    });

    // Configuration supplied after import must take effect, rather than being
    // locked in by a snapshot taken at module load.
    const s3 = await startFakeS3();
    process.env.S3_ENDPOINT = `http://127.0.0.1:${s3.port}`;
    process.env.S3_SPACES_KEY = "k";
    process.env.S3_SPACES_SECRET = "s";
    process.env.S3_BUCKET_NAME = "late-bucket";

    try {
        await withServer(buildUploadApp({}), async (base) => {
            const { status } = await postFile(base, {
                bytes: await pngBytes(),
                filename: "a.png",
                contentType: "image/png",
            });
            assert.strictEqual(status, 201);
        });
    } finally {
        s3.close();
    }
});
