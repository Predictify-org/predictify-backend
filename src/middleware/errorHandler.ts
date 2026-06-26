import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger";
import { AppError, ErrorCodes } from "../errors";

function getRequestId(req: Request): string {
  const id = (req as { id?: unknown }).id;
  if (id == null) return "";
  return String(id);
}

/*
 * Status → error code mapping:
 *   ZodError        → 400  validation_error  (details array surfaces field paths)
 *   err.status=400  → 400  request_failed    (generic bad request)
 *   err.status=404  → 404  not_found
 *   err.status=409  → 409  conflict
 *   err.status=422  → 422  unprocessable
 *   other 4xx       → 4xx  request_failed
 *   5xx / unknown   → 500  internal_error    (internals never leaked)
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = getRequestId(req);

  if (err instanceof AppError) {
    logger.warn({ err, requestId, path: req.path, method: req.method }, err.message);
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
        requestId,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    logger.warn({ err, requestId, path: req.path, method: req.method }, "validation_error");
    res.status(400).json({
      error: {
        code: ErrorCodes.VALIDATION_ERROR,
        message: "Validation failed",
        details: err.issues,
        requestId,
      },
    });
    return;
  }

  logger.error({ err, requestId, path: req.path, method: req.method }, "unhandled_error");
  res.status(500).json({
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: "Internal error",
      requestId,
    },
  });
}
