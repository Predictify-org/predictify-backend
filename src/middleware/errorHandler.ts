import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger";

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
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: "validation_error", details: err.issues },
    });
    return;
  }

  const typed = err as { status?: number; code?: string };
  const status = typed.status ?? 500;

  if (status >= 500 || status < 400) {
    logger.error({ err, path: req.path, method: req.method }, "request_failed");
    res.status(500).json({ error: { code: "internal_error" } });
    return;
  }

  logger.warn({ err, path: req.path, method: req.method, status }, "request_failed");
  res.status(status).json({
    error: { code: typed.code ?? "request_failed" },
  });
}
