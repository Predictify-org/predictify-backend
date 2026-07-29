import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { OptionsJson } from "body-parser";
import { logger } from "../config/logger";
import { AppError, ErrorCodes } from "../errors";
import { getRequestId } from "../lib/requestContext";

export const DEFAULT_BODY_LIMIT = "256kb";
export const WEBHOOK_BODY_LIMIT = "1mb";

export interface BodySizeLimitOptions {
  limit?: OptionsJson["limit"];
  routeName?: string;
}

function normalizeLimit(limit?: OptionsJson["limit"]): OptionsJson["limit"] {
  return limit ?? DEFAULT_BODY_LIMIT;
}

function isPayloadTooLargeError(err: unknown): err is Error & {
  status?: number;
  type?: string;
  limit?: number | string;
  length?: number;
  expected?: number;
} {
  return (
    typeof err === "object" &&
    err !== null &&
    (("status" in err && (err as { status?: unknown }).status === 413) ||
      ("type" in err && (err as { type?: unknown }).type === "entity.too.large"))
  );
}

export function createBodySizeLimitMiddleware(
  options: BodySizeLimitOptions = {},
): Array<RequestHandler | ErrorRequestHandler> {
  const limit = normalizeLimit(options.limit);
  const parser = express.json({ limit });

  const payloadTooLargeHandler: ErrorRequestHandler = (
    err: unknown,
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    if (!isPayloadTooLargeError(err)) {
      next(err);
      return;
    }

    const requestId =
      getRequestId() ??
      (typeof (req as { id?: unknown }).id === "string"
        ? (req as { id: string }).id
        : undefined);
    logger.warn(
      {
        requestId,
        correlationId: req.headers["x-correlation-id"] ?? requestId,
        path: req.path,
        method: req.method,
        routeName: options.routeName,
        limit: err.limit,
        length: err.length ?? err.expected,
      },
      "request_body_too_large",
    );

    next(
      new AppError(ErrorCodes.REQUEST_FAILED, "Request body too large", 413, {
        limit: err.limit,
        length: err.length ?? err.expected,
      }),
    );
  };

  return [parser, payloadTooLargeHandler];
}

export const defaultBodySizeLimitMiddleware = createBodySizeLimitMiddleware({
  routeName: "default",
});
export const webhookBodySizeLimitMiddleware = createBodySizeLimitMiddleware({
  limit: WEBHOOK_BODY_LIMIT,
  routeName: "admin-webhooks",
});
