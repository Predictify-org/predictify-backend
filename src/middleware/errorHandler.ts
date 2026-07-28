import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { randomUUID } from "crypto";
import { logger } from "../config/logger";
import { AppError, ErrorCodes, isRouteError, HTTP_STATUS, toErrorEnvelope } from "../errors";
import { getRequestId } from "../lib/requestContext";

function requestIdFrom(req: Request, fallback: string): string {
  return (
    getRequestId() ??
    (typeof (req as { id?: unknown }).id === "string" ? (req as { id?: string }).id : undefined) ??
    fallback
  );
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const correlationId =
    (req.headers["x-correlation-id"] as string) ??
    (typeof (req as { id?: unknown }).id === "string" ? (req as { id?: string }).id : undefined) ??
    randomUUID();
  const reqId = requestIdFrom(req, correlationId);

  if (isRouteError(err)) {
    const status = HTTP_STATUS[err.kind];
    const logPayload: Record<string, unknown> = {
      correlationId,
      requestId: reqId,
      kind: err.kind,
      path: req.path,
      method: req.method,
    };
    if (err.kind === "InternalError" && err.cause) {
      logPayload.cause = err.cause;
    }
    logger.error(logPayload, "route_error");
    const envelope = toErrorEnvelope(err, correlationId);
    res.status(status).json({ error: envelope });
    return;
  }

  if (err instanceof AppError) {
    logger.error(
      { err, path: req.path, method: req.method, correlationId, requestId: reqId },
      "app_error",
    );
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
        correlationId,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    logger.warn(
      { err, path: req.path, method: req.method, correlationId, requestId: reqId },
      "validation_error",
    );
    res.status(400).json({
      error: {
        code: ErrorCodes.VALIDATION_ERROR,
        message: "Validation failed",
        details: err.issues,
        correlationId,
      },
    });
    return;
  }

  logger.error({ err, path: req.path, method: req.method, requestId: reqId }, "unknown_error");
  res.status(500).json({
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: "Internal error",
      correlationId,
    },
  });
}
