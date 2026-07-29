import { Router } from "express";
import { z } from "zod";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth";
import { forceFinalize } from "../services/marketAdmin";
import { db } from "../db";
import { RouteErrorFactory } from "../errors";

const bodySchema = z.object({
  winningOutcome: z.string().min(1),
});

export const adminMarketsRouter = Router();

adminMarketsRouter.use(requireAdmin);

adminMarketsRouter.post(
  "/:id/force-finalize",
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw RouteErrorFactory.validation("Invalid request body");
      }

      const confirm = req.query.confirm === "true";
      const adminAddress = req.user!.stellarAddress as string;

      const outcome = await forceFinalize(
        db,
        { marketId: req.params.id as string, winningOutcome: parsed.data.winningOutcome, adminAddress },
        confirm,
      );

      if (outcome.phase === "already_finalized") {
        throw RouteErrorFactory.conflict("Market already finalized");
      }

      res.status(200).json({ data: outcome });
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string };
      if (err.status === 404) {
        next(RouteErrorFactory.notFound("Market not found"));
        return;
      }
      if (err.status === 422) {
        next(RouteErrorFactory.validation(err.message ?? "Deadline not reached"));
        return;
      }
      next(e);
    }
  },
);
