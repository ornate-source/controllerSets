import express from "express";
import { ControllerSets } from "./ControllerSets.js";
import { fileUploadMiddleware } from "./s3upload.js";

/**
 * Options consumed by the router itself rather than forwarded to the controller.
 * Everything else is passed through, so new controller options do not require a
 * corresponding change here.
 */
const ROUTER_ONLY_OPTIONS = ["middlewares", "path", "fields", "imgOptimizations", "upload"];

const controllerOptionsFrom = (options) =>
    Object.fromEntries(
        Object.entries(options).filter(([key]) => !ROUTER_ONLY_OPTIONS.includes(key)),
    );

export const createRouter = (options = {}) => {
    const { middlewares = [] } = options;

    const router = express.Router();
    if (middlewares.length > 0) {
        router.use(middlewares);
    }

    const controller = new ControllerSets(controllerOptionsFrom(options));

    router.get("/", controller.getAll);
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
    router.post("/", uploadMiddleware, controller.create);
    router.get("/:id", controller.getById);
    router.patch("/:id", uploadMiddleware, controller.update);
    router.delete("/:id", controller.delete);

    return router;
};
