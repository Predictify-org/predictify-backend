/**
 * @module marketFeatureService
 *
 * Owns the "feature/unfeature a market for the home page" workflow.
 *
 * Responsibilities:
 *  - Atomically flip the `featured` flag on a market while populating
 *    `featured_at` and `featured_by` so downstream tools know who curated
 *    each row and when.
 *  - Reject archived markets — featuring an archived market would surface
 *    a hidden market on the home page.
 *  - Idempotent: calling feature() on an already-featured market is a no-op
 *    that still returns a successful response.
 *  - Persist an audit entry to BOTH `market_audit_log` (state diff) and
 *    `audit_logs` (compliance trail) and emit a structured log event.
 *  - Provide a public read path (`listFeaturedMarkets`) used by the home page.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { marketAuditLog, markets } from "../db/schema";
import { emitMarketEvent, LogEvent } from "../logging/events";
import { createAuditLog } from "../services/auditService";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Default page size for public `GET /api/markets/featured`. */
export const DEFAULT_FEATURED_LIMIT = 6;
/** Hard ceiling for the public endpoint — protects against abusive scrapers. */
export const MAX_FEATURED_LIMIT = 20;

// ─── Error types ─────────────────────────────────────────────────────────────

export class MarketNotFoundError extends Error {
  constructor(marketId: string) {
    super(`Market not found: ${marketId}`);
    this.name = "MarketNotFoundError";
  }
}

export class MarketArchivedError extends Error {
  readonly status = 400;
  readonly code = "market_archived";
  constructor(marketId: string) {
    super(`Market ${marketId} is archived and cannot be featured`);
    this.name = "MarketArchivedError";
  }
}

// ─── Public response shapes ─────────────────────────────────────────────────

export interface FeaturedMarketView {
  id: string;
  question: string;
  status: string;
  resolutionOutcome: string | null;
  resolutionTime: string;
  winningOutcome: string | null;
  metadata: unknown;
  featuredAt: string | null;
  featuredBy: string | null;
}

export interface FeatureMutationResult {
  marketId: string;
  featured: boolean;
  featuredAt: string | null;
  featuredBy: string | null;
  /** True when this call actually mutated the row (false = idempotent no-op). */
  changed: boolean;
}

// ─── Repository contract ────────────────────────────────────────────────────

export interface MarketFeatureRepository {
  /** Look up the current featured state of a market. Returns null if missing. */
  getMarket(
    marketId: string,
  ): Promise<
    | {
        id: string;
        archived: boolean;
        featured: boolean;
        featuredAt: Date | null;
        featuredBy: string | null;
        question: string;
        status: string;
        resolutionOutcome: string | null;
        resolutionTime: Date;
        winningOutcome: string | null;
        metadata: unknown;
      }
    | null
  >;

  /**
   * WITH A SINGLE TRANSACTION:
   *  1. Lock the market row (FOR UPDATE) to serialise concurrent updates.
   *  2. Re-check archived / featured state under the lock.
   *  3. Update the row to `featured = true`, `featured_at = now()`, `featured_by = adminAddress`.
   *  4. Append an entry to `market_audit_log` capturing before/after state.
   *
   * Returns the updated row plus a `changed` flag (false if the row was
   * already featured — caller treats it as a successful no-op).
   */
  setFeatured(input: {
    marketId: string;
    adminAddress: string;
    featured: boolean;
  }): Promise<{ row: FeatureMutationResult; changed: boolean }>;

  /** Read path used by GET /api/markets/featured — newest first. */
  listFeatured(limit: number): Promise<FeaturedMarketView[]>;
}

// ─── Repository implementation (Drizzle) ────────────────────────────────────

export class DrizzleMarketFeatureRepository implements MarketFeatureRepository {
  constructor(private readonly database: typeof db = db) {}

  async getMarket(marketId: string) {
    const rows = await this.database
      .select({
        id: markets.id,
        archived: markets.archived,
        featured: markets.featured,
        featuredAt: markets.featuredAt,
        featuredBy: markets.featuredBy,
        question: markets.question,
        status: markets.status,
        resolutionOutcome: markets.resolutionOutcome,
        resolutionTime: markets.resolutionTime,
        winningOutcome: markets.winningOutcome,
        metadata: markets.metadata,
      })
      .from(markets)
      .where(eq(markets.id, marketId))
      .limit(1);

    return rows[0] ?? null;
  }

  async setFeatured({
    marketId,
    adminAddress,
    featured,
  }: {
    marketId: string;
    adminAddress: string;
    featured: boolean;
  }): Promise<{ row: FeatureMutationResult; changed: boolean }> {
    return this.database.transaction(async (tx) => {
      // Row-level lock so two simultaneous admins can't double-write audit rows.
      const [existing] = await tx
        .select({
          id: markets.id,
          archived: markets.archived,
          featured: markets.featured,
          featuredAt: markets.featuredAt,
          featuredBy: markets.featuredBy,
        })
        .from(markets)
        .where(eq(markets.id, marketId))
        .for("update")
        .limit(1);

      if (!existing) {
        throw new MarketNotFoundError(marketId);
      }

      if (existing.archived) {
        throw new MarketArchivedError(marketId);
      }

      // Idempotent: already in the target state — bail out before writing audit.
      if (existing.featured === featured) {
        return {
          row: {
            marketId: existing.id,
            featured: existing.featured,
            featuredAt: existing.featuredAt
              ? existing.featuredAt.toISOString()
              : null,
            featuredBy: existing.featuredBy ?? null,
            changed: false,
          },
          changed: false,
        };
      }

      const now = new Date();
      const updated = await tx
        .update(markets)
        .set({
          featured,
          featuredAt: featured ? now : null,
          featuredBy: featured ? adminAddress : null,
        })
        .where(eq(markets.id, marketId))
        .returning({
          id: markets.id,
          featured: markets.featured,
          featuredAt: markets.featuredAt,
          featuredBy: markets.featuredBy,
        });

      const after = updated[0]!;
      const beforeState = {
        featured: existing.featured,
        featuredAt: existing.featuredAt
          ? existing.featuredAt.toISOString()
          : null,
        featuredBy: existing.featuredBy ?? null,
      };
      const afterState = {
        featured: after.featured,
        featuredAt: after.featuredAt ? after.featuredAt.toISOString() : null,
        featuredBy: after.featuredBy ?? null,
      };

      await tx.insert(marketAuditLog).values({
        marketId,
        adminAddress,
        action: featured ? "feature" : "unfeature",
        beforeState,
        afterState,
      });

      return {
        row: {
          marketId: after.id,
          featured: after.featured,
          featuredAt: after.featuredAt
            ? after.featuredAt.toISOString()
            : null,
          featuredBy: after.featuredBy ?? null,
          changed: true,
        },
        changed: true,
      };
    });
  }

  async listFeatured(limit: number): Promise<FeaturedMarketView[]> {
    const rows = await this.database
      .select({
        id: markets.id,
        question: markets.question,
        status: markets.status,
        resolutionOutcome: markets.resolutionOutcome,
        resolutionTime: markets.resolutionTime,
        winningOutcome: markets.winningOutcome,
        metadata: markets.metadata,
        featuredAt: markets.featuredAt,
        featuredBy: markets.featuredBy,
      })
      .from(markets)
      .where(and(eq(markets.featured, true), eq(markets.archived, false)))
      .orderBy(desc(markets.featuredAt), markets.id)
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      question: row.question,
      status: row.status,
      resolutionOutcome: row.resolutionOutcome,
      resolutionTime:
        row.resolutionTime instanceof Date
          ? row.resolutionTime.toISOString()
          : String(row.resolutionTime),
      winningOutcome: row.winningOutcome,
      metadata: row.metadata,
      featuredAt: row.featuredAt ? row.featuredAt.toISOString() : null,
      featuredBy: row.featuredBy,
    }));
  }
}

// ─── Audit logging wrappers ─────────────────────────────────────────────────

async function recordAuditTrail(input: {
  marketId: string;
  adminAddress: string;
  ip: string;
  correlationId: string | undefined;
  action: "market.feature" | "market.unfeature";
  changed: boolean;
}): Promise<void> {
  await createAuditLog({
    action: input.action,
    walletAddress: input.adminAddress,
    ip: input.ip,
    correlationId: input.correlationId,
  });

  logger.info(
    {
      correlationId: input.correlationId,
      marketId: input.marketId,
      adminAddress: input.adminAddress,
      action: input.action,
      changed: input.changed,
    },
    input.action,
  );
}

// ─── Public service API ─────────────────────────────────────────────────────

/**
 * Mark a market as featured for the home page. Idempotent — calling on an
 * already-featured market returns `changed: false` and writes no audit row.
 *
 * @throws MarketNotFoundError when the market ID does not exist.
 * @throws MarketArchivedError when the market is archived.
 */
export interface FeatureCallContext {
  /** Real client IP — passed so audit_logs.ip is accurate. */
  ip: string;
  /** Optional explicit correlation id; falls back to ALS-derived value. */
  correlationId?: string;
}

export async function featureMarket(
  marketId: string,
  adminAddress: string,
  ctx: FeatureCallContext = { ip: "unknown" },
  repo: MarketFeatureRepository = new DrizzleMarketFeatureRepository(),
): Promise<FeatureMutationResult> {
  const { row } = await repo.setFeatured({
    marketId,
    adminAddress,
    featured: true,
  });

  const correlationId = ctx.correlationId ?? getRequestId();

  if (row.changed) {
    emitMarketEvent(LogEvent.MARKET_FEATURED, {
      marketId,
      actor: adminAddress,
      featuredAt: row.featuredAt,
      correlationId,
    });
  }

  await recordAuditTrail({
    marketId,
    adminAddress,
    ip: ctx.ip,
    correlationId,
    action: "market.feature",
    changed: row.changed,
  });

  return row;
}

/**
 * Remove a market from the home page feature set. Idempotent.
 */
export async function unfeatureMarket(
  marketId: string,
  adminAddress: string,
  ctx: FeatureCallContext = { ip: "unknown" },
  repo: MarketFeatureRepository = new DrizzleMarketFeatureRepository(),
): Promise<FeatureMutationResult> {
  const { row } = await repo.setFeatured({
    marketId,
    adminAddress,
    featured: false,
  });

  const correlationId = ctx.correlationId ?? getRequestId();

  if (row.changed) {
    emitMarketEvent(LogEvent.MARKET_UNFEATURED, {
      marketId,
      actor: adminAddress,
      correlationId,
    });
  }

  await recordAuditTrail({
    marketId,
    adminAddress,
    ip: ctx.ip,
    correlationId,
    action: "market.unfeature",
    changed: row.changed,
  });

  return row;
}

export async function listFeaturedMarkets(
  requestedLimit: number | undefined,
  repo: MarketFeatureRepository = new DrizzleMarketFeatureRepository(),
): Promise<FeaturedMarketView[]> {
  const limit = clampLimit(requestedLimit);
  return repo.listFeatured(limit);
}

function clampLimit(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1) {
    return DEFAULT_FEATURED_LIMIT;
  }
  return Math.min(Math.floor(requested), MAX_FEATURED_LIMIT);
}

// ─── Default singleton wired with the live Drizzle client ──────────────────

const defaultRepository = new DrizzleMarketFeatureRepository();
export const marketFeatureService = {
  feature: (marketId: string, adminAddress: string, ctx?: FeatureCallContext) =>
    featureMarket(marketId, adminAddress, ctx, defaultRepository),
  unfeature: (marketId: string, adminAddress: string, ctx?: FeatureCallContext) =>
    unfeatureMarket(marketId, adminAddress, ctx, defaultRepository),
  list: (limit?: number) => listFeaturedMarkets(limit, defaultRepository),
};
