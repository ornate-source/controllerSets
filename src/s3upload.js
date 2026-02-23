import { S3Client } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";

dotenv.config();

// Configuration validation
const requiredEnv = ["S3_ENDPOINT", "S3_SPACES_KEY", "S3_SPACES_SECRET", "S3_BUCKET_NAME"];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
    console.warn(`[ControllerSet-S3] WARNING: Missing required S3 environment variables: ${missingEnv.join(", ")}`);
    console.warn(`[ControllerSet-S3] S3 uploads will likely fail until these are configured.`);
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
 * Modern S3 File Upload Middleware.
 * Handles single/multiple fields and populates req.body with S3 URLs.
 */
const fileUploadMiddleware = (
    req,
    res,
    next,
    uploadPath = "files/",
    fields = [{ name: "file", maxCount: 1 }]
) => {
    // Fail fast if config is missing
    if (missingEnv.length > 0) {
        return res.status(503).json({
            success: false,
            error: "S3 service is not properly configured on the server."
        });
    }

    const upload = multer({
        storage: multerS3({
            s3: s3Client,
            bucket: BUCKET_NAME,
            acl: "public-read",
            contentType: multerS3.AUTO_CONTENT_TYPE,
            key: (req, file, cb) => {
                const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const extension = path.extname(file.originalname);
                const finalPath = path.posix.join(uploadPath, `${uniqueId}${extension}`);
                cb(null, finalPath);
            },
        }),
        limits: {
            fileSize: 10 * 1024 * 1024, // 10MB default limit
        }
    });

    const handleUploadResult = (error) => {
        if (error) {
            console.error(`[ControllerSet-S3] Upload Error: ${error.message}`);
            return res.status(500).json({ 
                success: false, 
                error: error.message || "Failed to process S3 upload." 
            });
        }

        // Populate req.body with file locations
        if (fields.length === 1 && req.file) {
            req.body[fields[0].name] = req.file.location;
        } else if (req.files) {
            fields.forEach((field) => {
                if (req.files[field.name]) {
                    const locations = req.files[field.name].map(f => f.location);
                    // If maxCount is 1, return single string, else array
                    req.body[field.name] = (field.maxCount === 1) ? locations[0] : locations;
                }
            });
        }
        next();
    };

    // Determine if single field or multiple
    if (fields.length === 1) {
        upload.single(fields[0].name)(req, res, handleUploadResult);
    } else {
        upload.fields(fields)(req, res, handleUploadResult);
    }
};

export { fileUploadMiddleware };
