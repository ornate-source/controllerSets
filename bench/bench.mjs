/**
 * Request-path benchmark.
 *
 * Every participant serves the same collection from the same MongoDB with the
 * same indexes, so the only difference measured is what each one does between
 * the socket and the driver.
 */
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createRouter } from "../src/index.js";

// express-restify-mongoose is optional: it depends on its own Mongoose major, so
// it is installed on the side rather than as a dev dependency of this package.
//   mkdir -p .bench && cd .bench && npm init -y && npm i express-restify-mongoose


const N = Number(process.env.DOCS ?? 100_000);
const PAGE = 50;

const mongod = await MongoMemoryServer.create();
const uri = mongod.getUri();
await mongoose.connect(uri);

const schema = new mongoose.Schema(
    { name: String, bucket: Number, tag: String, price: Number },
    { timestamps: true },
);
schema.index({ bucket: 1, _id: 1 });
schema.index({ tag: 1, bucket: 1, _id: 1 });
const Item = mongoose.model("Item", schema);

process.stdout.write(`seeding ${N.toLocaleString()} docs… `);
for (let i = 0; i < N; i += 10_000) {
    await Item.insertMany(
        Array.from({ length: Math.min(10_000, N - i) }, (_, j) => ({
            name: `item-${i + j}`,
            bucket: (i + j) % 100,
            tag: (i + j) % 2 ? "odd" : "even",
            price: (i + j) % 997,
        })),
        { ordered: false },
    );
}
await Item.syncIndexes();
const anyId = (await Item.findOne().select("_id").lean())._id.toString();
console.log("done");

/* ------------------------------------------------------------------ *
 * Participants
 * ------------------------------------------------------------------ */

const listen = (app) => {
    const server = app.listen(0);
    return { server, base: `http://localhost:${server.address().port}` };
};

// 1. What a developer writes by hand: the same read, no library.
const handWritten = () => {
    const app = express();
    app.use(express.json());
    const r = express.Router();

    r.get("/", async (req, res, next) => {
        try {
            const filters = {};
            if (req.query.tag) filters.tag = req.query.tag;

            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 50));

            const [total, data] = await Promise.all([
                Item.countDocuments(filters),
                Item.find(filters)
                    .sort({ bucket: 1 })
                    .skip((page - 1) * pageSize)
                    .limit(pageSize)
                    .lean(),
            ]);

            res.json({
                success: true,
                data,
                pagination: {
                    currentPage: page,
                    pageSize,
                    totalPages: Math.ceil(total / pageSize),
                    totalRecords: total,
                },
            });
        } catch (err) {
            next(err);
        }
    });

    r.get("/:id", async (req, res, next) => {
        try {
            if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
                return res.status(400).json({ success: false, error: "Invalid ID format." });
            }
            const doc = await Item.findById(req.params.id).lean();
            if (!doc) return res.status(404).json({ success: false, error: "Entry not found." });
            res.json({ success: true, data: doc });
        } catch (err) {
            next(err);
        }
    });

    r.post("/", async (req, res, next) => {
        try {
            const { name, price, tag, bucket } = req.body;
            const doc = await Item.create({ name, price, tag, bucket });
            res.status(201).json({ success: true, data: doc });
        } catch (err) {
            next(err);
        }
    });

    app.use("/items", r);
    return listen(app);
};

const controllerSets = (options) => {
    const app = express();
    app.use(express.json());
    app.use(
        "/items",
        createRouter({
            model: Item,
            logger: { warn() {}, error() {}, debug() {} },
            orderBy: "bucket",
            query: ["tag"],
            filterableFields: ["tag", "bucket", "price"],
            sortableFields: ["bucket", "price", "name"],
            allowedFields: ["name", "price", "tag", "bucket"],
            lean: true,
            ...options,
        }),
    );
    return listen(app);
};

// 3. express-restify-mongoose, the established auto-CRUD library. It depends on
//    its own mongoose 8, so it gets its own connection and model against the
//    same database — noted in the results, since the driver differs.
const restifyMongoose = async () => {
    const { default: erm } = await import("../.bench/node_modules/express-restify-mongoose/dist/express-restify-mongoose.js");
    const { default: m8 } = await import("../.bench/node_modules/mongoose/index.js");

    await m8.connect(uri);
    // A distinct model name on its own connection, pointed at the same
    // collection, so both libraries serve byte-identical documents.
    const s8 = new m8.Schema(
        { name: String, bucket: Number, tag: String, price: Number },
        { timestamps: true, collection: "items" },
    );
    const Item8 = m8.model("ErmItem", s8);

    const app = express();
    app.use(express.json());
    erm.serve(app, Item8, { prefix: "", version: "", name: "items", lean: true });
    return { ...listen(app), version: m8.version };
};

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const measure = async (url, { warmup = 150, iterations = 600, init } = {}) => {
    for (let i = 0; i < warmup; i++) await fetch(url, init).then((r) => r.arrayBuffer());

    const samples = [];
    const started = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        const t = process.hrtime.bigint();
        const res = await fetch(url, init);
        await res.arrayBuffer();
        samples.push(Number(process.hrtime.bigint() - t) / 1e6);
        if (res.status >= 400) return { error: res.status };
    }
    const wall = Number(process.hrtime.bigint() - started) / 1e6;

    samples.sort((a, b) => a - b);
    return {
        median: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        rps: Math.round(iterations / (wall / 1000)),
    };
};

const row = (label, result) =>
    result?.error
        ? `  ${label.padEnd(34)} — HTTP ${result.error}`
        : `  ${label.padEnd(34)} ${result.median.toFixed(2).padStart(7)} ms   ${result.p95
              .toFixed(2)
              .padStart(7)} ms   ${String(result.rps).padStart(6)} req/s`;

const header = (title) =>
    console.log(`\n${title}\n  ${"participant".padEnd(34)} ${"median".padStart(7)}   ${"p95".padStart(7)}   ${"throughput".padStart(6)}`);

/* ------------------------------------------------------------------ */

const raw = handWritten();
const offset = controllerSets({});
const cursor = controllerSets({ pagination: "cursor" });
const fast = controllerSets({ countStrategy: "none" });

let erm = null;
try {
    erm = await restifyMongoose();
    console.log(`(express-restify-mongoose on its own mongoose ${erm.version})`);
} catch (err) {
    console.log(`(express-restify-mongoose unavailable: ${err.message.split("\n")[0]})`);
}

header(`LIST — page 1, ${PAGE} of ${N.toLocaleString()} docs, filtered + sorted`);
console.log(row("hand-written Express + Mongoose", await measure(`${raw.base}/items?tag=even&page=1&pageSize=${PAGE}`)));
console.log(row("controller-sets (offset)", await measure(`${offset.base}/items?tag=even&page=1&pageSize=${PAGE}`)));
console.log(row("controller-sets (count: none)", await measure(`${fast.base}/items?tag=even&page=1&pageSize=${PAGE}`)));
console.log(row("controller-sets (cursor)", await measure(`${cursor.base}/items?tag=even&pageSize=${PAGE}`)));
if (erm) {
    const ermQuery = encodeURIComponent(JSON.stringify({ tag: "even" }));
    console.log(row("express-restify-mongoose", await measure(`${erm.base}/items?query=${ermQuery}&limit=${PAGE}&sort=bucket`)));

    // ERM returns a bare array: totals come from a second endpoint. This is the
    // like-for-like comparison against a default controller-sets page, which
    // returns documents and totals in one request.
    const both = async () => {
        const t = process.hrtime.bigint();
        await Promise.all([
            fetch(`${erm.base}/items?query=${ermQuery}&limit=${PAGE}&sort=bucket`).then((r) => r.arrayBuffer()),
            fetch(`${erm.base}/items/count?query=${ermQuery}`).then((r) => r.arrayBuffer()),
        ]);
        return Number(process.hrtime.bigint() - t) / 1e6;
    };
    for (let i = 0; i < 100; i++) await both();
    const samples = [];
    const started = process.hrtime.bigint();
    for (let i = 0; i < 400; i++) samples.push(await both());
    const wall = Number(process.hrtime.bigint() - started) / 1e6;
    samples.sort((a, b) => a - b);
    console.log(row("  ↳ + /count (same information)", {
        median: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        rps: Math.round(400 / (wall / 1000)),
    }));
}

const deep = Math.floor(N / 2 / PAGE);
header(`LIST — deep page ${deep.toLocaleString()} (skip ${((deep - 1) * PAGE).toLocaleString()})`);
console.log(row("hand-written Express + Mongoose", await measure(`${raw.base}/items?page=${deep}&pageSize=${PAGE}`, { iterations: 200 })));
console.log(row("controller-sets (offset)", await measure(`${offset.base}/items?page=${deep}&pageSize=${PAGE}`, { iterations: 200 })));
if (erm) console.log(row("express-restify-mongoose", await measure(`${erm.base}/items?skip=${(deep - 1) * PAGE}&limit=${PAGE}&sort=bucket`, { iterations: 200 })));
{
    // Walk to the same depth by cursor and time the page that lands there.
    let token = null;
    for (let i = 0; i < deep - 1; i++) {
        const body = await (await fetch(`${cursor.base}/items?pageSize=${PAGE}${token ? `&cursor=${token}` : ""}`)).json();
        token = body.pagination.nextCursor;
        if (!token) break;
    }
    console.log(row("controller-sets (cursor)", await measure(`${cursor.base}/items?pageSize=${PAGE}&cursor=${token}`, { iterations: 200 })));
}

header("GET /:id");
console.log(row("hand-written Express + Mongoose", await measure(`${raw.base}/items/${anyId}`)));
console.log(row("controller-sets", await measure(`${offset.base}/items/${anyId}`)));
if (erm) console.log(row("express-restify-mongoose", await measure(`${erm.base}/items/${anyId}`)));

header("POST /");
const post = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "bench", price: 1, tag: "even", bucket: 1 }),
};
console.log(row("hand-written Express + Mongoose", await measure(`${raw.base}/items`, { init: post, warmup: 50, iterations: 300 })));
console.log(row("controller-sets", await measure(`${offset.base}/items`, { init: post, warmup: 50, iterations: 300 })));
if (erm) console.log(row("express-restify-mongoose", await measure(`${erm.base}/items`, { init: post, warmup: 50, iterations: 300 })));

for (const p of [raw, offset, cursor, fast, erm]) p?.server?.close();
await mongoose.disconnect();
if (erm) {
    const { default: m8 } = await import("../.bench/node_modules/mongoose/index.js");
    await m8.disconnect();
}
await mongod.stop();
