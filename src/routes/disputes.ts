import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { openDispute, DisputeError } from "../services/disputeService";
import { validateHttpsUrl, validateSsrf } from "../utils/url";
import { logger } from "../config/logger";

export const disputesRouter = Router({ mergeParams: true });

const openDisputeSchema = z.object({
  reason: z.string().min(10).max(500),
  evidenceUri: z.string().optional().nullable(),
}).strict();

disputesRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const marketId = req.params.id as string;
    if (!marketId) {
      return res.status(400).json({ error: { code: "bad_request", message: "Market ID is required" } });
    }

    const parsed = openDisputeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: "validation_error",
          message: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        },
      });
    }

    const { reason, evidenceUri } = parsed.data;

    if (evidenceUri) {
      const urlResult = validateHttpsUrl(evidenceUri);
      if (!urlResult.valid) {
        return res.status(400).json({
          error: { code: "invalid_evidence_uri", message: urlResult.error },
        });
      }

      const ssrfResult = await validateSsrf(evidenceUri);
      if (!ssrfResult.valid) {
        logger.warn({ evidenceUri, error: ssrfResult.error }, "SSRF check failed for evidenceUri");
        return res.status(400).json({
          error: { code: "ssrf_check_failed", message: ssrfResult.error },
        });
      }
    }

    const dispute = await openDispute({
      marketId,
      userId: req.user!.sub,
      reason,
      evidenceUri: evidenceUri ?? null,
    });

    res.status(201).json({ data: dispute });
  } catch (e) {
    if (e instanceof DisputeError) {
      return res.status(e.status).json({ error: { code: e.code, message: e.message } });
    }
    return next(e);
  }
});
