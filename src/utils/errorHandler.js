import { randomUUID } from "crypto";

/**
 * Global Error Handler - Express error middleware.
 *
 * Client-facing messages are authored deliberately. Anything unclassified is
 * reported generically: Mongoose and the AWS SDK put connection strings, hostnames,
 * bucket names, and index definitions into `err.message`, and echoing that back
 * hands an attacker a map of the infrastructure.
 */
export const errorHandler = (err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    const requestId = req.id ?? randomUUID();

    let statusCode = err.status ?? err.statusCode ?? 500;
    let message = err.message || "Internal Server Error";
    let expose = err.expose === true;

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
    }

    // MongoDB: duplicate key. A unique-constraint collision is a client-correctable
    // conflict, not a server fault, so it must not fall through to a 500.
    if (err.code === 11000) {
        statusCode = 409;
        const fields = Object.keys(err.keyPattern ?? err.keyValue ?? {});
        message = fields.length
            ? `Duplicate value for: ${fields.join(", ")}.`
            : "Duplicate value violates a unique constraint.";
        expose = true;
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
        requestId,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
};
