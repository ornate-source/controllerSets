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

/** Which write a hook is running for. */
export type WriteOperation = "create" | "update";

/** What a `validate` hook is told about the request it is checking. */
export interface ValidateContext<T extends Document = any> {
    req: Request;
    res: Response;
    operation: WriteOperation;
    model: Model<T>;
    /** The target document's id on an update; `undefined` on a create. */
    id?: string;
}

/**
 * Checks a write before it reaches Mongoose.
 *
 * Receives the payload *after* `allowedFields` / `blockedFields` have been
 * applied, so it never sees a field a client was not allowed to send.
 *
 * It runs *before* the schema, so a field your schema marks `required` may still
 * be absent here — check before dereferencing.
 *
 * Return nothing to accept it as-is, or a plain object to replace it — which is
 * how a hook normalises values or sets server-owned fields such as `ownerId`.
 * Throw `ValidationError` to reject with per-field messages, or any `HttpError`
 * for a plain status. Anything else thrown becomes a 500.
 */
export type ValidateFn<T extends Document = any> = (
    payload: Record<string, any>,
    context: ValidateContext<T>,
) => void | Record<string, any> | Promise<void | Record<string, any>>;

/** One validator for both writes, or one per write. */
export type ValidatePolicy<T extends Document = any> =
    | ValidateFn<T>
    | { create?: ValidateFn<T>; update?: ValidateFn<T> };

/**
 * How a paginated read learns how many records matched.
 *
 * - `exact` — `countDocuments`; correct, and the default.
 * - `estimated` — collection metadata, O(1), but blind to filters, so a filtered
 *   read still counts exactly.
 * - `none` — no count query at all. `pagination` carries `hasMore` in place of
 *   `totalPages` / `totalRecords`.
 */
export type CountStrategy = "exact" | "estimated" | "none";

/**
 * How a list endpoint paginates.
 *
 * - `offset` — `?page=` / `?pageSize=`, with totals. Familiar, but the database
 *   walks every skipped record, so deep pages get slower as the data grows.
 * - `cursor` — keyset pagination. Each page is one index seek whatever its
 *   depth, and no count runs. The first page takes no parameter; follow
 *   `pagination.nextCursor` from there.
 */
export type PaginationMode = "offset" | "cursor";

/** A value a client may put in a QUERY filter. */
export type FilterScalar = string | number | boolean | null;

/** Operators accepted inside a QUERY body's `filter`, spelled without `$`. */
export interface FilterOperators {
    eq?: FilterScalar;
    ne?: FilterScalar;
    gt?: FilterScalar;
    gte?: FilterScalar;
    lt?: FilterScalar;
    lte?: FilterScalar;
    in?: FilterScalar[];
    nin?: FilterScalar[];
}

/** One entry of `filter`: equality, an implicit `in`, or an operator object. */
export type FilterCondition = FilterScalar | FilterScalar[] | FilterOperators;

/**
 * Body of an HTTP QUERY request. Every key is optional; an empty body is an
 * unfiltered list, capped at `maxLimit`. Unknown keys are rejected with 400.
 */
export interface QueryRequestBody {
    /** Field-to-condition map. Fields must appear in `filterableFields`. */
    filter?: Record<string, FilterCondition>;
    /** Search term, applied to the configured `search` fields. */
    search?: string;
    /** `"price"` or `"-price"`; a list sorts on several keys, up to five. */
    sort?: string | string[];
    /** 1-based page number. Mutually exclusive with `limit`. */
    page?: number;
    /** Records per page, capped at `maxLimit`. Implies `page: 1`. */
    pageSize?: number;
    /** Cap on an unpaginated read, itself capped at `maxLimit`. */
    limit?: number;
    /** Keyset cursor from a previous response. Only in `pagination: "cursor"` mode. */
    cursor?: string;
}

/** The runtime mapping from a QUERY filter operator to its MongoDB operator. */
export const QUERY_FILTER_OPERATORS: Readonly<Record<keyof FilterOperators, string>>;

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
    /**
     * Fields usable with `?compareField=` / `?rangeField=` and with the `filter`
     * of an HTTP QUERY body. Defaults to `query`.
     */
    filterableFields?: string[];
    /**
     * Fields usable with `?sort=` and with a QUERY body's `sort`.
     * Defaults to `query` plus the `orderBy` field.
     */
    sortableFields?: string[];

    /** Checks a write before it reaches Mongoose. See {@link ValidateFn}. */
    validate?: ValidatePolicy<T>;

    /** Hard cap on returned documents, paginated or not. Default 100. */
    maxLimit?: number;
    /** Page size when `?page=` is given without `pageSize`. Default 50, capped by `maxLimit`. */
    defaultPageSize?: number;
    /**
     * Highest page a client may request. Off by default.
     * A deep page costs the database a full index walk to skip; beyond this one
     * the request is refused with 400 rather than served.
     */
    maxPage?: number;
    /** How a paginated read counts matches. Default `"exact"`. */
    countStrategy?: CountStrategy;
    /** Offset or keyset pagination. Default `"offset"`. */
    pagination?: PaginationMode;
    /**
     * Cap on ids pulled from a referenced collection by a relational search.
     * Default 1000 — that `$in` grows with the collection, not with the page.
     */
    maxRelationMatches?: number;
    /** Let MongoDB sort on disk. Sorts above 100MB fail outright without it. */
    allowDiskUse?: boolean;
    /** Driver batch size, for walking large result sets in fewer round trips. */
    batchSize?: number;
    /**
     * Server-side time limit per query, in milliseconds. Off by default.
     * The only bound on a query that is slow in the database rather than here.
     */
    maxTimeMS?: number;
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

/** Pagination block returned with a paginated read. */
export type Pagination =
    | { currentPage: number; pageSize: number; totalPages: number; totalRecords: number }
    | { currentPage: number; pageSize: number; hasMore: boolean }
    | { pageSize: number; hasMore: boolean; nextCursor: string | null };

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
    /** GET / */
    getAll(req: Request, res: Response): Promise<Response | void>;
    /** QUERY / — a read whose parameters arrive in a JSON body. */
    query(req: Request, res: Response): Promise<Response | void>;
    /** GET /:id */
    get(req: Request, res: Response): Promise<Response | void>;
    /** POST / */
    create(req: Request, res: Response): Promise<Response | void>;
    /** PATCH /:id */
    update(req: Request, res: Response): Promise<Response | void>;
    /** DELETE /:id */
    delete(req: Request, res: Response): Promise<Response | void>;
    /** @deprecated Renamed to `get`. */
    getById(req: Request, res: Response): Promise<Response | void>;
    /** @deprecated Renamed to `query`. */
    queryAll(req: Request, res: Response): Promise<Response | void>;
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
    /** Mount the HTTP QUERY route on `/`. Default true. */
    enableQuery?: boolean;
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
 * Whether this runtime serves the HTTP QUERY method — Node 22.2+ with an Express
 * build whose router exposes the verb. `createRouter` skips the QUERY route and
 * warns once when it returns false.
 */
export function isQueryMethodSupported(): boolean;

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
    constructor(status: number, message: string, options?: { headers?: Record<string, string> });
    status: number;
    expose: true;
    /** Response headers that belong with this status, if any. */
    headers?: Record<string, string>;
}

/**
 * A rejected request body, optionally with per-field messages. Throw this from a
 * `validate` hook; the response carries `fields` alongside `error`.
 */
export class ValidationError extends HttpError {
    constructor(message: string, fields?: Record<string, string>, status?: number);
    fields?: Record<string, string>;
}

/** Escapes regex metacharacters so user input matches literally. */
export function escapeRegex(value: unknown): string;
