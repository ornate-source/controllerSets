import { randomUUID } from "crypto";

// Anything unclassified is reported generically: Mongoose and the AWS SDK put
// connection strings, hostnames and bucket names into `err.message`, and echoing
// that hands an attacker a map of the infrastructure.
export const errorHandler = (err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    const requestId = req.id ?? randomUUID();

    let statusCode = err.status ?? err.statusCode ?? 500;
    let message = err.message || "Internal Server Error";
    let expose = err.expose === true;

    // Per-field messages from a `validate` hook; Mongoose's own are added below.
    let fields = err.fields && typeof err.fields === "object" ? err.fields : undefined;

    // Some errors name the header that belongs with their status.
    if (err.headers && !res.headersSent) {
        for (const [name, value] of Object.entries(err.headers)) {
            res.setHeader(name, value);
        }
    }

    // Mongoose: invalid ID / cast failure
    if (err.name === "CastError") {
        statusCode = 400;
        message = `Invalid value for ${err.path}.`;
        expose = true;
    }

    // Mongoose: schema validation
    if (err.name === "ValidationError" && err.errors) {
        statusCode = 400;
        message = `Validation Error: ${Object.values(err.errors)
            .map((val) => val.message)
            .join(", ")}`;
        expose = true;
        fields ??= Object.fromEntries(
            Object.entries(err.errors).map(([path, detail]) => [path, detail.message]),
        );
    }

    // MongoDB duplicate key: a client-correctable conflict, not a server fault.
    if (err.code === 11000) {
        statusCode = 409;
        const duplicated = Object.keys(err.keyPattern ?? err.keyValue ?? {});
        message = duplicated.length
            ? `Duplicate value for: ${duplicated.join(", ")}.`
            : "Duplicate value violates a unique constraint.";
        expose = true;
        if (duplicated.length) {
            fields ??= Object.fromEntries(duplicated.map((key) => [key, "Already exists."]));
        }
    }

    // Multer: upload limits and field errors
    if (err.name === "MulterError") {
        statusCode = 400;
        message = `Upload Error: ${err.message}`;
        expose = true;
    }

    const isServerError = statusCode >= 500;

    console.error(
        `[API Error] [${requestId}] ${req.method ?? "-"} ${req.originalUrl ?? "-"} ` +
            `${statusCode} ${err.name || "Error"}: ${err.message}`,
    );
    if (isServerError && err.stack) {
        console.error(err.stack);
    }

    return res.status(statusCode).json({
        success: false,
        error: isServerError && !expose ? "Internal Server Error" : message,
        // Never on a 5xx: an internal failure's detail is not the client's.
        fields: isServerError ? undefined : fields,
        requestId,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
};
