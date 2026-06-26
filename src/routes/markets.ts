import { Router } from "express";
import { listMarkets, getMarketById, updateMarket, VersionConflictError } from "../services/marketService";
import { requireAdmin, AuthenticatedRequest } from "../middleware/auth";
import { z } from "zod";

export const marketsRouter = Router();

const patchMarketSchema = z.object({
  question: z.string().optional(),
  metadata: z.any().optional(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

marketsRouter.get("/", async (_req, res, next) => {
  try {
    res.json({ data: await listMarkets() });
  } catch (e) { next(e); }
});

marketsRouter.get("/:id", async (req, res, next) => {
  try {
    const market = await getMarketById(req.params.id as string);
    if (!market) {
      res.status(404).json({ error: { code: "not_found" } });
      return;
    }
    res.json({ data: market });
  } catch (e) { next(e); }
});

marketsRouter.patch("/:id", requireAdmin, async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = patchMarketSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "validation_error",
          details: parsed.error.issues,
        },
      });
      return;
    }

    const { question, metadata, expectedVersion } = parsed.data;
    const adminAddress = req.user!.stellarAddress;

    const patch: { question?: string; metadata?: any } = {};
    if (question !== undefined) patch.question = question;
    if (metadata !== undefined) patch.metadata = metadata;

    const updated = await updateMarket(req.params.id as string, patch, expectedVersion, adminAddress);
    res.json({ data: updated });
  } catch (e) {
    if (e instanceof VersionConflictError) {
      res.status(409).json({ error: { code: "version_conflict" } });
      return;
    }
    if ((e as any).status === 404) {
      res.status(404).json({ error: { code: "not_found" } });
      return;
    }
    next(e);
  }
});


