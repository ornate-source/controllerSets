import { ErrorRequestHandler, NextFunction, Request, Response, Router } from "express";
import { Document, Model, PopulateOptions } from "mongoose";

/** Result returned by the onGet hook */
export interface OnGetResult {
    populates?: string | PopulateOptions | (string | PopulateOptions)[];
    selects?: string;
}

/** onGet hook function type */
export type OnGetFn = (
    req: Request,
    res: Response,
) => OnGetResult | Promise<OnGetResult>;

export type ImageOptimizationLevel = "low" | "medium" | "med" | "high";

/** Minimal logging surface; defaults to the console. */
export interface Logger {
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug?(...args: unknown[]): void;
}

/**
 * Per-verb field policy. A flat array applies to both create and update.
 */
export type FieldPolicy = string[] | { create?: string[]; update?: string[] };

export interface ControllerOptions<T extends Document = any> {
    model: Model<T>;
    orderBy?: string;
    /** Query-string params exposed as equality filters. Also the default filterable/sortable set. */
    query?: string[];
    search?: string | string[];
    runAfterCreate?: ((result: any) => void | Promise<void>) | "none";
    onGet?: OnGetFn | "none";

    /** Fields a client may write. Unset means every schema field is writable. */
    allowedFields?: FieldPolicy;
    /** Fields a client may never write. Applied after `allowedFields`. */
    blockedFields?: FieldPolicy;
    /** Fields usable with `?compareField=` / `?rangeField=`. Defaults to `query`. */
    filterableFields?: string[];
    /** Fields usable with `?sort=`. Defaults to `query` plus the `orderBy` field. */
    sortableFields?: string[];

    /** Hard cap on returned documents, paginated or not. Default 100. */
    maxLimit?: number;
    /** Maximum accepted length of a search term. Default 128. */
    maxSearchLength?: number;
    /** Pass search terms to MongoDB unescaped. Unsafe for untrusted callers. Default false. */
    allowRawRegex?: boolean;
    /** Return plain objects, bypassing schema `toJSON` transforms. Default false. */
    lean?: boolean;
    /** Propagate `runAfterCreate` failures instead of logging them. Default false. */
    strictAfterCreate?: boolean;
    /** Restore 2.x behaviour: no field gating, raw regex, unbounded reads. */
    legacyMode?: boolean;
    logger?: Logger;
}

/**
 * ControllerSets - Express CRUD logic for Mongoose models.
 */
export class ControllerSets<T extends Document = any> {
    constructor(options: ControllerOptions<T>);
    /** @deprecated Use the options-object form. */
    constructor(
        model: Model<T>,
        orderBy?: string,
        query?: string[],
        search?: string | string[],
        runAfterCreate?: ((result: any) => void | Promise<void>) | "none",
        onGet?: OnGetFn | "none",
    );

    getPopulates(
        req: Request,
        res: Response,
    ): Promise<{
        populates: string | PopulateOptions | (string | PopulateOptions)[];
        selects: string;
    }>;
    getAll(req: Request, res: Response): Promise<Response | void>;
    getById(req: Request, res: Response): Promise<Response | void>;
    create(req: Request, res: Response): Promise<Response | void>;
    update(req: Request, res: Response): Promise<Response | void>;
    delete(req: Request, res: Response): Promise<Response | void>;
}

export interface UploadField {
    name: string;
    maxCount: number;
    formatToUrlObject?: boolean;
}

export interface UploadOptions {
    uploadPath?: string;
    fields?: UploadField[];
    /** Object ACL. Defaults to `private`. */
    acl?: "private" | "public-read" | "authenticated-read" | string;
    /** Content types accepted after sniffing the bytes. Defaults to common images and PDF. */
    allowedMimeTypes?: string[];
    /** Per-file size limit in bytes. Default 10MB. */
    maxFileSize?: number;
    /** Maximum number of files per request. Default 10. */
    maxFiles?: number;
    imgOptimizations?: ImageOptimizationLevel;
    /** Let clients choose the optimization level. CPU-amplification risk. Default false. */
    allowClientImageOptions?: boolean;
}

export interface RouterOptions<T extends Document = any> extends ControllerOptions<T> {
    middlewares?: any[];
}

export interface RouterS3Options<T extends Document = any> extends RouterOptions<T> {
    path?: string;
    fields?: UploadField[];
    imgOptimizations?: ImageOptimizationLevel;
    /** Additional upload settings (ACL, mime allowlist, limits). */
    upload?: Omit<UploadOptions, "uploadPath" | "fields" | "imgOptimizations">;
}

/**
 * Creates a standard Express router for the given model.
 */
export function createRouter<T extends Document = any>(options: RouterOptions<T>): Router;

/**
 * Creates an Express router with S3 upload support for the given model.
 */
export function createRouterS3upload<T extends Document = any>(
    options: RouterS3Options<T>,
): Router;

/**
 * S3 file upload middleware.
 */
export function fileUploadMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
    options?: UploadOptions,
): void;
/** @deprecated Use the options-object form. */
export function fileUploadMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
    uploadPath?: string,
    fields?: UploadField[],
    imgOptimizationsDefault?: ImageOptimizationLevel,
): void;

/**
 * Re-encodes an image toward a target size ratio.
 * Accepts a mime type or a sharp format name; non-optimizable formats pass through.
 */
export function compressImage(
    buffer: Buffer,
    mimetypeOrFormat: string,
    level: ImageOptimizationLevel,
): Promise<Buffer>;

/**
 * Global Express error handler producing consistent JSON responses.
 */
export const errorHandler: ErrorRequestHandler;

/** Error carrying an HTTP status whose message is safe to return to the client. */
export class HttpError extends Error {
    constructor(status: number, message: string);
    status: number;
    expose: true;
}

/** Escapes regex metacharacters so user input matches literally. */
export function escapeRegex(value: unknown): string;
