import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { idempotency } from "../middleware/idempotency";

export const searchRouter = Router();

// In-flight request tracking for graceful shutdown drain
let inFlightSearchRequests = 0;

/**
 * Wait for all in-flight /api/search requests to finish.
 * @param timeoutMs Maximum time to wait before forcing resolution
 */
export async function drainSearchRequests(timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  if (inFlightSearchRequests === 0) {
    logger.info("No in-flight /api/search requests to drain");
    return;
  }

  logger.info({ inFlight: inFlightSearchRequests }, "Draining in-flight /api/search requests...");
  
  while (inFlightSearchRequests > 0) {
    if (Date.now() - start > timeoutMs) {
      logger.warn({ inFlight: inFlightSearchRequests }, "Timeout waiting for /api/search requests to drain");
      break;
    }
    // Poll every 50ms
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (inFlightSearchRequests === 0) {
    logger.info("Successfully drained all /api/search requests");
  }
}

// Stricter edge cases for boundary validation
const searchSchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, "Search query must not be empty")
    .max(200, "Search query is too long")
    .refine((s) => !s || s.split("").every((c) => c >= " "), "Control characters are not allowed in query"),
  limit: z.coerce
    .number()
    .int()
    .min(1, "Limit must be at least 1")
    .max(100, "Limit cannot exceed 100")
    .default(10),
  page: z.coerce
    .number()
    .int()
    .min(1, "Page must be at least 1")
    .default(1),
}).strict(); // Enforce no extra query parameters

searchRouter.get("/", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  inFlightSearchRequests++;
  try {
    const parseResult = searchSchema.safeParse(req.query);
    const reqId = getRequestId() ?? (req as { id?: string }).id ?? "unknown";

    if (!parseResult.success) {
      res.status(400).json({
        error: {
          code: "validation_error",
          message: parseResult.error.issues[0]?.message ?? "Invalid search parameters",
          requestId: reqId,
        },
      });
      return;
    }

    const { q, limit, page } = parseResult.data;

    // Structured logging with correlation ID
    logger.info(
      { query: q, limit, page, correlationId: reqId },
      "Processing /api/search request"
    );

    // Mock search delay to simulate DB search and allow testing of the drain mechanism
    await new Promise((resolve) => setTimeout(resolve, 200));

    res.json({
      data: {
        results: [],
        meta: {
          query: q,
          limit,
          page,
          total: 0,
        }
      },
    });
  } catch (e) {
    next(e);
  } finally {
    inFlightSearchRequests--;
  }
});

// ── Mutation endpoints with idempotency-key support ──────────────────────

const saveSearchBodySchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Search query must not be empty")
    .max(200, "Search query is too long")
    .refine((s) => !s || s.split("").every((c) => c >= " "), "Control characters are not allowed in query"),
  label: z
    .string()
    .trim()
    .max(100, "Label is too long")
    .optional(),
}).strict();

const updateSearchBodySchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Label must not be empty when provided")
    .max(100, "Label is too long"),
}).strict();

/**
 * POST /api/search
 *
 * Save a search query to the user's search history. Idempotency-key header
 * enables safe retries — the same request with the same key returns the
 * same saved search record.
 *
 * Request body (JSON):
 * ```json
 * {
 *   "query": "prediction markets",
 *   "label": "My Search"        // optional display label
 * }
 * ```
 *
 * Response (201):
 * ```json
 * {
 *   "data": {
 *     "id": "search-uuid",
 *     "query": "prediction markets",
 *     "label": "My Search",
 *     "createdAt": "2026-07-28T12:00:00.000Z"
 *   }
 * }
 * ```
 */
searchRouter.post("/", idempotency, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  inFlightSearchRequests++;
  try {
    const parseResult = saveSearchBodySchema.safeParse(req.body);
    const reqId = getRequestId() ?? (req as { id?: string }).id ?? "unknown";

    if (!parseResult.success) {
      res.status(400).json({
        error: {
          code: "validation_error",
          message: parseResult.error.issues[0]?.message ?? "Invalid request body",
          requestId: reqId,
        },
      });
      return;
    }

    const { query, label } = parseResult.data;

    logger.info(
      { query, label, correlationId: reqId },
      "Saving search query",
    );

    // Mock save operation — in production this would persist to the database
    const savedSearch = {
      id: `search-${Date.now()}`,
      query,
      label: label ?? null,
      createdAt: new Date().toISOString(),
    };

    res.status(201).json({
      data: savedSearch,
    });
  } catch (e) {
    next(e);
  } finally {
    inFlightSearchRequests--;
  }
});

/**
 * PATCH /api/search/:id
 *
 * Update an existing saved search (e.g., rename the label). Idempotency-key
 * header enables safe retries.
 *
 * Request body (JSON):
 * ```json
 * {
 *   "label": "Updated Label"
 * }
 * ```
 *
 * Response (200):
 * ```json
 * {
 *   "data": {
 *     "id": "search-uuid",
 *     "query": "prediction markets",
 *     "label": "Updated Label",
 *     "updatedAt": "2026-07-28T12:00:00.000Z"
 *   }
 * }
 * ```
 */
searchRouter.patch("/:id", idempotency, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  inFlightSearchRequests++;
  try {
    const parseResult = updateSearchBodySchema.safeParse(req.body);
    const reqId = getRequestId() ?? (req as { id?: string }).id ?? "unknown";
    const { id } = req.params;

    if (!parseResult.success) {
      res.status(400).json({
        error: {
          code: "validation_error",
          message: parseResult.error.issues[0]?.message ?? "Invalid request body",
          requestId: reqId,
        },
      });
      return;
    }

    if (!id || typeof id !== "string" || id.length > 128) {
      res.status(400).json({
        error: {
          code: "validation_error",
          message: "Invalid search ID",
          requestId: reqId,
        },
      });
      return;
    }

    const { label } = parseResult.data;

    logger.info(
      { searchId: id, label, correlationId: reqId },
      "Updating saved search",
    );

    // Mock update operation — in production this would update the database
    res.json({
      data: {
        id,
        label,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    next(e);
  } finally {
    inFlightSearchRequests--;
  }
});
