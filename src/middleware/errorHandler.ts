import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

function requestIdFrom(req: Request): string {
  return getRequestId() ?? (typeof req.id === "string" ? req.id : "");
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  logger.error(
    { err, path: req.path, method: req.method, requestId: requestIdFrom(req) },
    "request_failed",
  );

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "validation_error",
        details: err.issues,
        requestId: requestIdFrom(req),
      },
    });
  }

  const status =
    typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
  const code =
    typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : status === 500
        ? "internal_error"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : "request_failed";

  return res.status(status).json({
    error: {
      code,
      requestId: requestIdFrom(req),
    },
  });
}
