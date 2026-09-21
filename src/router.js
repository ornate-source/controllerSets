import http from "node:http";
import express from "express";
import { ControllerSets } from "./ControllerSets.js";
import { fileUploadMiddleware } from "./s3upload.js";

/**
 * Options consumed by the router itself rather than forwarded to the controller.
 * Everything else is passed through, so new controller options do not require a
 * corresponding change here.
 */
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
 * Whether this runtime can serve the HTTP QUERY method.
 *
 * Two things have to be true: Node's HTTP parser must recognise the method at all
 * (it rejects an unknown one before Express is reached), and this Express build's
 * router must expose a matching verb — Express derives its verb list from
 * `http.METHODS` at load time, so an older Node yields a router without `.query`.
 */
export const isQueryMethodSupported = () =>
    http.METHODS.includes("QUERY") && typeof express.Router().query === "function";

/** Logged once per process: a missing QUERY route is otherwise just a silent 404. */
let queryUnsupportedWarned = false;

const registerQueryRoute = (router, controller, logger) => {
    if (isQueryMethodSupported()) {
        // RFC 10008 §4: advertise the accepted query format. Passing through to
        // Express's own OPTIONS responder keeps the generated `Allow` header,
        // which now lists QUERY alongside the rest.
        router.options("/", (req, res, next) => {
            res.setHeader("Accept-Query", "application/json");
            next();
        });
        router.query("/", controller.queryAll);
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
    router.get("/:id", controller.getById);
    router.patch("/:id", controller.update);
    router.delete("/:id", controller.delete);

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
    router.get("/:id", controller.getById);
    router.patch("/:id", uploadMiddleware, controller.update);
    router.delete("/:id", controller.delete);

    return router;
};
