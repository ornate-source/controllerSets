/**
 * Global Error Handler - Professional Express Middleware.
 * Ensures consistent JSON responses for all API errors.
 */
export const errorHandler = (err, req, res, next) => {
    // 1. Log errors for developer visibility
    console.error(`[API Error] ${err.name || "Error"}: ${err.message}`);

    // 2. Default standard error response
    let statusCode = err.status || 500;
    let message = err.message || "Internal Server Error";

    // 3. Handle Special Error Types (Mongoose, Multer)
    
    // Mongoose: Invalid ID format (CastError)
    if (err.name === "CastError") {
        statusCode = 400;
        message = `Invalid value for ${err.path}: ${err.value}`;
    }

    // Mongoose: Schema Validation Error
    if (err.name === "ValidationError") {
        statusCode = 400;
        const messages = Object.values(err.errors).map(val => val.message);
        message = `Validation Error: ${messages.join(", ")}`;
    }

    // Multer: File Upload Limits or Errors
    if (err.name === "MulterError") {
        statusCode = 400;
        message = `Upload Error: ${err.message}`;
    }

    // 4. Send the JSON response
    return res.status(statusCode).json({
        success: false,
        error: message,
        // Stack trace only in non-production environments
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });
};
