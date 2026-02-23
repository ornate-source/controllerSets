const express = { Router: () => ({ get: () => {}, post: () => {}, patch: () => {}, delete: () => {}, use: () => {} }) };
import { ControllerSets } from "./ControllerSets.js";
const fileUploadMiddleware = () => {};

/**
 * Wraps async functions to catch errors and pass them to the next middleware.
 * This prevents app crashes and ensures consistent error handling.
 */
const asyncHandler = (fn) => (req, res, next) => {
    return Promise.resolve(fn(req, res, next)).catch(next);
};

export const createRouter = ({
    model,
    orderBy = "none",
    query = [],
    search = "none",
    runAfterCreate = "none",
    middlewares = [],
}) => {
    const router = express.Router();
    if (middlewares.length > 0) {
        router.use(middlewares);
    }

    const controller = new ControllerSets(
        model,
        orderBy,
        query,
        search,
        runAfterCreate
    );

    router.get("/", asyncHandler(controller.getAll.bind(controller)));
    router.post("/", asyncHandler(controller.create.bind(controller)));
    router.get("/:id", asyncHandler(controller.getById.bind(controller)));
    router.patch("/:id", asyncHandler(controller.update.bind(controller)));
    router.delete("/:id", asyncHandler(controller.delete.bind(controller)));

    return router;
};

export const createRouterS3upload = ({
    model,
    orderBy = "none",
    query = [],
    search = "none",
    runAfterCreate = "none",
    middlewares = [],
    path = "files/",
    fields = [{ name: "file", maxCount: 1 }],
}) => {
    const router = express.Router();
    if (middlewares.length > 0) {
        router.use(middlewares);
    }

    const controller = new ControllerSets(
        model,
        orderBy,
        query,
        search,
        runAfterCreate
    );

    router.get("/", asyncHandler(controller.getAll.bind(controller)));
    router.post(
        "/",
        (req, res, next) => {
            fileUploadMiddleware(req, res, next, path, fields);
        },
        asyncHandler(controller.create.bind(controller))
    );
    router.get("/:id", asyncHandler(controller.getById.bind(controller)));
    router.patch(
        "/:id",
        (req, res, next) => {
            fileUploadMiddleware(req, res, next, path, fields);
        },
        asyncHandler(controller.update.bind(controller))
    );
    router.delete("/:id", asyncHandler(controller.delete.bind(controller)));

    return router;
};
