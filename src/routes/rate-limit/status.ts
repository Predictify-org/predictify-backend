import { Router } from "express";
import { anonRateLimitStore, extractClientIp, isAuthenticatedRequest } from "../../middleware/rateLimitAnon";
import { env } from "../../config/env";
import { getRequestId } from "../../lib/requestContext";
import { logger } from "../../config/logger";

export const rateLimitStatusRouter = Router();

rateLimitStatusRouter.get("/status", (req, res) => {
  const now = Date.now();
  const windowMs = env.ANON_RATE_LIMIT_WINDOW_MS;
  const max = env.ANON_RATE_LIMIT_MAX;

  if (isAuthenticatedRequest(req)) {
    logger.info({ reqId: getRequestId() }, "rate_limit_status_authenticated");
    res.json({
      data: {
        type: "authenticated",
        limit: max,
        windowMs,
        bypasses: true,
      },
    });
    return;
  }

  const clientIp = extractClientIp(req, env.TRUST_PROXY);
  const active = anonRateLimitStore.getTimestamps(clientIp, now, windowMs);
  const used = active.length;
  const remaining = Math.max(0, max - used);
  const resetAt =
    used > 0
      ? new Date(active[0]! + windowMs).toISOString()
      : new Date(now + windowMs).toISOString();

  logger.info(
    { reqId: getRequestId(), clientIp, used, remaining },
    "rate_limit_status_anonymous",
  );

  res.json({
    data: {
      type: "anonymous",
      clientIp,
      limit: max,
      used,
      remaining,
      windowMs,
      resetAt,
    },
  });
});