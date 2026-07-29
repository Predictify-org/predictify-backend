import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getUserByAddress, getUserPredictions, getCurrentUserProfile, getUserProfile } from "../services/userService";
import { requireAuthForbidden } from "../middleware/requireAuth";
import { AuthenticatedRequest } from "../middleware/auth";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

export const usersRouter = Router();

const stellarAddressSchema = z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

usersRouter.get("/me", requireAuthForbidden, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const result = await getCurrentUserProfile(userId);

    if (!result.ok) {
      throw result.error;
    }

    const profile = result.value;
    logger.info(
      { userId, stellarAddress: profile.stellarAddress, ...profile.totals },
      "user_me_profile_loaded",
    );
    return res.json({ data: profile });
  } catch (e) {
    return next(e);
  }
});

usersRouter.get("/:address/predictions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const address = req.params.address as string;
    const { status, cursor, limit = "20" } = req.query;

    try {
      stellarAddressSchema.parse(address);
    } catch {
      return res.status(400).json({ error: { code: "invalid_address" } });
    }

    const querySchema = z.object({
      status: z.enum(["pending", "confirmed", "won", "lost", "claimed"]).optional(),
      cursor: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
        .optional(),
      limit: z.coerce.number().int().min(1).max(100),
    });

    const query = querySchema.parse({ status, cursor, limit });

    const user = await getUserByAddress(address);
    if (!user) {
      return res.status(404).json({ error: { code: "not_found" } });
    }

    const result = await getUserPredictions(user.id, {
      status: query.status,
      limit: query.limit,
      cursor: query.cursor,
    });

    return res.json({
      data: result.data,
      nextCursor: result.nextCursor,
    });
  } catch (e) {
    return next(e);
  }
});

usersRouter.get("/:stellarAddress/profile", async (req: Request, res: Response, next: NextFunction) => {
  const reqId = getRequestId() ?? (typeof (req as { id?: unknown }).id === "string" ? (req as { id?: string }).id : undefined);

  const parseResult = stellarAddressSchema.safeParse(req.params.stellarAddress);
  if (!parseResult.success) {
    logger.warn(
      { reqId, stellarAddress: req.params.stellarAddress, issues: parseResult.error.issues },
      "user_profile_validation_failed",
    );
    return res.status(400).json({
      error: {
        code: "validation_error",
        message: parseResult.error.issues[0]?.message ?? "invalid stellar address",
        requestId: reqId,
      },
    });
  }

  const stellarAddress = parseResult.data;

  try {
    logger.debug({ reqId, stellarAddress }, "user_profile_lookup");

    const profile = await getUserProfile(stellarAddress);

    if (!profile) {
      logger.debug({ reqId, stellarAddress }, "user_profile_not_found");
      return res.status(404).json({
        error: {
          code: "not_found",
          message: "no user found with that stellar address",
          requestId: reqId,
        },
      });
    }

    logger.debug(
      { reqId, stellarAddress, predictionCount: profile.predictions.length },
      "user_profile_found",
    );

    return res.json({ data: profile });
  } catch (err) {
    return next(err);
  }
});
