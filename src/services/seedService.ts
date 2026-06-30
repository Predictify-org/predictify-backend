/**
 * @module seedService
 *
 * Owns the "seed a small batch of sample markets" workflow used for E2E tests
 * and demos in **non-production** environments (development / staging / test).
 *
 * Responsibilities:
 *  - Insert a fixed, deterministic batch of sample markets so E2E suites and
 *    demos have predictable data to work against.
 *  - Be IDEMPOTENT: re-running the seed never creates duplicates. Each sample
 *    market has a stable primary key and we rely on `ON CONFLICT DO NOTHING`,
 *    so a second call inserts zero rows and reports them as "skipped".
 *  - TRACK seeded markets: every seeded row is tagged with
 *    `metadata.seeded = true` plus the batch version, so they can be listed,
 *    audited, and distinguished from real (indexed / admin-created) markets.
 *  - Refuse to run in production (defense-in-depth — the route is also hidden
 *    in production; see src/routes/admin/seed.ts).
 *  - Emit a structured `market.created` log event per inserted row and write a
 *    compliance audit entry, both carrying a correlation id.
 *
 * See docs/seed.md for the operator-facing documentation.
 */

import { asc, sql } from "drizzle-orm";
import { db } from "../db/client";
import { markets } from "../db/schema";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { createAuditLog } from "./auditService";
import { emitMarketEvent, LogEvent } from "../logging/events";
import { getRequestId } from "../lib/requestContext";

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Bumping this invalidates "what this batch should contain" for tracking
 * purposes. Existing seeded rows keep their recorded version, so you can tell
 * which batch produced them.
 */
export const SEED_BATCH_VERSION = 1;

/** Status assigned to freshly seeded markets — matches the "open for predictions" state. */
const SEED_MARKET_STATUS = "open";

/** Ledger recorded for seeded rows. They are not on-chain, so 0 is a sentinel. */
const SEED_INDEXED_LEDGER = 0;

/** One day in milliseconds — used to spread sample resolution times into the future. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ─── Sample data ────────────────────────────────────────────────────────────

interface SampleMarketSeed {
  /** Stable primary key — the source of idempotency. */
  id: string;
  question: string;
  /** Days from "now" until the market resolves. */
  resolutionInDays: number;
  /** Possible outcomes, stored in metadata for demo UIs. */
  outcomes: readonly string[];
}

/**
 * The fixed sample batch. Stable ids (`seed-market-NNN`) make the seed
 * idempotent and easy to reference from E2E specs.
 */
export const SAMPLE_MARKETS: readonly SampleMarketSeed[] = [
  {
    id: "seed-market-001",
    question: "Will BTC close above $100k by year end?",
    resolutionInDays: 30,
    outcomes: ["yes", "no"],
  },
  {
    id: "seed-market-002",
    question: "Will the next Stellar protocol upgrade ship on time?",
    resolutionInDays: 14,
    outcomes: ["yes", "no"],
  },
  {
    id: "seed-market-003",
    question: "Which team wins the demo hackathon?",
    resolutionInDays: 7,
    outcomes: ["alpha", "bravo", "charlie"],
  },
  {
    id: "seed-market-004",
    question: "Will daily active users exceed 10k this quarter?",
    resolutionInDays: 60,
    outcomes: ["yes", "no"],
  },
  {
    id: "seed-market-005",
    question: "Will it rain in the demo city on launch day?",
    resolutionInDays: 3,
    outcomes: ["yes", "no"],
  },
];

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when seeding is attempted in production. The route layer hides the
 * endpoint entirely in production; this is a second, independent guard so the
 * service can never write sample data to a prod database even if called
 * directly.
 */
export class SeedNotAllowedError extends Error {
  readonly status = 403;
  readonly code = "seed_not_allowed";
  constructor() {
    super("Market seeding is disabled in production");
    this.name = "SeedNotAllowedError";
  }
}

// ─── Public shapes ──────────────────────────────────────────────────────────

export interface SeededMarketSummary {
  id: string;
  question: string;
  status: string;
  resolutionTime: string;
}

export interface SeedResult {
  /** How many sample markets the batch defines. */
  requested: number;
  /** How many rows this call actually inserted. */
  inserted: number;
  /** How many rows already existed and were left untouched (idempotent skip). */
  skipped: number;
  /** Batch version that produced this seed. */
  batchVersion: number;
  /** Ids inserted by THIS call (empty on a repeat run). */
  insertedIds: string[];
  /** Every seeded market currently tracked in the DB (the full batch). */
  markets: SeededMarketSummary[];
}

export interface SeedCallContext {
  /** Stellar address of the admin initiating the seed — recorded in the audit trail. */
  adminAddress: string;
  /** Real client IP — passed so audit_logs.ip is accurate. */
  ip: string;
  /** Optional explicit correlation id; falls back to the ALS-derived request id. */
  correlationId?: string;
}

/** Row shape inserted into the `markets` table. */
interface NewSeedMarketRow {
  id: string;
  question: string;
  status: string;
  resolutionTime: Date;
  indexedLedger: number;
  metadata: {
    seeded: true;
    seedBatchVersion: number;
    outcomes: readonly string[];
  };
}

// ─── Repository contract ────────────────────────────────────────────────────

export interface SeedRepository {
  /**
   * Insert the given sample rows, skipping any whose id already exists.
   * Returns the ids that were ACTUALLY inserted (Postgres `ON CONFLICT DO
   * NOTHING ... RETURNING` only returns newly-inserted rows).
   */
  insertSampleMarkets(rows: NewSeedMarketRow[]): Promise<string[]>;
  /** List every market tagged as seeded, ordered by id. */
  listSeededMarkets(): Promise<SeededMarketSummary[]>;
}

// ─── Repository implementation (Drizzle) ────────────────────────────────────

export class DrizzleSeedRepository implements SeedRepository {
  constructor(private readonly database: typeof db = db) {}

  async insertSampleMarkets(rows: NewSeedMarketRow[]): Promise<string[]> {
    if (rows.length === 0) return [];
    const inserted = await this.database
      .insert(markets)
      .values(rows)
      .onConflictDoNothing({ target: markets.id })
      .returning({ id: markets.id });
    return inserted.map((r) => r.id);
  }

  async listSeededMarkets(): Promise<SeededMarketSummary[]> {
    const rows = await this.database
      .select({
        id: markets.id,
        question: markets.question,
        status: markets.status,
        resolutionTime: markets.resolutionTime,
      })
      .from(markets)
      // metadata is jsonb; `->> 'seeded'` yields the text 'true' for our tag.
      .where(sql`${markets.metadata} ->> 'seeded' = 'true'`)
      .orderBy(asc(markets.id));

    return rows.map((r) => ({
      id: r.id,
      question: r.question,
      status: r.status,
      resolutionTime:
        r.resolutionTime instanceof Date
          ? r.resolutionTime.toISOString()
          : String(r.resolutionTime),
    }));
  }
}

// ─── Service API ────────────────────────────────────────────────────────────

/** Build the concrete rows for the sample batch relative to `now`. */
function buildSeedRows(now: number): NewSeedMarketRow[] {
  return SAMPLE_MARKETS.map((m) => ({
    id: m.id,
    question: m.question,
    status: SEED_MARKET_STATUS,
    resolutionTime: new Date(now + m.resolutionInDays * ONE_DAY_MS),
    indexedLedger: SEED_INDEXED_LEDGER,
    metadata: {
      seeded: true,
      seedBatchVersion: SEED_BATCH_VERSION,
      outcomes: m.outcomes,
    },
  }));
}

/**
 * Seed the fixed batch of sample markets. Idempotent and non-prod only.
 *
 * @throws SeedNotAllowedError when NODE_ENV is "production".
 */
export async function seedSampleMarkets(
  ctx: SeedCallContext,
  repo: SeedRepository = new DrizzleSeedRepository(),
): Promise<SeedResult> {
  if (env.NODE_ENV === "production") {
    throw new SeedNotAllowedError();
  }

  const correlationId = ctx.correlationId ?? getRequestId();
  const rows = buildSeedRows(Date.now());

  const insertedIds = await repo.insertSampleMarkets(rows);
  const seeded = await repo.listSeededMarkets();

  for (const id of insertedIds) {
    emitMarketEvent(LogEvent.MARKET_CREATED, {
      marketId: id,
      actor: ctx.adminAddress,
      correlationId,
      seeded: true,
      seedBatchVersion: SEED_BATCH_VERSION,
    });
  }

  await createAuditLog({
    action: "admin.seed_markets",
    walletAddress: ctx.adminAddress,
    ip: ctx.ip,
    correlationId,
  });

  logger.info(
    {
      correlationId,
      adminAddress: ctx.adminAddress,
      requested: rows.length,
      inserted: insertedIds.length,
      skipped: rows.length - insertedIds.length,
      batchVersion: SEED_BATCH_VERSION,
    },
    "admin.seed_markets",
  );

  return {
    requested: rows.length,
    inserted: insertedIds.length,
    skipped: rows.length - insertedIds.length,
    batchVersion: SEED_BATCH_VERSION,
    insertedIds,
    markets: seeded,
  };
}

// ─── Default singleton wired with the live Drizzle client ───────────────────

const defaultRepository = new DrizzleSeedRepository();
export const seedService = {
  seed: (ctx: SeedCallContext) => seedSampleMarkets(ctx, defaultRepository),
  listSeeded: () => defaultRepository.listSeededMarkets(),
};
