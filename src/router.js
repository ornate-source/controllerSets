import http from "node:http";
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

export const createRouter = (options = {}) => {
    const { middlewares = [], enableQuery = true } = options;

    const router = express.Router();
    if (middlewares.length > 0) {
        router.use(middlewares);
    }

    const controller = new ControllerSets(controllerOptionsFrom(options));

    router.get("/", controller.getAll);
    if (enableQuery) registerQueryRoute(router, controller, options.logger);
    router.post("/", controller.create);
    router.get("/:id", controller.get);
    router.patch("/:id", controller.update);
    router.delete("/:id", controller.delete);

    router.invalidateCache = controller.invalidateCache;
    return router;
};

export const createRouterS3upload = (options = {}) => {
    const {
        middlewares = [],
        path = "files/",
        fields = [{ name: "file", maxCount: 1 }],
        imgOptimizations = undefined,
        upload = {},
        enableQuery = true,
    } = options;

    const router = express.Router();
    if (middlewares.length > 0) {
        router.use(middlewares);
    }

    const controller = new ControllerSets(controllerOptionsFrom(options));

    const uploadOptions = { ...upload, uploadPath: path, fields, imgOptimizations };
    const uploadMiddleware = (req, res, next) =>
        fileUploadMiddleware(req, res, next, uploadOptions);

    router.get("/", controller.getAll);
    // QUERY is a read, so it never runs the upload middleware.
    if (enableQuery) registerQueryRoute(router, controller, options.logger);
    router.post("/", uploadMiddleware, controller.create);
    router.get("/:id", controller.get);
    router.patch("/:id", uploadMiddleware, controller.update);
    router.delete("/:id", controller.delete);

    router.invalidateCache = controller.invalidateCache;
    return router;
};
