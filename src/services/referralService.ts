/**
 * @module services/referralService
 *
 * Business logic for referral code creation and listing.
 *
 * All database access is encapsulated behind simple async functions so the
 * route layer and tests can treat them as injectable dependencies.
 */

import { eq, desc } from "drizzle-orm";
import { db } from "../db/client";
import {
  referrals,
  referralRewardAllocations,
  type Referral,
  type NewReferral,
  type ReferralRewardAllocation,
} from "../db/schema";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReferralServiceDeps {
  createReferral(input: CreateReferralInput): Promise<ReferralResult>;
  listUserReferrals(userId: string): Promise<Referral[]>;
}

export interface CreateReferralInput {
  userId: string;
  campaignId?: string;
}

export interface ReferralResult {
  referralCode: string;
  message: string;
}

export interface AllocateReferralRewardInput {
  referralId: string;
  idempotencyKey: string;
  amount: string;
  asset: string;
}

export class ReferralRewardValidationError extends Error {
  readonly code = "referral_reward_validation_error";
}

export class ReferralRewardConflictError extends Error {
  readonly code = "referral_reward_conflict";
}

// ---------------------------------------------------------------------------
// Default (production) implementations
// ---------------------------------------------------------------------------

/**
 * Generates a unique referral code and persists a new referral row.
 *
 * The referral code format is `REF-XXXX-XXXX` where X is a random
 * alphanumeric character (uppercase), providing ~1.7 billion combinations.
 */
function generateReferralCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const segment = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `REF-${segment()}-${segment()}`;
}

/**
 * Creates a new referral code for the given user.
 */
export async function createReferral(input: CreateReferralInput): Promise<ReferralResult> {
  const referralCode = generateReferralCode();

  const newReferral: NewReferral = {
    userId: input.userId,
    referralCode,
    campaignId: input.campaignId ?? null,
    status: "pending",
  };

  await db.insert(referrals).values(newReferral);

  return {
    referralCode,
    message: "Referral created successfully",
  };
}

/**
 * Lists all referrals created by the given user, newest first.
 */
export async function listUserReferrals(userId: string): Promise<Referral[]> {
  return db
    .select()
    .from(referrals)
    .where(eq(referrals.userId, userId))
    .orderBy(desc(referrals.createdAt));
}

function validateRewardInput(input: AllocateReferralRewardInput): void {
  if (!input.referralId.trim()) {
    throw new ReferralRewardValidationError("referralId is required");
  }
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 128) {
    throw new ReferralRewardValidationError("idempotencyKey must be 1-128 characters");
  }
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(input.amount) || /^0(?:\.0{1,18})?$/.test(input.amount)) {
    throw new ReferralRewardValidationError("amount must be a positive decimal with up to 18 places");
  }
  if (!/^[A-Z0-9]{1,12}$/.test(input.asset)) {
    throw new ReferralRewardValidationError("asset must be 1-12 uppercase alphanumeric characters");
  }
}

function matchesAllocation(
  allocation: ReferralRewardAllocation,
  input: AllocateReferralRewardInput,
): boolean {
  return allocation.referralId === input.referralId &&
    allocation.amount === input.amount &&
    allocation.asset === input.asset;
}

/**
 * Allocates a referral reward exactly once. The insert is the serialization
 * point, so concurrent callers cannot both create an allocation. A conflict
 * is safe to retry only when all business fields match the stored row.
 */
export async function allocateReferralReward(
  input: AllocateReferralRewardInput,
): Promise<ReferralRewardAllocation> {
  validateRewardInput(input);

  const inserted = await db
    .insert(referralRewardAllocations)
    .values({
      referralId: input.referralId,
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      asset: input.asset,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const byKey = await db
    .select()
    .from(referralRewardAllocations)
    .where(eq(referralRewardAllocations.idempotencyKey, input.idempotencyKey));
  const byReferral = byKey[0] ?? (await db
    .select()
    .from(referralRewardAllocations)
    .where(eq(referralRewardAllocations.referralId, input.referralId)))[0];

  if (!byReferral) {
    throw new Error("referral reward allocation conflict could not be resolved");
  }
  if (!matchesAllocation(byReferral, input)) {
    throw new ReferralRewardConflictError("referral reward allocation does not match the existing allocation");
  }
  return byReferral;
}
