/**
 * @module services/referralService
 *
 * Business logic for referral code creation and listing.
 *
 * All database access is encapsulated behind simple async functions so the
 * route layer and tests can treat them as injectable dependencies.
 */

import { eq, and, desc } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/client";
import { referrals, type Referral, type NewReferral } from "../db/schema";

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
