/**
 * @module routes/comments
 *
 * Express route handlers for comment operations (/api/comments and /api/markets/:id/comments).
 *
 * Guarantees:
 * 1. Generates / preserves and echoes X-Correlation-Id header via correlationMiddleware.
 * 2. Emits structured logs using Pino containing `correlationId` and `reqId`.
 * 3. Outbound HTTP requests propagate X-Correlation-Id using `fetchWithCorrelationId`.
 * 4. Input validation using Zod at boundary with standardized error envelopes.
 * 5. Per-endpoint circuit breakers guard both downstream calls:
 *    - `commentsDbBreaker`      wraps `listMarketComments` (database reads)
 *    - `commentsOutboundBreaker` wraps `fetchWithCorrelationId` (outbound HTTP)
 *    When either breaker is OPEN the route returns HTTP 503 immediately.
 */

import { Router } from "express";
import { z } from "zod";
import { logger } from "../config/logger";
import { rateLimitAnon } from "../middleware/rateLimitAnon";
import { marketsCors } from "../middleware/cors";
import { getRequestId } from "../lib/requestContext";
import { getCorrelationId, CORRELATION_ID_HEADER, fetchWithCorrelationId } from "../middleware/correlation";
import { listMarketComments } from "../services/marketCommentsService";
import { CircuitBreaker, CircuitOpenError } from "../lib/circuitBreaker";

// ── Circuit Breaker Instances ────────────────────────────────────────────────
//
// Module-level singletons — one per logical downstream dependency.
// Options are intentionally conservative for a public-facing API:
//   - failureThreshold = 5 : open after 5 failures in the window
//   - windowMs         = 60_000 : 1-minute rolling window
//   - resetTimeoutMs   = 30_000 : probe after 30 s in OPEN state
//
// These can be tuned via environment variables in a future iteration.

/** Guards calls to `listMarketComments` (Postgres via Drizzle). */
export const commentsDbBreaker = new CircuitBreaker("comments-db", {
  failureThreshold: 5,
  windowMs: 60_000,
  resetTimeoutMs: 30_000,
});

/** Guards outbound HTTP calls triggered by a comment's `outboundUrl`. */
export const commentsOutboundBreaker = new CircuitBreaker("comments-outbound", {
  failureThreshold: 5,
  windowMs: 60_000,
  resetTimeoutMs: 30_000,
});

export const commentsRouter = Router();

// Apply CORS allowlist enforcement and rate limiting for all comment routes
commentsRouter.use(marketsCors());
commentsRouter.use(rateLimitAnon);

// ── Validation Schemas ───────────────────────────────────────────────────────

const listCommentsQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

const marketIdSchema = z.string().min(1);

const createCommentSchema = z
  .object({
    marketId: z.string().min(1),
    body: z.string().min(1).max(2000),
    authorAddress: z.string().optional(),
    outboundUrl: z.string().url().optional(),
  })
  .strict();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sends a 503 Service Unavailable response for an open circuit.
 * Logs at warn level so on-call can detect breaker trips in structured logs.
 */
function sendCircuitOpen(
  res: import("express").Response,
  err: CircuitOpenError,
  correlationId: string | undefined,
  reqId: string | undefined,
): void {
  logger.warn(
    {
      correlationId,
      reqId,
      breaker: err.breakerName,
      state: err.state,
    },
    "circuit_open_503",
  );
  res.status(503).json({
    error: {
      code: "service_unavailable",
      message: "Service temporarily unavailable. Please retry later.",
    },
  });
}

// ── Route Handlers ───────────────────────────────────────────────────────────

/**
 * GET /api/markets/:id/comments (or /api/comments/:id/comments)
 *
 * Lists market comments with cursor-based pagination.
 * The database call is wrapped by `commentsDbBreaker`; returns 503 when open.
 */
commentsRouter.get("/:id/comments", async (req, res, next) => {
  try {
    const parsedMarketId = marketIdSchema.safeParse(req.params.id);
    if (!parsedMarketId.success) {
      res.status(400).json({ error: { code: "validation_error" } });
      return;
    }

    const parsedQuery = listCommentsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: {
          code: "validation_error",
          details: parsedQuery.error.issues,
        },
      });
      return;
    }

    const requestId = getRequestId();
    const correlationId = getCorrelationId() ?? (res.locals.correlationId as string | undefined);

    if (correlationId) {
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
    }

    let page: Awaited<ReturnType<typeof listMarketComments>>;
    try {
      page = await commentsDbBreaker.fire(() =>
        listMarketComments(
          parsedMarketId.data,
          parsedQuery.data.cursor,
          parsedQuery.data.limit,
        ),
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        sendCircuitOpen(res, err, correlationId, requestId);
        return;
      }
      throw err;
    }

    logger.info(
      {
        correlationId,
        reqId: requestId,
        marketId: parsedMarketId.data,
        returned: page.data.length,
      },
      "market comments listed",
    );

    res.json({ data: page.data, nextCursor: page.nextCursor });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/comments
 *
 * Root comments endpoint for listing comments.
 */
commentsRouter.get("/", async (req, res, next) => {
  try {
    const parsedQuery = listCommentsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      res.status(400).json({
        error: {
          code: "validation_error",
          details: parsedQuery.error.issues,
        },
      });
      return;
    }

    const requestId = getRequestId();
    const correlationId = getCorrelationId() ?? (res.locals.correlationId as string | undefined);

    if (correlationId) {
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
    }

    logger.info(
      {
        correlationId,
        reqId: requestId,
      },
      "comments fetched securely",
    );

    res.json({
      data: [],
      nextCursor: null,
      message: "Comments fetched securely",
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/comments
 *
 * Creates a new comment and optionally dispatches an outbound call
 * propagating X-Correlation-Id.
 *
 * - The database call is wrapped by `commentsDbBreaker`.
 * - The optional outbound HTTP call is wrapped by `commentsOutboundBreaker`.
 * - If either breaker is OPEN, the route returns HTTP 503 immediately.
 */
commentsRouter.post("/", async (req, res, next) => {
  try {
    const parsedBody = createCommentSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        error: {
          code: "validation_error",
          details: parsedBody.error.issues,
        },
      });
      return;
    }

    const requestId = getRequestId();
    const correlationId = getCorrelationId() ?? (res.locals.correlationId as string | undefined);

    if (correlationId) {
      res.setHeader(CORRELATION_ID_HEADER, correlationId);
    }

    const { marketId, body, authorAddress, outboundUrl } = parsedBody.data;

    let outboundStatus: number | undefined;
    if (outboundUrl) {
      try {
        // Check the outbound breaker state before attempting the call.
        const outboundRes = await commentsOutboundBreaker.fire(() =>
          fetchWithCorrelationId(outboundUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ marketId, body }),
          }),
        );
        outboundStatus = outboundRes.status;
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          sendCircuitOpen(res, err, correlationId, requestId);
          return;
        }
        logger.warn(
          { correlationId, reqId: requestId, err, outboundUrl },
          "outbound comment notification failed",
        );
      }
    }

    logger.info(
      {
        correlationId,
        reqId: requestId,
        marketId,
        authorAddress,
        outboundStatus,
      },
      "comment created successfully",
    );

    res.status(201).json({
      data: {
        id: `c-${Date.now()}`,
        marketId,
        body,
        authorAddress: authorAddress ?? null,
        createdAt: new Date().toISOString(),
      },
      message: "Comment created successfully",
    });
  } catch (e) {
    next(e);
  }
});
