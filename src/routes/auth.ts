import { Router } from "express";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import {
  RefreshTokenError,
  rotateRefreshToken,
} from "../services/refreshTokenService";
import { createChallenge } from "../services/authChallengeService";
import {
  AuthVerifyError,
  verifyChallengeAndIssueJwt,
} from "../services/authVerifyService";
import { logger } from "../config/logger";

export const authRouter = Router();
const refreshTokenBodySchema = z.object({
  refreshToken: z.string().min(1),
});

const challengeBodySchema = z.object({
  stellarAddress: z.string().refine(
    (addr) => StrKey.isValidEd25519PublicKey(addr),
    { message: "Invalid Stellar ed25519 public key" },
  ),
});

function parseRefreshToken(body: unknown): string | null {
  const result = refreshTokenBodySchema.safeParse(body);
  return result.success ? result.data.refreshToken : null;
}

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const refreshToken = parseRefreshToken(req.body);

    if (!refreshToken) {
      res.status(400).json({
        error: { code: "invalid_request", message: "refreshToken is required and must be a string" },
      });
      return;
    }

    const tokens = await rotateRefreshToken(refreshToken);
    res.json(tokens);
  } catch (err) {
    if (err instanceof RefreshTokenError) {
      logger.warn({ code: err.code }, "token_refresh_failed");

      if (err.code === "reuseDetected") {
        res.status(403).json({
          error: { code: "token_reuse_detected" },
        });
        return;
      }

      res.status(401).json({
        error: { code: "invalid_token" },
      });
      return;
    }

    next(err);
  }
});

authRouter.post("/challenge", async (req, res, next) => {
  try {
    const parsed = challengeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_address", message: "stellarAddress must be a valid Stellar public key" },
      });
      return;
    }

    const result = await createChallenge(parsed.data.stellarAddress);
    res.status(201).json({
      nonce: result.nonce,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (e) { next(e); }
});

const verifyBodySchema = z.object({
  stellarAddress: z.string().refine(
    (addr) => StrKey.isValidEd25519PublicKey(addr),
    { message: "Invalid Stellar ed25519 public key" },
  ),
  nonce: z.string().min(1),
  signature: z.string().min(1),
});

authRouter.post("/verify", async (req, res, next) => {
  try {
    const parsed = verifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new Error("Invalid auth verify request") as Error & { status: number; code: string };
      err.status = 400;
      err.code = "invalid_request";
      throw err;
    }

    const result = await verifyChallengeAndIssueJwt(
      parsed.data.stellarAddress,
      parsed.data.nonce,
      parsed.data.signature,
    );

    res.status(200).json(result);
  } catch (e) {
    if (e instanceof AuthVerifyError) {
      res.status(e.status).json({ error: { code: e.code } });
      return;
    }
    next(e);
  }
});
