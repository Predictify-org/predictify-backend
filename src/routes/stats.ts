/**
 * stats.ts
 *
 * GET /api/stats
 *
 * Returns global platform statistics (user count, market breakdown,
 * prediction/claim totals) with strong ETag support.
 *
 * ## ETag / conditional GET
 *
 * Every 200 response includes:
 *   - `ETag`           — SHA-256 strong ETag derived from the JSON payload
 *   - `Cache-Control: no-cache`  — clients may cache but must revalidate
 *
 * When the client sends `If-None-Match` whose value matches the current
 * ETag, the server responds with **304 Not Modified** (no body), saving
 * bandwidth on repeated reads.
 *
 * ## Security
 *
 * - Deterministic ETags use sorted-key JSON serialisation (see
 *   middleware/etag.ts).
 * - The `If-None-Match` header is stripped of quotes before comparison.
 * - No authentication is required — this is a public read-only endpoint.
 *
 * ## Metrics
 *
 * Every request (including ones rejected by rate limiting) is observed in
 * the `stats_request_duration_seconds` Prometheus histogram, labeled by
 * `route` and `status`. See metrics/statsMetrics.ts and metrics/registry.ts.
 */

import { Router } from "express";
import { conditionalGet } from "../middleware/etag";
import { getGlobalStats } from "../services/statsService";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { rateLimitAnon } from "../middleware/rateLimitAnon";
import { statsMetricsMiddleware } from "../metrics/statsMetrics";

export const statsRouter = Router();

// Latency histogram — registered first so rate-limited (429) requests are
// also observed, not just successful responses. See metrics/statsMetrics.ts.
statsRouter.use(statsMetricsMiddleware);

// Anonymous rate limiting — public endpoint that issues multiple DB queries.
// A conservative cap prevents abuse while being generous enough for dashboards.
statsRouter.use(rateLimitAnon);

/**
 * GET /api/stats
 *
 * Returns platform-level aggregate statistics.
 *
 * Response (200):
 * ```json
 * {
 *   "data": {
 *     "users": 1234,
 *     "markets": { "total": 56, "active": 34, "resolved": 22 },
 *     "predictions": 9876,
 *     "claims": 432
 *   }
 * }
 * ```
 */
statsRouter.get("/", async (req, res, next) => {
  const reqId = getRequestId();

  try {
    const stats = await getGlobalStats();

    logger.debug(
      { reqId, users: stats.users, markets: stats.markets.total, predictions: stats.predictions },
      "stats_served",
    );

    // Conditional GET — respond 304 if the client already has the current
    // representation, saving both bandwidth and server CPU on serialisation.
    const done = conditionalGet({ data: stats }, req, res);
    if (done) return;

    res.json({ data: stats });
  } catch (err) {
    next(err);
  }
});
