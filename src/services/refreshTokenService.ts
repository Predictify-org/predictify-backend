import { db } from "../db/index";
import { refreshTokens, users } from "../db/schema";
import { eq, and, isNull } from "drizzle-orm";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { logger } from "../config/logger";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateAccessToken(userId: string, stellarAddress: string): string {
  return jwt.sign(
    { sub: userId, stellarAddress },
    env.JWT_SECRET,
    {
      expiresIn: env.JWT_TTL_SECONDS,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }
  );
}

export async function issueRefreshToken(
  userId: string,
  familyId?: string,
  parentId?: string
): Promise<{ token: string; expiresAt: Date; familyId: string }> {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const resolvedFamilyId = familyId || crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await db.insert(refreshTokens).values({
    userId,
    tokenHash,
    familyId: resolvedFamilyId,
    parentId: parentId || null,
    expiresAt,
    revokedAt: null,
  });

  return {
    token,
    expiresAt,
    familyId: resolvedFamilyId,
  };
}

export async function rotateRefreshToken(
  rawToken: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const hash = hashToken(rawToken);

  const [tokenRecord] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash))
    .limit(1);

  if (!tokenRecord) {
    throw new Error("Invalid refresh token");
  }

  // Reuse detection: check if already revoked
  if (tokenRecord.revokedAt !== null) {
    logger.warn(
      { familyId: tokenRecord.familyId },
      "Refresh token reuse detected. Revoking entire token family."
    );

    // Revoke all tokens sharing the same familyId
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.familyId, tokenRecord.familyId),
          isNull(refreshTokens.revokedAt)
        )
      );

    throw new Error("Refresh token reuse detected");
  }

  // Expiry check
  if (tokenRecord.expiresAt < new Date()) {
    throw new Error("Refresh token expired");
  }

  // Revoke the old token
  const now = new Date();
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(eq(refreshTokens.id, tokenRecord.id));

  // Issue new refresh token within the same family
  const { token: newRawRefreshToken } = await issueRefreshToken(
    tokenRecord.userId,
    tokenRecord.familyId,
    tokenRecord.id
  );

  // Retrieve user to generate a new access token
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, tokenRecord.userId))
    .limit(1);

  if (!user) {
    throw new Error("User not found");
  }

  const accessToken = generateAccessToken(user.id, user.stellarAddress);

  return {
    accessToken,
    refreshToken: newRawRefreshToken,
  };
}

export async function revokeFamily(rawToken: string): Promise<void> {
  const hash = hashToken(rawToken);

  const [tokenRecord] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash))
    .limit(1);

  if (tokenRecord) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.familyId, tokenRecord.familyId),
          isNull(refreshTokens.revokedAt)
        )
      );
  }
}
