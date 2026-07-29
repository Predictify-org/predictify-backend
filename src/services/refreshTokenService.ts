import { db } from "../db/index";
import { refreshTokens, users } from "../db/schema";
import { eq, and, isNull } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../config/logger";
import { Result, ok, err } from "../errors/RouteError";
import { signAccessToken } from "./jwtService";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_TOKEN_ERROR_MESSAGES = {
  invalid: "Invalid refresh token",
  expired: "Refresh token expired",
  reuseDetected: "Refresh token reuse detected",
} as const;

export type RefreshTokenErrorCode = keyof typeof REFRESH_TOKEN_ERROR_MESSAGES;

/**
 * @deprecated Use RouteError discriminated union instead.
 * Kept for backward compatibility during migration.
 */
export class RefreshTokenError extends Error {
  constructor(public readonly code: RefreshTokenErrorCode) {
    super(REFRESH_TOKEN_ERROR_MESSAGES[code]);
    this.name = "RefreshTokenError";
  }
}

type RefreshTokenRecord = typeof refreshTokens.$inferSelect;
type UserRecord = typeof users.$inferSelect;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateAccessToken(userId: string, stellarAddress: string): string {
  return signAccessToken({ sub: userId, stellarAddress });
}

async function findRefreshTokenByRawToken(rawToken: string): Promise<RefreshTokenRecord | null> {
  const [tokenRecord] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashToken(rawToken)))
    .limit(1);

  return tokenRecord ?? null;
}

async function findUserById(userId: string): Promise<UserRecord | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ?? null;
}

async function revokeTokenFamilyById(familyId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.familyId, familyId),
        isNull(refreshTokens.revokedAt)
      )
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
): Promise<Result<{ accessToken: string; refreshToken: string }>> {
  const tokenRecord = await findRefreshTokenByRawToken(rawToken);

  if (!tokenRecord) {
    return err({
      kind: "Unauthorized",
      message: "Invalid refresh token",
    });
  }

  if (tokenRecord.revokedAt !== null) {
    logger.warn(
      { familyId: tokenRecord.familyId },
      "Refresh token reuse detected. Revoking entire token family."
    );

    // A rotated token being presented again suggests theft, so the active branch is invalidated.
    await revokeTokenFamilyById(tokenRecord.familyId);

    return err({
      kind: "Forbidden",
      message: "Refresh token reuse detected",
      reason: "Token has already been used",
    });
  }

  if (tokenRecord.expiresAt < new Date()) {
    return err({
      kind: "Unauthorized",
      message: "Refresh token expired",
    });
  }

  const user = await findUserById(tokenRecord.userId);

  if (!user) {
    return err({
      kind: "Unauthorized",
      message: "Invalid refresh token",
    });
  }

  const now = new Date();
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(eq(refreshTokens.id, tokenRecord.id));

  const { token: newRawRefreshToken } = await issueRefreshToken(
    tokenRecord.userId,
    tokenRecord.familyId,
    tokenRecord.id
  );

  const accessToken = generateAccessToken(user.id, user.stellarAddress);

  return ok({
    accessToken,
    refreshToken: newRawRefreshToken,
  });
}

export async function revokeFamily(rawToken: string): Promise<void> {
  const tokenRecord = await findRefreshTokenByRawToken(rawToken);

  if (tokenRecord) {
    await revokeTokenFamilyById(tokenRecord.familyId);
  }
}
