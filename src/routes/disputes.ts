import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { openDispute, DisputeError } from "../services/disputeService";
import { validateHttpsUrl, validateSsrf } from "../utils/url";
import { logger } from "../config/logger";
import { RouteErrorFactory } from "../errors";
import { compressResponse } from "../middleware/compression";

export const disputesRouter = Router({ mergeParams: true });

// Apply compression to all disputes responses — large payloads (≥ 1 KiB)
// are gzip/deflate compressed based on the client's Accept-Encoding header.
disputesRouter.use(compressResponse);

const openDisputeSchema = z.object({
  reason: z.string().min(10).max(500),
  evidenceUri: z.string().optional().nullable(),
}).strict();

disputesRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const marketId = (req.params as Record<string, string>).id;
    if (!marketId) {
      throw RouteErrorFactory.badRequest("Market ID is required");
    }

    const parsed = openDisputeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw RouteErrorFactory.validation("Invalid request body", parsed.error.flatten().fieldErrors as Record<string, string[]>);
    }

    const { reason, evidenceUri } = parsed.data;

    if (evidenceUri) {
      const urlResult = validateHttpsUrl(evidenceUri);
      if (!urlResult.valid) {
        throw RouteErrorFactory.badRequest(urlResult.error ?? "Invalid evidence URI");
      }

      const ssrfResult = await validateSsrf(evidenceUri);
      if (!ssrfResult.valid) {
        logger.warn({ evidenceUri, error: ssrfResult.error }, "SSRF check failed for evidenceUri");
        throw RouteErrorFactory.badRequest(ssrfResult.error ?? "SSRF check failed");
      }
    }

    const userId = (req as unknown as { user: { id: string } }).user.id;

    const dispute = await openDispute({
      marketId,
      userId,
      reason,
      evidenceUri: evidenceUri ?? null,
    });

    res.status(201).json({ data: dispute });
  } catch (e) {
    if (e instanceof DisputeError) {
      res.status(e.status).json({ error: { type: e.code, message: e.message } });
      return;
    }
    next(e);
  }
});
