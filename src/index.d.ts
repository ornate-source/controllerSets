import { Request, Response, NextFunction, Router } from "express";
import { Model, Document } from "mongoose";

/**
 * ControllerSets - Professional Express logic for Mongoose CRUD.
 */
export class ControllerSets<T extends Document = any> {
    constructor(
        model: Model<T>,
        orderBy?: string,
        query?: string[],
        search?: string,
        runAfterCreate?: ((result: T) => void | Promise<void>) | string
    );

    getAll(req: Request, res: Response): Promise<Response | void>;
    getById(req: Request, res: Response): Promise<Response | void>;
    create(req: Request, res: Response): Promise<Response | void>;
    update(req: Request, res: Response): Promise<Response | void>;
    delete(req: Request, res: Response): Promise<Response | void>;
}

export interface RouterOptions<T extends Document = any> {
    model: Model<T>;
    orderBy?: string;
    query?: string[];
    search?: string;
    runAfterCreate?: ((result: T) => void | Promise<void>) | string;
    middlewares?: any[];
}

export interface RouterS3Options<T extends Document = any> extends RouterOptions<T> {
    path?: string;
    fields?: { name: string; maxCount: number }[];
}

/**
 * Creates a standard Express router for the given model.
 */
export function createRouter<T extends Document = any>(options: RouterOptions<T>): Router;

/**
 * Creates an Express router with S3 upload support for the given model.
 */
export function createRouterS3upload<T extends Document = any>(options: RouterS3Options<T>): Router;

/**
 * Modern S3 File Upload Middleware.
 */
export function fileUploadMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
    uploadPath?: string,
    fields?: { name: string; maxCount: number }[]
): void;
