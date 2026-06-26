import { Router } from "express";
import { z } from "zod";
import { getUserByAddress, getUserPredictions } from "../services/userService";

export const usersRouter = Router();

// Stellar address validation pattern
const stellarAddressSchema = z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

usersRouter.get("/:address/predictions", async (req, res, next) => {
  try {
    const { address } = req.params;
    const { status, cursor, limit = "20" } = req.query;

    // Validate address format
    try {
      stellarAddressSchema.parse(address);
    } catch (e) {
      return res.status(400).json({ error: { code: "invalid_address" } });
    }

    // Validate query params
    const querySchema = z.object({
      status: z.enum(["pending", "confirmed", "won", "lost", "claimed"]).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100),
    });

    const query = querySchema.parse({ status, cursor, limit: parseInt(limit as string) });

    // Find user
    const user = await getUserByAddress(address);
    if (!user) {
      return res.status(404).json({ error: { code: "not_found" } });
    }

    // Get predictions
    const result = await getUserPredictions(user.id, {
      status: query.status,
      limit: query.limit,
      cursor: query.cursor,
    });

    res.json({
      data: result.data,
      nextCursor: result.nextCursor,
    });
  } catch (e) {
    next(e);
  }
});
