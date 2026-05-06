import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import sharp from "sharp";

dotenv.config();

// Configuration validation
const requiredEnv = [
    "S3_ENDPOINT",
    "S3_SPACES_KEY",
    "S3_SPACES_SECRET",
    "S3_BUCKET_NAME",
];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
    console.warn(
        `[ControllerSet-S3] WARNING: Missing required S3 environment variables: ${missingEnv.join(", ")}`,
    );
    console.warn(
        `[ControllerSet-S3] S3 uploads will likely fail until these are configured.`,
    );
}

const s3Client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    region: process.env.S3_REGION || "us-east-1",
    credentials: {
        accessKeyId: process.env.S3_SPACES_KEY,
        secretAccessKey: process.env.S3_SPACES_SECRET,
    },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

/**
 * Utility to generate backward-compatible public S3 URL of an object.
 */
function getS3Url(bucket, key) {
    const endpoint = process.env.S3_ENDPOINT || "";
    const cleanEndpoint = endpoint.endsWith("/")
        ? endpoint.slice(0, -1)
        : endpoint;
    return `${cleanEndpoint}/${bucket}/${key}`;
}

/**
 * Iterative Image Compression Utility.
 * Dynamically scales image quality to target the exact file size ratio specified.
 */
async function compressImage(buffer, mimetype, level) {
    const originalSize = buffer.length;
    const format = mimetype.split("/")[1] || "jpeg";

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
            // For files > 1MB, dynamically scale target ratios so that 1MB targets 400KB-450KB, and 5MB targets 600KB-700KB
            const sizeInMB = originalSize / (1024 * 1024);
            const targetMinKB = 400 + (sizeInMB - 1) * ((600 - 400) / (5 - 1));
            const targetMaxKB = 450 + (sizeInMB - 1) * ((700 - 450) / (5 - 1));

            minRatio = (targetMinKB * 1024) / originalSize;
            maxRatio = (targetMaxKB * 1024) / originalSize;
            startQuality = 30; // Start lower for large files to speed up convergence
        } else {
            minRatio = 0.4;
            maxRatio = 0.45;
            startQuality = 45;
        }
    } else {
        // No optimization if target level is unrecognized
        return buffer;
    }

    const minQuality = 25;
    const maxQuality = 95;

    let lowQ = minQuality;
    let highQ = maxQuality;
    let currentQuality = startQuality;
    let bestBuffer = buffer;
    let bestDiff = Infinity;

    // Fast iterative binary search (max 7 loops to guarantee exact ratio match without latency)
    for (let i = 0; i < 7; i++) {
        let compressed;
        try {
            if (format === "png") {
                compressed = await sharp(buffer)
                    .png({ quality: currentQuality, palette: true })
                    .toBuffer();
            } else if (format === "webp") {
                compressed = await sharp(buffer)
                    .webp({ quality: currentQuality })
                    .toBuffer();
            } else {
                compressed = await sharp(buffer)
                    .jpeg({ quality: currentQuality })
                    .toBuffer();
            }
        } catch (err) {
            console.warn(
                `[ControllerSet-S3] Unable to optimize image format '${format}': ${err.message}. Uploading original instead.`,
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
            const nextQuality = Math.floor((currentQuality + lowQ) / 2);
            if (nextQuality === currentQuality) break;
            currentQuality = nextQuality;
        } else {
            lowQ = currentQuality + 1;
            const nextQuality = Math.ceil((currentQuality + highQ) / 2);
            if (nextQuality === currentQuality) break;
            currentQuality = nextQuality;
        }

        if (currentQuality < minQuality || currentQuality > maxQuality) {
            break;
        }
    }

    return bestBuffer;
}

/**
 * Modern S3 File Upload Middleware.
 * Handles single/multiple fields, runs image compression/optimization, and populates req.body with S3 URLs.
 */
const fileUploadMiddleware = (
    req,
    res,
    next,
    uploadPath = "files/",
    fields = [{ name: "file", maxCount: 1 }],
    imgOptimizationsDefault = undefined,
) => {
    // Fail fast if config is missing
    if (missingEnv.length > 0) {
        return res.status(503).json({
            success: false,
            error: "S3 service is not properly configured on the server.",
        });
    }

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: 10 * 1024 * 1024, // 10MB default limit
        },
    });

    const handleUploadResult = async (error) => {
        if (error) {
            console.error(`[ControllerSet-S3] Multer Error: ${error.message}`);

            // Handle specific Multer errors
            if (error instanceof multer.MulterError) {
                return res.status(400).json({
                    success: false,
                    error: `File upload error: ${error.message}`,
                });
            }

            return res.status(500).json({
                success: false,
                error: error.message || "Failed to process S3 upload.",
            });
        }

        const imgOptimizations =
            req.query?.imgOptimizations ||
            req.body?.imgOptimizations ||
            req.headers?.imgoptimizations ||
            req.headers?.["x-img-optimizations"] ||
            req.query?.imageOptimizations ||
            req.body?.imageOptimizations ||
            imgOptimizationsDefault;

        const filesToUpload = [];

        if (req.file) {
            filesToUpload.push({
                file: req.file,
                isSingle: true,
                fieldname: req.file.fieldname,
            });
        } else if (req.files) {
            fields.forEach((field) => {
                const fieldFiles = Array.isArray(req.files)
                    ? req.files.filter((f) => f.fieldname === field.name)
                    : req.files[field.name];

                if (fieldFiles && fieldFiles.length > 0) {
                    fieldFiles.forEach((file) => {
                        filesToUpload.push({
                            file: file,
                            isSingle: false,
                            fieldname: field.name,
                        });
                    });
                }
            });
        }

        try {
            for (const item of filesToUpload) {
                const file = item.file;

                // Compress image if optimization requested & file is indeed an image
                const isImage =
                    file.mimetype && file.mimetype.startsWith("image/");
                if (isImage && imgOptimizations) {
                    const originalSize = file.buffer.length;
                    file.buffer = await compressImage(
                        file.buffer,
                        file.mimetype,
                        imgOptimizations,
                    );
                    file.size = file.buffer.length;
                    console.log(
                        `[ControllerSet-S3] Image Optimization [${imgOptimizations}]: ${file.originalname} reduced from ${originalSize} to ${file.size} bytes (${Math.round((file.size / originalSize) * 100)}%)`,
                    );
                }

                // Generate unique S3 Key
                const uniqueId =
                    Date.now() + "-" + Math.round(Math.random() * 1e9);
                const extension = path.extname(file.originalname);
                const finalPath = path.posix.join(
                    uploadPath,
                    `${uniqueId}${extension}`,
                );

                // Upload to S3
                const command = new PutObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: finalPath,
                    Body: file.buffer,
                    ContentType: file.mimetype || "application/octet-stream",
                    ACL: "public-read",
                });
                await s3Client.send(command);

                // Populate file object with public location
                file.location = getS3Url(BUCKET_NAME, finalPath);
            }

            // Populate req.body with file locations
            if (req.file) {
                const field =
                    fields.find((f) => f.name === req.file.fieldname) ||
                    fields[0];
                req.body[field.name] = field.formatToUrlObject
                    ? { url: req.file.location }
                    : req.file.location;
            } else if (req.files) {
                fields.forEach((field) => {
                    const fieldFiles = Array.isArray(req.files)
                        ? req.files.filter((f) => f.fieldname === field.name)
                        : req.files[field.name];

                    if (fieldFiles && fieldFiles.length > 0) {
                        const locations = fieldFiles.map((f) =>
                            field.formatToUrlObject
                                ? { url: f.location }
                                : f.location,
                        );
                        // If maxCount is 1, return single string, else array
                        req.body[field.name] =
                            field.maxCount === 1 ? locations[0] : locations;
                    }
                });
            }

            if (typeof next === "function") {
                next();
            }
        } catch (uploadErr) {
            console.error(
                `[ControllerSet-S3] Upload error during processing:`,
                uploadErr,
            );
            return res.status(500).json({
                success: false,
                error: uploadErr.message || "Failed to process S3 upload.",
            });
        }
    };

    if (fields.length === 1 && fields[0].maxCount === 1) {
        upload.single(fields[0].name)(req, res, handleUploadResult);
    } else {
        upload.fields(fields)(req, res, handleUploadResult);
    }
};

export { compressImage, fileUploadMiddleware };
