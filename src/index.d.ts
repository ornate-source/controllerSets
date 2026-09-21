import {
    ErrorRequestHandler,
    NextFunction,
    Request,
    RequestHandler,
    Response,
    Router,
} from "express";
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

/** Where cached responses live: Redis, the memory store, or your own. */
export interface CacheStore {
    get(key: string): Promise<string | null | undefined>;
    set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
}

export interface CacheOptions {
    /** Seconds a response stays cached. Env `CACHE_TTL`, default 60. */
    ttl?: number;
    /** Redis connection URL. Env `REDIS_URL`. Needs `ioredis` or `redis` installed. */
    url?: string;
    /** An ioredis or node-redis client you already have, instead of `url`. */
    client?: unknown;
    /** Any store with `get` and `set` — e.g. `createMemoryCacheStore()` for development. */
    store?: CacheStore;
    /** Key prefix. Env `CACHE_PREFIX`, default `"cs:"`. */
    prefix?: string;
    /**
     * What else a response depends on. Default: the signed-in user
     * (`req.auth?.userId`), so users never share entries. `() => ""` shares them.
     */
    vary?: (req: Request) => unknown;
    /** Longest wait for the cache before falling back to the database. Default 150. */
    timeoutMs?: number;
    /** Overrides the router's mount path in cache keys. */
    namespace?: string;
}

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
    /**
     * Cache GET / QUERY responses; successful writes invalidate them. `true`
     * uses `REDIS_URL`. `CACHE_ENABLED=false` turns caching off everywhere.
     */
    cache?: boolean | CacheOptions;
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
    /** Drops every cached response for this model. No-op when caching is off. */
    invalidateCache(): Promise<void>;
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

/** File uploads on a `createRouter` router: `POST /` and `PATCH /:id` accept multipart. */
export interface RouterUploadOptions extends Omit<UploadOptions, "uploadPath"> {
    /** Folder in the bucket. Default `'files/'`. */
    path?: string;
}

export interface RouterOptions<T extends Document = any> extends ControllerOptions<T> {
    middlewares?: any[];
    /** Mount the HTTP QUERY route on `/`. Default true. */
    enableQuery?: boolean;
    /**
     * Accept files on `POST /` and `PATCH /:id` and store them in S3. `true` uses
     * every default; an object overrides the ones it names. Off when omitted.
     */
    upload?: boolean | RouterUploadOptions;
}

/** @deprecated since 3.3.0, removed in 4.0. Use `RouterOptions` with `upload`. */
export interface RouterS3Options<T extends Document = any> extends Omit<RouterOptions<T>, "upload"> {
    path?: string;
    fields?: UploadField[];
    imgOptimizations?: ImageOptimizationLevel;
    /** Additional upload settings (ACL, mime allowlist, limits). */
    upload?: Omit<UploadOptions, "uploadPath" | "fields" | "imgOptimizations">;
}

/** An Express router that can also drop its model's cached responses. */
export type ControllerRouter = Router & { invalidateCache(): Promise<void> };

/** In-process cache store for development and tests. */
export function createMemoryCacheStore(options?: { maxEntries?: number }): CacheStore & { readonly size: number };

/** A Redis-backed store; share one across routers by passing it as `cache.store`. */
export function createRedisCacheStore(options: { url?: string; client?: unknown; logger?: Logger }): CacheStore;

/**
 * Creates an Express CRUD router for the given model. Pass `upload` to accept
 * files on `POST /` and `PATCH /:id`.
 */
export function createRouter<T extends Document = any>(options: RouterOptions<T>): ControllerRouter;

/**
 * Creates an Express router with S3 upload support for the given model.
 * @deprecated since 3.3.0, removed in 4.0. Use `createRouter({ upload: { path, fields, ... } })`.
 */
export function createRouterS3upload<T extends Document = any>(
    options: RouterS3Options<T>,
): ControllerRouter;

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

/* ==========================================================================
 * Authentication
 * ========================================================================== */

/** A login identifier with its own normalizer — trim, lowercase, strip formatting. */
export interface IdentifierField {
    field: string;
    normalize?(value: string): string;
}

/** A login identifier: a field name, or a field with its own normalizer. */
export type IdentifierSpec = string | IdentifierField;

/**
 * Declares an identifier with its own normalizer.
 *
 * A plain object works identically; this exists because TypeScript cannot infer
 * the callback's parameter inside an array whose element type is a union.
 */
export function identifier(
    field: string,
    normalize?: (value: string) => string,
): IdentifierField;

/** Field names on *your* user model. Nothing here is a schema this library owns. */
export interface AuthFieldMap {
    /** Where the password hash lives. Default `"password"`. */
    password?: string;
    /** Where the role lives. Default `"role"`. */
    role?: string;
    otpHash?: string;
    otpPurpose?: string;
    otpExpiresAt?: string;
    otpAttempts?: string;
    failedLogins?: string;
    lockedUntil?: string;
    passwordChangedAt?: string;
    /** Array of sessions, used only with refresh tokens. Default `"refreshTokens"`. */
    refreshTokens?: string;
    /** A boolean field that blocks sign-in when true. Unset by default. */
    disabled?: string | null;
}

export interface TokenOptions {
    /** HMAC secret, at least 32 characters. Required. */
    secret: string;
    /** `"15m"`, `"7d"`, or seconds. Default `"15m"`. */
    expiresIn?: string | number;
    issuer?: string;
    audience?: string;
    /** End sessions issued before a password change. Default true. */
    invalidateOnPasswordChange?: boolean;
}

export interface OtpOptions {
    /** Digits in a code. Default 6. */
    length?: number;
    /** How long a code stays valid. Default 600. */
    ttlSeconds?: number;
    /** Guesses allowed before the code is dead. Default 5. */
    maxAttempts?: number;
    /**
     * Sends the code yourself, bypassing `mail` and `sms` entirely. Kept for
     * compatibility; prefer `mail.sender` / `sms.sender` and templates.
     */
    deliver?: (payload: {
        user: Record<string, any>;
        code: string;
        channel: "email" | "sms";
        req: Request;
    }) => void | Promise<void>;
}

/** Every value falls back to the environment, then the default shown. */
export interface RefreshOptions {
    /** Mount `/token/refresh`, `/logout`, `/logout/all`. Env `AUTH_REFRESH_ENABLED`, default false. */
    enabled?: boolean;
    /** Issue a new refresh token on every refresh. Env `AUTH_REFRESH_ROTATE`, default true. */
    rotate?: boolean;
    /** `"30d"` or seconds. Env `AUTH_REFRESH_EXPIRES_IN`, default `"30d"`. */
    expiresIn?: string | number;
    /** How long a just-rotated token is still accepted, for racing clients. Default 10. */
    graceSeconds?: number;
    /** On replay of a rotated-away token, end every session rather than one. Default true. */
    revokeAllOnReuse?: boolean;
    /** Sessions kept per user; the oldest is dropped. Default 5. */
    maxSessions?: number;
}

/** What a template sees. `user` is the public user — no secret fields. */
export interface TemplateContext {
    code: string;
    purpose: "passwordReset";
    minutes: number;
    appName: string;
    user: Record<string, any>;
}

export interface MailMessage {
    subject: string;
    text?: string;
    html?: string;
}

/** A string template may use `{{code}}`, `{{minutes}}`, `{{appName}}`, `{{user.name}}`. */
export type MailTemplate = MailMessage | ((context: TemplateContext) => MailMessage | Promise<MailMessage>);
export type SmsTemplate = string | ((context: TemplateContext) => string | Promise<string>);

export interface MailOptions {
    /** A nodemailer transporter, or anything with `sendMail({ from, to, subject, text, html })`. */
    transporter?: { sendMail: (message: Record<string, any>) => Promise<unknown> | unknown };
    /** nodemailer transport options; built lazily. Default from `SMTP_URL` or `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`. */
    transport?: string | Record<string, any>;
    /** Sender address. Default `MAIL_FROM`; required with a transporter. */
    from?: string;
    /** Replaces the transporter entirely — Resend, SES, Postmark, a queue. */
    sender?: (message: MailMessage & {
        to: string;
        user: Record<string, any>;
        purpose: string;
        code: string;
        req: Request;
    }) => void | Promise<void>;
    /** Field holding the address. Default `"email"`. */
    toField?: string;
    templates?: { passwordReset?: MailTemplate };
}

export interface SmsOptions {
    /** Required to send by SMS: there is no default provider. */
    sender?: (message: {
        to: string;
        text: string;
        user: Record<string, any>;
        purpose: string;
        code: string;
        req: Request;
    }) => void | Promise<void>;
    /** Field holding the number. Default `"phone"`. */
    toField?: string;
    templates?: { passwordReset?: SmsTemplate };
}

export declare const DEFAULT_TEMPLATES: {
    readonly mail: { readonly passwordReset: MailMessage };
    readonly sms: { readonly passwordReset: string };
};

export interface RoleOptions {
    /** Field holding the role. Default `"role"`. */
    field?: string;
    /** Roles that may be assigned. Unset means any string. */
    list?: string[];
    /** Role given at registration. Default the first of `list`, else `"user"`. */
    default?: string;
    /** Roles treated as administrators. Default `["admin"]`. */
    admin?: string | string[];
    /** True when the role field is an array. Default false. */
    multiple?: boolean;
}

/** What a provider returns once it has verified a credential. */
export interface SocialProfile {
    id: string;
    email?: string | null;
    name?: string | null;
    picture?: string | null;
    raw?: unknown;
}

export interface SocialProvider {
    /** Field on your model holding this provider's account id. Default `<name>Id`. */
    idField?: string;
    /** Replaces the built-in verification entirely. */
    verify?: (credential: Record<string, any>, settings: any) => Promise<SocialProfile>;
    [setting: string]: any;
}

/** The endpoints a `createAuthRouter` can mount. */
export type AuthRouteName =
    | "register"
    | "login"
    | "social"
    | "forgotPassword"
    | "resetPassword"
    | "changePassword"
    | "refresh"
    | "logout"
    | "logoutAll"
    | "me"
    | "listUsers"
    | "getUser"
    | "updateUser"
    | "modifyRoles";

/** Who may reach a route, decided when it is mounted. */
export type AuthAccess = "public" | "authenticated" | "admin";

export interface AuthUrl {
    name: AuthRouteName;
    method: string;
    path: string;
    access: AuthAccess;
}

/**
 * Per-route middleware. An array applies to every endpoint, as `middlewares`
 * does on `createRouter`; an object targets them by name, which is how a rate
 * limiter goes on `login` without throttling `me`.
 */
export type AuthMiddlewares =
    | RequestHandler[]
    | ({ all?: RequestHandler[] } & Partial<Record<AuthRouteName, RequestHandler[]>>);

export interface AuthOptions<T extends Document = any> {
    model: Model<T>;
    /** Rename a route, or leave it unmounted with `false`. */
    routes?: Partial<Record<AuthRouteName, string | false>>;
    /** Middleware for every route, or per route by name. */
    middlewares?: AuthMiddlewares;
    /** Fields a client may sign in with. Default `["email"]`. */
    identifiers?: IdentifierSpec[] | IdentifierSpec;
    fields?: AuthFieldMap;
    token: TokenOptions;
    password?: {
        /** Minimum length accepted. Default 8. */
        minLength?: number;
        /** Replace scrypt with bcrypt, argon2 or anything else. */
        hash?: (plain: string) => Promise<string> | string;
        verify?: (plain: string, stored: string) => Promise<boolean> | boolean;
    };
    otp?: OtpOptions;
    /** Shown in the default templates as `{{appName}}`. Default `APP_NAME`. */
    appName?: string;
    /** Sending codes by email. */
    mail?: MailOptions;
    /** Sending codes by SMS. */
    sms?: SmsOptions;
    /** Refresh tokens and sign-out. Off unless enabled here or via `AUTH_REFRESH_ENABLED`. */
    refresh?: RefreshOptions;
    /** Failed sign-ins before the account locks. Default 10 attempts, 900s. */
    lockout?: { maxAttempts?: number; lockSeconds?: number };
    roles?: RoleOptions;
    /** Providers to enable, keyed by name: `google`, `apple`, `facebook`, `github`. */
    social?: Record<string, SocialProvider>;
    /** Fields a client may set at registration, beyond its identifiers. */
    registerFields?: string[];
    /** Fields a client may change on itself. */
    updateFields?: string[];
    onRegister?: (user: T, req: Request) => void | Promise<void>;
    /** Last word on whether a sign-in proceeds. Throw an `HttpError` to refuse. */
    onLogin?: (user: T, req: Request) => void | Promise<void>;
    logger?: Logger;
    /** Caps for `GET /users`, as in `ControllerOptions`. */
    maxLimit?: number;
    defaultPageSize?: number;
    maxTimeMS?: number;
    countStrategy?: CountStrategy;
    lean?: boolean;
}

/** What `requireAuth` puts on the request. */
export interface AuthContext {
    userId: string;
    role?: string | string[];
    claims: Record<string, any>;
}

declare global {
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}

/**
 * An auth router, with its guards attached so your own routes can reuse them
 * without rebuilding the configuration.
 */
export interface AuthRouter extends Router {
    /** Verifies the bearer token and populates `req.auth`. */
    requireAuth: RequestHandler;
    /** Gates a route on a role. Mount after `requireAuth`. */
    requireRole(...roles: (string | string[])[]): RequestHandler;
    /** The resolved configuration, for anything wired by hand. */
    config: any;
    /** What was actually mounted, in order. */
    urls: readonly AuthUrl[];
}

/** Every endpoint `createAuthRouter` knows how to mount, with its default URL. */
export const AUTH_ROUTES: readonly AuthUrl[];

/**
 * Register, login, social sign-in, password change and reset by one-time code,
 * user listing and role management — mounted as one router.
 */
export function createAuthRouter<T extends Document = any>(
    options: AuthOptions<T>,
): AuthRouter;

/** Verifies the bearer token and populates `req.auth`. */
export function requireAuth<T extends Document = any>(
    config: ReturnType<typeof buildAuthConfig>,
    options?: { loadUser?: boolean },
): RequestHandler;

/** Gates a route on a role. Mount after `requireAuth`. */
export function requireRole(...roles: (string | string[])[]): RequestHandler;

/** Resolves raw options into the frozen auth config the middleware needs. */
export function buildAuthConfig<T extends Document = any>(options: AuthOptions<T>): any;

export function hashPassword(plain: string): Promise<string>;
export function verifyPassword(plain: string, stored: string): Promise<boolean>;

export function signToken(
    claims: Record<string, any>,
    options: TokenOptions & { secret: string },
): string;
export function verifyToken(
    token: string,
    options: { secret: string; issuer?: string; audience?: string; clockToleranceSeconds?: number },
): Record<string, any>;

/** The built-in provider verifiers, for wrapping or reuse. */
export const BUILT_IN_PROVIDERS: Record<string, SocialProvider>;
