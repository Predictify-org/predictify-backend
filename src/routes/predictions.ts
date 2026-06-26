import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { createPrediction, getUserPredictions } from "../services/predictionService";
import { ValidationError } from "../errors";

export const predictionsRouter = Router({ mergeParams: true });

const createBodySchema = z.object({
  outcome: z.string().min(1, "outcome is required"),
  amount: z.string().min(1, "amount is required"),
  txHash: z.string().min(1, "txHash is required"),
});

predictionsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const marketId = req.params.id as string;
    const userId = req.user!.id;

    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ValidationError(`${firstIssue.path.join(".")}: ${firstIssue.message}`);
    }

    const prediction = await createPrediction({
      marketId,
      userId,
      outcome: parsed.data.outcome,
      amount: parsed.data.amount,
      txHash: parsed.data.txHash,
    });

    return res.status(201).json({ data: prediction });
  } catch (e) {
    return next(e);
  }
});

predictionsRouter.get("/mine", requireAuth, async (req, res, next) => {
  try {
    const marketId = req.params.id as string;
    const userId = req.user!.id;

    const list = await getUserPredictions({ marketId, userId });
    return res.json({ data: list });
  } catch (e) {
    return next(e);
  }
});
