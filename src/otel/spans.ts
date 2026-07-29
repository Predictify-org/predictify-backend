/**
 * @module otel/spans
 *
 * Convenience helpers for creating and ending OpenTelemetry spans on
 * audit-related route handlers.
 *
 * Usage (typical handler pattern)
 * -----
 *
 *   import { startAuditSpan, endAuditSpan, recordErrorOnSpan } from "../otel/spans";
 *   import { getRequestId } from "../lib/requestContext";
 *
 *   router.get("/", async (req, res, next) => {
 *     const span = startAuditSpan("audit.list", req, res);
 *     try {
 *       // … handler logic …
 *       endAuditSpan(span, res);
 *     } catch (err) {
 *       recordErrorOnSpan(span, err);
 *       next(err);
 *     }
 *   });
 *
 * For streaming endpoints (export) the span must be ended when the stream
 * finishes, not when the handler returns.  See admin/audit/export.ts for
 * the event-based pattern.
 */

import type { Request, Response } from "express";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { getTracer } from "./tracer";
import { getRequestId } from "../lib/requestContext";

// ---------------------------------------------------------------------------
// Span lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new span for an audit endpoint and populates its initial
 * attributes (method, path, correlationId).
 *
 * The span kind is set to `SERVER` because these spans represent server-side
 * handling of a synchronous HTTP request.
 *
 * @param spanName - Short, dot-separated name e.g. `"audit.market.list"`
 * @param req       - Express request object (used for method + path)
 * @param res       - Express response object (used for correlationId via locals)
 * @param extraAttrs - Optional extra attributes to set immediately
 * @returns The started span
 */
export function startAuditSpan(
  spanName: string,
  req: Request,
  res: Response,
  extraAttrs?: Record<string, string | undefined>,
): Span {
  const tracer = getTracer();
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.SERVER,
    attributes: {
      "http.method": req.method,
      "http.path": req.path,
      "correlation.id": res.locals.correlationId ?? getRequestId() ?? "unknown",
      ...(extraAttrs ?? {}),
    },
  });

  return span;
}

/**
 * Ends a span after a successful (or non-exceptional) response.
 *
 * Sets the `http.status_code` attribute and marks the span status as
 * `ERROR` if the status code is >= 400.
 *
 * @param span - The span to end
 * @param res  - Express response object (statusCode is read)
 */
export function endAuditSpan(span: Span, res: Response): void {
  const statusCode = res.statusCode;

  span.setAttribute("http.status_code", statusCode);

  if (statusCode >= 400) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `HTTP ${statusCode}`,
    });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }

  span.end();
}

/**
 * Records an exception on a span and sets its status to ERROR.
 *
 * Call this from `catch` blocks **instead of** `endAuditSpan`, then
 * forward the error to Express's error handler via `next(err)`.
 *
 * @param span - The span to record the error on (will NOT be ended here
 *               — the caller's `finally` or `next(err)` path is expected
 *               to end it; for synchronous handlers, call `endAuditSpan`
 *               in an outer `finally`, or call `span.end()` after this)
 * @param err  - The thrown error or rejection reason
 */
export function recordErrorOnSpan(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : new Error(String(err)));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
}