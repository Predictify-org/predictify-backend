/**
 * @module routes/feature-flags
 *
 * Public read endpoint for feature flags.
 *
 * GET /api/feature-flags
 *
 * Returns the active feature-flag state suitable for client consumption. The
 * handler is guarded by a per-request timeout; if the backing service doesn't
 * resolve within FEATURE_FLAGS_TIMEOUT_MS the request is cancelled
 * cooperatively (via AbortSignal) and the caller receives:
 *
 *   HTTP 504  { error: { code: "gateway_timeout", message: "...", requestId } }
 *
 * Response shape on success:
 *   HTTP 200  { items: Array<{id, enabled, variant}>, next_cursor, total }
 */

import { Router } from "express";
import { z } from "zod";
import { FeatureFlagsService } from "../services/feature-flags.service";
import { abortableRace, requestTimeout, RequestAbortedError } from "../middleware/timeout";
import { paginate, clampLimit, DEFAULT_PAGE_SIZE } from "../utils/cursor";
import { logger } from "../config/logger";

export const featureFlagsRouter = Router();

/** Per-request timeout for the feature-flags endpoint. */
const FEATURE_FLAGS_TIMEOUT_MS = 5000;

featureFlagsRouter.use(
  requestTimeout(FEATURE_FLAGS_TIMEOUT_MS, {
    statusCode: 504,
    code: "gateway_timeout",
    message: "Feature flags request timed out",
  }),
);

const featureFlagsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(DEFAULT_PAGE_SIZE),
});

featureFlagsRouter.get("/", async (req, res, next) => {
  const signal = res.locals.abortSignal as AbortSignal | undefined;
  try {
    const parsed = featureFlagsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw parsed.error;
    }

    const { cursor, limit: rawLimit } = parsed.data;
    const limit = clampLimit(rawLimit, DEFAULT_PAGE_SIZE);

    const flagsRecord = await abortableRace(
      Promise.resolve(FeatureFlagsService.getFlagsForUser()),
      signal,
    );

    // Convert the Record to a sorted array for pagination.
    const flags = Object.entries(flagsRecord).map(([id, value]) => ({
      id,
      enabled: value.enabled,
      variant: (value.metadata?.variant as string | undefined) ?? null,
    }));
    const sorted = flags.sort((a, b) => b.id.localeCompare(a.id));

    const page = paginate(
      sorted,
      (flag) => ({ sortValue: flag.id, id: flag.id }),
      cursor,
      limit,
    );

    return res.status(200).json({
      items: page.data,
      next_cursor: page.nextCursor,
      total: sorted.length,
    });
  } catch (e) {
    if (e instanceof RequestAbortedError) {
      logger.warn(
        { correlationId: res.locals.correlationId, path: req.path },
        "Abandoned /api/feature-flags request after timeout",
      );
      return;
    }
    next(e);
  }
});
