import { invalidateMarketCache } from "../cache/marketsCache";
import { db, getDb } from "../db/client";
import { markets, marketAuditLog } from "../db/schema";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { emitMarketEvent, LogEvent } from "../logging/events";

/** Max character lengths enforced before hitting the DB */
const QUESTION_MAX_LEN = 500;
const METADATA_MAX_JSON_LEN = 4096;

export class MarketExistsError extends Error {
  status = 409;
  code = "market_exists";
  constructor() {
    super("Market already exists");
    Object.setPrototypeOf(this, MarketExistsError.prototype);
  }
}

/** Zod-validated shape coming in from the route layer */
export interface CreateMarketInput {
  id: string;
  question: string;
  resolutionTime: Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any;
}

/**
 * Creates an off-chain market shell keyed by the on-chain contract id.
 *
 * Idempotent on `id`: throws `MarketExistsError` (409) on duplicate.
 * The row is inserted with `status = "pending"`, `indexedLedger = 0`,
 * and `archived = false` so the indexer can later hydrate it.
 *
 * @param input - Validated market creation payload
 * @param adminAddress - Stellar address of the admin creating the market
 * @returns The persisted market row
 * @throws MarketExistsError if a market with the same id already exists
 */
export async function createMarket(
  input: CreateMarketInput,
  adminAddress: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { id, question, resolutionTime, metadata } = input;

  // Guard: validate lengths before hitting Postgres
  if (question.length > QUESTION_MAX_LEN) {
    const err = new Error(`question must be at most ${QUESTION_MAX_LEN} characters`);
    (err as any).status = 400;
    throw err;
  }

  if (metadata !== undefined) {
    const serialized = JSON.stringify(metadata);
    if (serialized.length > METADATA_MAX_JSON_LEN) {
      const err = new Error(`metadata JSON must be at most ${METADATA_MAX_JSON_LEN} characters`);
      (err as any).status = 400;
      throw err;
    }
  }

  // Check for duplicate before insert to return a clear 409
  const existing = await getDb()
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, id))
    .limit(1);

  if (existing.length > 0) {
    throw new MarketExistsError();
  }

  const [row] = await getDb()
    .insert(markets)
    .values({
      id,
      question,
      resolutionTime,
      metadata: metadata ?? null,
      status: "pending",
      indexedLedger: 0,
      archived: false,
      version: 1,
    })
    .returning();

  emitMarketEvent(LogEvent.MARKET_UPDATED, {
    marketId: id,
    actor: adminAddress,
    version: row.version,
    fieldsUpdated: ["id", "question", "resolutionTime", "metadata"],
  });

  return row;
}

export interface Market {
  id: string;
  question: string;
  status: string;
  resolutionTime: Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any;
  indexedLedger: number;
  archived: boolean;
  version: number;
}

export class VersionConflictError extends Error {
  status = 409;
  code = "version_conflict";
  constructor() {
    super("Version conflict");
    Object.setPrototypeOf(this, VersionConflictError.prototype);
  }
}

/**
 * Lists active markets with pagination.
 *
 * @param options.limit - Number of results to return (default: 50)
 * @param options.offset - Pagination offset (default: 0)
 * @returns Array of markets formatted with ISO timestamps
 * @throws Error if database query fails
 */
export async function listMarkets(options: { limit?: number; offset?: number } = {}): Promise<any[]> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const rows = await getDb()
    .select({
      id: markets.id,
      question: markets.question,
      status: markets.status,
      resolutionTime: markets.resolutionTime,
    })
    .from(markets)
    .where(eq(markets.archived, false))
    .orderBy(asc(markets.resolutionTime), asc(markets.id))
    .limit(limit)
    .offset(offset);

  if (!Array.isArray(rows)) {
    throw new Error("Unexpected response from database: rows is not an array");
  }

  return rows.map((r: any) => ({
    ...r,
    resolutionTime: r.resolutionTime instanceof Date ? r.resolutionTime.toISOString() : r.resolutionTime,
  }));
}

/**
 * Retrieves a single market by ID.
 *
 * @param id - The market ID to fetch
 * @returns Market object with formatted timestamp, or null if not found
 * @throws Error if database query fails
 */
export async function getMarketById(id: string): Promise<any | null> {
  if (!id || typeof id !== "string") {
    throw new Error("Market ID must be a non-empty string");
  }

  const rows = await getDb()
    .select({
      id: markets.id,
      question: markets.question,
      status: markets.status,
      resolutionTime: markets.resolutionTime,
    })
    .from(markets)
    .where(eq(markets.id, id))
    .limit(1);

  if (!Array.isArray(rows)) {
    throw new Error("Unexpected response from database: rows is not an array");
  }

  if (rows.length === 0) {
    return null;
  }

  const r = rows[0];
  return {
    ...r,
    resolutionTime: r.resolutionTime instanceof Date ? r.resolutionTime.toISOString() : r.resolutionTime,
  };
}

/**
 * Updates a market with optimistic locking via version field.
 *
 * Performs transactional update with:
 * - Version conflict detection (409)
 * - Audit log creation
 * - Structured event emission
 *
 * @param id - Market ID
 * @param patch - Fields to update (question, metadata)
 * @param expectedVersion - Current version for optimistic locking
 * @param adminAddress - Stellar address of the admin making the change
 * @returns Updated market object
 * @throws VersionConflictError if version mismatch
 * @throws Error with status 404 if market not found
 */
export async function updateMarket(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patch: { question?: string; metadata?: any },
  expectedVersion: number,
  adminAddress: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (!id || typeof id !== "string") {
    throw new Error("Market ID must be a non-empty string");
  }

  if (typeof expectedVersion !== "number" || expectedVersion < 0) {
    throw new Error("expectedVersion must be a non-negative number");
  }

  if (!adminAddress || typeof adminAddress !== "string") {
    throw new Error("adminAddress must be a non-empty string");
  }

  const result = await db.transaction(async (tx) => {
    const existing = await tx.select().from(markets).where(eq(markets.id, id)).limit(1);
    if (existing.length === 0) {
      const err = new Error("Market not found");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).status = 404;
      throw err;
    }

    const currentMarket = existing[0];
    if (currentMarket.version !== expectedVersion) {
      throw new VersionConflictError();
    }

    const newVersion = expectedVersion + 1;
    const updated = await tx
      .update(markets)
      .set({
        ...patch,
        version: newVersion,
      })
      .where(eq(markets.id, id))
      .returning();

    await tx.insert(marketAuditLog).values({
      marketId: id,
      adminAddress,
      action: "update",
      beforeState: {
        question: currentMarket.question,
        metadata: currentMarket.metadata,
        version: currentMarket.version,
      },
      afterState: {
        question: updated[0].question,
        metadata: updated[0].metadata,
        version: updated[0].version,
      },
    });

    // Invalidate related cache entries
    await invalidateMarketCache(id);
    return updated[0];
  });

  // Structured log event – emitted from service layer after successful commit.
  emitMarketEvent(LogEvent.MARKET_UPDATED, {
    marketId: id,
    actor: adminAddress,
    version: result.version,
    fieldsUpdated: Object.keys(patch),
  });

  return result;
}
