import http from "node:http";
import { deprecate } from "node:util";
import express from "express";
import { ControllerSets } from "./ControllerSets.js";
import { fileUploadMiddleware } from "./s3upload.js";

// Consumed by the router; everything else is forwarded to the controller.
const ROUTER_ONLY_OPTIONS = [
    "middlewares",
    "path",
    "fields",
    "imgOptimizations",
    "upload",
    "enableQuery",
];

// The 3.x `createRouterS3upload` took these at the top level; `createRouter` reads
// them from `upload`.
const LEGACY_UPLOAD_OPTIONS = ["path", "fields", "imgOptimizations"];

const controllerOptionsFrom = (options) =>
    Object.fromEntries(
        Object.entries(options).filter(([key]) => !ROUTER_ONLY_OPTIONS.includes(key)),
    );

/**
 * Whether this runtime can serve HTTP QUERY: Node's parser must recognise the
 * method, and this Express build's router must expose the verb.
 */
export const isQueryMethodSupported = () =>
    http.METHODS.includes("QUERY") && typeof express.Router().query === "function";

// Warned once per process: a missing QUERY route is otherwise a silent 404.
let queryUnsupportedWarned = false;

const registerQueryRoute = (router, controller, logger) => {
    if (isQueryMethodSupported()) {
        // RFC 10008 §4. Passing through keeps Express's generated `Allow` header.
        router.options("/", (req, res, next) => {
            res.setHeader("Accept-Query", "application/json");
            next();
        });
        router.query("/", controller.query);
        return true;
    }

    if (!queryUnsupportedWarned) {
        queryUnsupportedWarned = true;
        (logger ?? console).warn(
            `[ControllerSets] The HTTP QUERY route was not mounted: this runtime ` +
                `(Node ${process.versions.node}) does not recognise the QUERY method. ` +
                `Node 22.2+ is required, or pass 'enableQuery: false' to silence this.`,
        );
    }
    return false;
};

let strayUploadOptionsWarned = false;

/**
 * Resolves the `upload` option to `fileUploadMiddleware` options, or null when
 * the router takes no files. `true` means every default; an object turns uploads
 * on and overrides the defaults it names.
 */
const uploadOptionsFrom = (options) => {
    const { upload } = options;

    const stray = LEGACY_UPLOAD_OPTIONS.filter((key) => options[key] !== undefined);
    if (stray.length > 0 && !strayUploadOptionsWarned) {
        strayUploadOptionsWarned = true;
        (options.logger ?? console).warn(
            `[ControllerSets] createRouter ignores top-level ${stray.map((k) => `'${k}'`).join(", ")}. ` +
                `Move ${stray.length > 1 ? "them" : "it"} into 'upload', e.g. ` +
                `upload: { ${stray[0]}: ... }.`,
        );
    }

    if (upload === undefined || upload === false || upload === null) return null;
    if (upload === true) return {};
    if (typeof upload !== "object" || Array.isArray(upload)) {
        throw new TypeError(
            "createRouter: 'upload' must be true or an options object.",
        );
    }

    const { path, ...rest } = upload;
    return path === undefined ? rest : { ...rest, uploadPath: path };
};

export const createRouter = (options = {}) => {
    const { middlewares = [], enableQuery = true } = options;

    const router = express.Router();
    if (middlewares.length > 0) {
        router.use(middlewares);
    }

    const controller = new ControllerSets(controllerOptionsFrom(options));

    const uploadOptions = uploadOptionsFrom(options);
    // Only writes take files; reads, QUERY included, never run the upload middleware.
    const writeMiddleware = uploadOptions
        ? [(req, res, next) => fileUploadMiddleware(req, res, next, uploadOptions)]
        : [];

    router.get("/", controller.getAll);
    if (enableQuery) registerQueryRoute(router, controller, options.logger);
    router.post("/", ...writeMiddleware, controller.create);
    router.get("/:id", controller.get);
    router.patch("/:id", ...writeMiddleware, controller.update);
    router.delete("/:id", controller.delete);

    router.invalidateCache = controller.invalidateCache;
    return router;
};

/**
 * @deprecated since 3.3.0, removed in 4.0. Use `createRouter({ upload: { ... } })`.
 */
export const createRouterS3upload = deprecate(
    (options = {}) => {
        const { path, fields, imgOptimizations, upload = {}, ...rest } = options;
        return createRouter({
            ...rest,
            upload: {
                ...upload,
                ...(path !== undefined && { path }),
                ...(fields !== undefined && { fields }),
                ...(imgOptimizations !== undefined && { imgOptimizations }),
            },
        });
    },
    "createRouterS3upload() is deprecated and will be removed in express-controller-sets 4.0. " +
        "Use createRouter({ upload: { path, fields, imgOptimizations, ... } }) instead.",
    "ECS_DEP001",
);
