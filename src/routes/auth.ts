import { Router } from "express";
import { rotateRefreshToken, revokeFamily } from "../services/refreshTokenService";
import { logger } from "../config/logger";

export const authRouter = Router();

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== "string") {
      res.status(400).json({
        error: { code: "invalid_request", message: "refreshToken is required and must be a string" },
      });
      return;
    }

    const tokens = await rotateRefreshToken(refreshToken);
    res.json(tokens);
  } catch (err: any) {
    logger.warn({ err: err.message }, "token_refresh_failed");

    if (err.message === "Refresh token reuse detected") {
      res.status(403).json({
        error: { code: "token_reuse_detected" },
      });
      return;
    }

    if (err.message === "Refresh token expired" || err.message === "Invalid refresh token") {
      res.status(401).json({
        error: { code: "invalid_token" },
      });
      return;
    }

    next(err);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== "string") {
      res.status(400).json({
        error: { code: "invalid_request", message: "refreshToken is required and must be a string" },
      });
      return;
    }

    await revokeFamily(refreshToken);
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
});
