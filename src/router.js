import express from "express";
import { ControllerSets } from "./ControllerSets.js";
import { fileUploadMiddleware } from "./s3upload.js";


export const createRouter = ({
    model,
    orderBy = "none",
    query = [],
    search = [],
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

    router.get("/", controller.getAll);
    router.post("/", controller.create);
    router.get("/:id", controller.getById);
    router.patch("/:id", controller.update);
    router.delete("/:id", controller.delete);

    return router;
};

export const createRouterS3upload = ({
    model,
    orderBy = "none",
    query = [],
    search = [],
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

    router.get("/", controller.getAll);
    router.post(
        "/",
        (req, res, next) => {
            fileUploadMiddleware(req, res, next, path, fields);
        },
        controller.create
    );
    router.get("/:id", controller.getById);
    router.patch(
        "/:id",
        (req, res, next) => {
            fileUploadMiddleware(req, res, next, path, fields);
        },
        controller.update
    );
    router.delete("/:id", controller.delete);

    return router;
};
