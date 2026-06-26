import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

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
  // getRequestId() works here because the ALS middleware ran before us.
  // Fall back to req.id (set by pinoHttp) in the unlikely event the store is
  // not populated (e.g. the error was thrown before the ALS middleware ran).
  const requestId = getRequestId() ?? (req.id as string | undefined);

  logger.error(
    { err, path: req.path, method: req.method, reqId: requestId },
    "request_failed",
  );

  const status = (err as { status?: number }).status ?? 500;

  res.status(status).json({
    error: {
      code: status === 500 ? "internal_error" : "request_failed",
      // Expose the request ID so clients can quote it when reporting issues.
      requestId,
    },
  });
}
