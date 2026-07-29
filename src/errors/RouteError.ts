import { getRequestId } from "../lib/requestContext";
import { ErrorCodes } from "./codes";

export interface ErrorEnvelope {
  code: string;
  message: string;
  correlationId: string;
  details?: Record<string, unknown>;
  fields?: Record<string, string[]>;
}

export type RouteError =
  | {
      kind: "NotFound";
      message: string;
      resource?: string;
    }
  | {
      kind: "Unauthorized";
      message: string;
    }
  | {
      kind: "Forbidden";
      message: string;
      reason?: string;
    }
  | {
      kind: "ValidationError";
      message: string;
      fields?: Record<string, string[]>;
    }
  | {
      kind: "Conflict";
      message: string;
      resource?: string;
    }
  | {
      kind: "InternalError";
      message: string;
      cause?: unknown;
    }
  | {
      kind: "BadRequest";
      message: string;
      detail?: string;
    };

export const HTTP_STATUS: Record<RouteError["kind"], number> = {
  NotFound: 404,
  Unauthorized: 401,
  Forbidden: 403,
  ValidationError: 422,
  Conflict: 409,
  InternalError: 500,
  BadRequest: 400,
};

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: RouteError };

export const ok = <T>(value: T): Result<T> => ({
  ok: true,
  value,
});

export const err = (error: RouteError): Result<never> => ({
  ok: false,
  error,
});

export function isRouteError(e: unknown): e is RouteError {
  return typeof e === "object" && e !== null && "kind" in e;
}

export const RouteErrorFactory = {
  notFound(message: string, resource?: string): RouteError {
    return { kind: "NotFound", message, resource };
  },

  unauthorized(message = "Authentication required"): RouteError {
    return { kind: "Unauthorized", message };
  },

  forbidden(message: string, reason?: string): RouteError {
    return { kind: "Forbidden", message, reason };
  },

  validation(message: string, fields?: Record<string, string[]>): RouteError {
    return { kind: "ValidationError", message, fields };
  },

  conflict(message: string, resource?: string): RouteError {
    return { kind: "Conflict", message, resource };
  },

  internal(message: string, cause?: unknown): RouteError {
    return { kind: "InternalError", message, cause };
  },

  badRequest(message: string, detail?: string): RouteError {
    return { kind: "BadRequest", message, detail };
  },
};

const KIND_TO_CODE: Record<RouteError["kind"], string> = {
  NotFound: ErrorCodes.NOT_FOUND,
  Unauthorized: ErrorCodes.UNAUTHORIZED,
  Forbidden: ErrorCodes.FORBIDDEN,
  ValidationError: ErrorCodes.VALIDATION_ERROR,
  Conflict: ErrorCodes.CONFLICT,
  InternalError: ErrorCodes.INTERNAL_ERROR,
  BadRequest: ErrorCodes.REQUEST_FAILED,
};

export function toErrorEnvelope(error: RouteError, correlationId?: string): ErrorEnvelope {
  const cid = correlationId ?? getRequestId() ?? "unknown";
  const envelope: ErrorEnvelope = {
    code: KIND_TO_CODE[error.kind],
    message: error.kind === "InternalError" ? "An unexpected error occurred" : error.message,
    correlationId: cid,
  };
  if (error.kind === "ValidationError" && error.fields) {
    envelope.fields = error.fields;
  }
  return envelope;
}
