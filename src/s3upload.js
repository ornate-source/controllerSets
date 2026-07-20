import path from "path";
import {
    ACTIVE_CONTENT_TYPES,
    INLINE_SAFE_TYPES,
    detectFileType,
    sharpFormatFor,
} from "./utils/fileType.js";

/**
 * Conservative default. A consumer who needs more can widen it explicitly, which
 * makes accepting active content a decision someone made rather than a default
 * nobody noticed.
 */
const DEFAULT_ALLOWED_MIME_TYPES = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
    "application/pdf",
];

/** Formats sharp can re-encode without changing the container. */
const OPTIMIZABLE_FORMATS = ["jpeg", "png", "webp"];

const VALID_LEVELS = ["low", "medium", "med", "high"];

const DEFAULTS = {
    uploadPath: "files/",
    fields: [{ name: "file", maxCount: 1 }],
    acl: "private",
    allowedMimeTypes: DEFAULT_ALLOWED_MIME_TYPES,
    maxFileSize: 10 * 1024 * 1024,
    maxFiles: 10,
    imgOptimizations: undefined,
    allowClientImageOptions: false,
};

// Cached module handles: these are heavy (sharp ships a native binary, the AWS SDK
// is large) and must not load for consumers who only use the CRUD routes.
let modulesPromise = null;
const loadModules = () => {
    modulesPromise ??= Promise.all([
        import("@aws-sdk/client-s3"),
        import("multer"),
    ]).then(([s3, multer]) => ({ s3, multer: multer.default ?? multer }));
    return modulesPromise;
};

let sharpPromise = null;
const loadSharp = () => {
    sharpPromise ??= import("sharp").then((mod) => mod.default ?? mod);
    return sharpPromise;
};

/**
 * Reads S3 configuration at call time.
 *
 * Deliberately not cached at module scope: an app that loads its environment after
 * importing this package would otherwise be locked into a permanent 503 by a
 * snapshot taken before the variables existed. This module also does not call
 * `dotenv.config()` — loading environment is the host application's decision, not
 * a side effect a library imposes on it.
 */
const readConfig = () => {
    const config = {
        endpoint: process.env.S3_ENDPOINT,
        accessKeyId: process.env.S3_SPACES_KEY,
        secretAccessKey: process.env.S3_SPACES_SECRET,
        bucket: process.env.S3_BUCKET_NAME,
        region: process.env.S3_REGION || "us-east-1",
    };
    const missing = ["endpoint", "accessKeyId", "secretAccessKey", "bucket"].filter(
        (key) => !config[key],
    );
    return { config, missing };
};

let cachedClient = null;
let cachedClientKey = null;

const getClient = async (config) => {
    const key = `${config.endpoint}|${config.region}|${config.accessKeyId}`;
    if (cachedClient && cachedClientKey === key) return cachedClient;

    const { s3 } = await loadModules();
    cachedClient = new s3.S3Client({
        endpoint: config.endpoint,
        forcePathStyle: true,
        region: config.region,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });
    cachedClientKey = key;
    return cachedClient;
};

/**
 * Utility to generate a backward-compatible public S3 URL of an object.
 */
function getS3Url(bucket, key) {
    const endpoint = process.env.S3_ENDPOINT || "";
    const cleanEndpoint = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
    return `${cleanEndpoint}/${bucket}/${key}`;
}

/**
 * Iterative image compression.
 * Binary-searches encoder quality to land within a target size ratio.
 *
 * Accepts either a mime type (`image/jpeg`) or a sharp format name (`jpeg`).
 * Formats outside `OPTIMIZABLE_FORMATS` are returned untouched rather than
 * transcoded: silently turning a GIF into JPEG bytes loses animation and
 * desynchronises the stored extension from the actual content.
 */
async function compressImage(buffer, mimetypeOrFormat, level) {
    const input = String(mimetypeOrFormat ?? "");
    const format = input.includes("/") ? sharpFormatFor(input) : input;

    if (!OPTIMIZABLE_FORMATS.includes(format)) return buffer;

    const originalSize = buffer.length;
    const normLevel = String(level).toLowerCase().trim();
    let minRatio, maxRatio, startQuality;

    if (normLevel === "low") {
        minRatio = 0.75;
        maxRatio = 0.8;
        startQuality = 80;
    } else if (normLevel === "medium" || normLevel === "med") {
        minRatio = 0.6;
        maxRatio = 0.65;
        startQuality = 65;
    } else if (normLevel === "high") {
        if (originalSize > 1 * 1024 * 1024) {
            // For files > 1MB, scale target ratios so 1MB targets 400-450KB and 5MB targets 600-700KB
            const sizeInMB = originalSize / (1024 * 1024);
            const targetMinKB = 400 + (sizeInMB - 1) * ((600 - 400) / (5 - 1));
            const targetMaxKB = 450 + (sizeInMB - 1) * ((700 - 450) / (5 - 1));

            minRatio = (targetMinKB * 1024) / originalSize;
            maxRatio = (targetMaxKB * 1024) / originalSize;
            startQuality = 30;
        } else {
            minRatio = 0.4;
            maxRatio = 0.45;
            startQuality = 45;
        }
    } else {
        return buffer;
    }

    const sharp = await loadSharp();
    const minQuality = 25;
    const maxQuality = 95;

    let lowQ = minQuality;
    let highQ = maxQuality;
    let currentQuality = startQuality;
    let bestBuffer = buffer;
    let bestDiff = Infinity;

    for (let i = 0; i < 7; i++) {
        let compressed;
        try {
            const pipeline = sharp(buffer);
            if (format === "png") {
                compressed = await pipeline.png({ quality: currentQuality, palette: true }).toBuffer();
            } else if (format === "webp") {
                compressed = await pipeline.webp({ quality: currentQuality }).toBuffer();
            } else {
                compressed = await pipeline.jpeg({ quality: currentQuality }).toBuffer();
            }
        } catch (err) {
            console.warn(
                `[ControllerSet-S3] Unable to optimize '${format}': ${err.message}. Uploading original instead.`,
            );
            return buffer;
        }

        const ratio = compressed.length / originalSize;
        const diffToMid = Math.abs(ratio - (minRatio + maxRatio) / 2);

        if (ratio >= minRatio && ratio <= maxRatio) {
            bestBuffer = compressed;
            break;
        }

        if (diffToMid < bestDiff) {
            bestDiff = diffToMid;
            bestBuffer = compressed;
        }

        if (ratio > maxRatio) {
            highQ = currentQuality - 1;
            const next = Math.floor((currentQuality + lowQ) / 2);
            if (next === currentQuality) break;
            currentQuality = next;
        } else {
            lowQ = currentQuality + 1;
            const next = Math.ceil((currentQuality + highQ) / 2);
            if (next === currentQuality) break;
            currentQuality = next;
        }

        if (currentQuality < minQuality || currentQuality > maxQuality) break;
    }

    return bestBuffer;
}

/** Supports both `(…, options)` and the legacy `(…, uploadPath, fields, imgOptimizations)`. */
function normalizeUploadOptions(rest) {
    const [first, second, third] = rest;
    const isOptionsObject = first && typeof first === "object" && !Array.isArray(first);

    const provided = isOptionsObject
        ? first
        : { uploadPath: first, fields: second, imgOptimizations: third };

    const merged = { ...DEFAULTS };
    for (const [key, value] of Object.entries(provided)) {
        if (value !== undefined) merged[key] = value;
    }
    return merged;
}

/**
 * Resolves the optimization level.
 *
 * Server configuration wins by default. The level drives up to seven sequential
 * re-encodes of a multi-megabyte buffer, so letting a client set it turns any
 * upload endpoint into CPU amplification.
 */
function resolveImageLevel(req, options) {
    if (!options.allowClientImageOptions) return options.imgOptimizations;

    const requested =
        req.query?.imgOptimizations ??
        req.body?.imgOptimizations ??
        req.headers?.["x-img-optimizations"];

    if (typeof requested === "string" && VALID_LEVELS.includes(requested.toLowerCase().trim())) {
        return requested.toLowerCase().trim();
    }
    return options.imgOptimizations;
}

const fail = (res, status, error) => res.status(status).json({ success: false, error });

/**
 * S3 upload middleware.
 *
 * Populates `req.body` with the resulting object URLs so the CRUD controller can
 * persist them.
 */
const fileUploadMiddleware = (req, res, next, ...rest) => {
    const options = normalizeUploadOptions(rest);

    runUpload(req, res, next, options).catch((err) => {
        console.error(`[ControllerSet-S3] Unexpected upload failure:`, err);
        if (!res.headersSent) {
            fail(res, 500, "Failed to process S3 upload.");
        }
    });
};

async function runUpload(req, res, next, options) {
    const { config, missing } = readConfig();
    if (missing.length > 0) {
        console.error(
            `[ControllerSet-S3] Missing required S3 environment variables: ${missing.join(", ")}`,
        );
        return fail(res, 503, "S3 service is not properly configured on the server.");
    }

    const { s3, multer } = await loadModules();

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: options.maxFileSize, files: options.maxFiles },
    });

    const runMulter = () =>
        new Promise((resolve, reject) => {
            const done = (err) => (err ? reject(err) : resolve());
            const { fields } = options;
            if (fields.length === 1 && fields[0].maxCount === 1) {
                upload.single(fields[0].name)(req, res, done);
            } else {
                upload.fields(fields)(req, res, done);
            }
        });

    try {
        await runMulter();
    } catch (err) {
        console.error(`[ControllerSet-S3] Multer error: ${err.message}`);
        const isMulterError = err.name === "MulterError";
        return fail(
            res,
            isMulterError ? 400 : 500,
            isMulterError ? `File upload error: ${err.message}` : "Failed to process S3 upload.",
        );
    }

    const level = resolveImageLevel(req, options);
    const filesToUpload = collectFiles(req, options.fields);

    const client = await getClient(config);

    for (const file of filesToUpload) {
        // The declared mimetype is a claim by the client; the bytes are the fact.
        const detected = detectFileType(file.buffer);
        if (!detected) {
            return fail(res, 400, `Unsupported or unrecognised file type for '${file.fieldname}'.`);
        }
        if (!options.allowedMimeTypes.includes(detected.mime)) {
            return fail(res, 400, `File type '${detected.mime}' is not allowed.`);
        }

        let buffer = file.buffer;
        const format = sharpFormatFor(detected.mime);
        if (format && level) {
            buffer = await compressImage(buffer, format, level);
        }

        // Re-detect after compression so the stored extension and Content-Type
        // describe the bytes actually being written, whatever the encoder produced.
        const final = detectFileType(buffer) ?? detected;

        const uniqueId = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const key = path.posix.join(sanitizePrefix(options.uploadPath), `${uniqueId}${final.ext}`);

        const inline = INLINE_SAFE_TYPES.includes(final.mime);
        await client.send(
            new s3.PutObjectCommand({
                Bucket: config.bucket,
                Key: key,
                Body: buffer,
                ContentType: final.mime,
                // Active content is never rendered by the browser on the bucket origin,
                // even when a consumer has explicitly allowlisted the type.
                ContentDisposition: inline && !ACTIVE_CONTENT_TYPES.includes(final.mime)
                    ? "inline"
                    : "attachment",
                ACL: options.acl,
            }),
        );

        file.buffer = buffer;
        file.size = buffer.length;
        file.key = key;
        file.location = getS3Url(config.bucket, key);
    }

    populateBody(req, options.fields);

    if (typeof next === "function") next();
}

/** Normalizes the configured prefix so it cannot escape into an absolute or parent path. */
function sanitizePrefix(prefix) {
    const normalized = path.posix.normalize(String(prefix ?? ""));
    return normalized.replace(/^(\.\.(\/|$))+/, "").replace(/^\/+/, "");
}

function filesForField(req, name) {
    if (!req.files) return [];
    return Array.isArray(req.files)
        ? req.files.filter((f) => f.fieldname === name)
        : (req.files[name] ?? []);
}

function collectFiles(req, fields) {
    if (req.file) return [req.file];
    return fields.flatMap((field) => filesForField(req, field.name));
}

function populateBody(req, fields) {
    if (req.file) {
        const field = fields.find((f) => f.name === req.file.fieldname) ?? fields[0];
        req.body[field.name] = field.formatToUrlObject
            ? { url: req.file.location }
            : req.file.location;
        return;
    }
    if (!req.files) return;

    for (const field of fields) {
        const found = filesForField(req, field.name);
        if (found.length === 0) continue;

        const locations = found.map((f) =>
            field.formatToUrlObject ? { url: f.location } : f.location,
        );
        req.body[field.name] = field.maxCount === 1 ? locations[0] : locations;
    }
}

export { compressImage, fileUploadMiddleware };
