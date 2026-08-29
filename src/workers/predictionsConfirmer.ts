/**
 * predictionsConfirmer.ts
 *
 * Background worker that transitions pending predictions to confirmed (or
 * failed) by joining against indexer_events on txHash.
 *
 * After the indexer ingests a bet_placed event, the corresponding pending row
 * in predictions must transition to confirmed.  This worker:
 *
 *  1. Polls on a configurable interval (PREDICTION_CONFIRM_INTERVAL_MS).
 *  2. Finds pending predictions where a matching indexer_event exists (same
 *     txHash) and batch-updates them to "confirmed".
 *  3. For unmatched pending predictions, increments `confirmAttempts`.  After
 *     MAX_CONFIRM_ATTEMPTS (default 3) the row transitions to "failed" with a
 *     descriptive lastError.
 *  4. Emits a `prediction.confirmed` webhook event for each confirmed row.
 *
 * Design decisions
 * ────────────────
 *  • Batches are processed in a single database transaction per tick so that
 *    partial failures never leave inconsistent state.
 *  • Failed rows (attempts exhausted) do not block sibling rows — each
 *    row's fate is determined independently via bulk SQL.
 *  • The webhook is emitted exactly once per confirmed prediction via the
 *    `dispatchEvent` path; it fans out to all matching subscriptions.
 *  • The webhook emitter is injected as a constructor dependency so unit
 *    tests can mock the webhook path without module-level imports.
 *  • The repo uses DISTINCT when joining indexer_events to guard against
 *    duplicate prediction IDs when a txHash has multiple event rows.
 *  • The worker is structured as an injectable service class (for unit tests)
 *    and a standalone main() entry point (for production).
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { pool } from "../db/client";
import { predictions, indexerEvents } from "../db/schema";
import type { Db } from "../db";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum number of confirmation attempts before a prediction is marked as
 * permanently failed.  Used as the default in the Drizzle repo; the service
 * class accepts an override via constructor opts.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

// ─── Webhook emitter type ─────────────────────────────────────────────────────

/**
 * Function signature for emitting a webhook event.  Injected into the service
 * so it can be mocked in unit tests without module-level mocking.
 */
export type WebhookEmitter = (
  eventType: string,
  payload: Record<string, unknown>,
) => Promise<void>;

/** Default emitter that delegates to the production webhook dispatcher. */
export const defaultWebhookEmitter: WebhookEmitter = async (
  _eventType: string,
  _payload: Record<string, unknown>,
): Promise<void> => {
  // We need a db handle; in production the service creates one internally.
  // This function signature matches what dispatchEvent expects minus the db arg.
  // For the production path the caller provides the full db reference.
  throw new Error(
    "defaultWebhookEmitter should not be called directly — use the full signature",
  );
};

// ─── Repository interface ────────────────────────────────────────────────────

/**
 * Thin repository to decouple the confirmer service from Drizzle so it can
 * be unit-tested without a live database.
 */
export interface PredictionsConfirmerRepo {
  /**
   * Returns the unique IDs of pending predictions that have a matching txHash
   * in indexer_events.  These should be transitioned to "confirmed".
   * Uses DISTINCT to avoid duplicates when a txHash has multiple event rows.
   */
  findConfirmedCandidateIds(batchSize: number): Promise<string[]>;

  /**
   * For pending predictions without a matching indexer event, increment
   * confirmAttempts.  Only targets rows with confirmAttempts < maxAttempts.
   * Returns the number of rows updated.
   */
  incrementAttempts(maxAttempts: number, batchSize: number): Promise<number>;

  /**
   * Mark predictions whose confirmAttempts >= maxAttempts as "failed" with
   * a descriptive lastError.  Returns the IDs of the failed predictions.
   */
  markFailed(maxAttempts: number, batchSize: number): Promise<string[]>;

  /**
   * Batch-update the given prediction IDs to status "confirmed",
   * reset confirmAttempts to 0, and clear lastError.
   * Returns the full row data for the confirmed predictions.
   */
  confirmBatch(predictionIds: string[]): Promise<ConfirmedPrediction[]>;

  /**
   * Execute all three mutations (confirm, increment, fail) inside a single
   * database transaction.  Returns the aggregated results.
   */
  transactionalTick(
    batchSize: number,
    maxAttempts: number,
  ): Promise<{
    confirmed: ConfirmedPrediction[];
    incremented: number;
    failedIds: string[];
  }>;
}

/** Shape of a prediction row returned after confirmation. */
export interface ConfirmedPrediction {
  id: string;
  marketId: string;
  userId: string;
  outcome: string;
  amount: string;
  txHash: string;
  status: string;
}

// ─── Poll result ─────────────────────────────────────────────────────────────

export interface PollResult {
  processed: number;
  confirmed: number;
  incremented: number;
  failed: number;
  webhookErrors: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class PredictionsConfirmerService {
  private readonly repo: PredictionsConfirmerRepo;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly emitWebhook: (db: Db, eventType: string, payload: Record<string, unknown>) => Promise<void>;
  private readonly db: Db;

  constructor(
    repo: PredictionsConfirmerRepo,
    opts?: {
      batchSize?: number;
      maxAttempts?: number;
      db?: Db;
      /** Webhook emitter injected for testability. Defaults to dispatchEvent. */
      emitWebhook?: (db: Db, eventType: string, payload: Record<string, unknown>) => Promise<void>;
    },
  ) {
    this.repo = repo;
    this.batchSize = opts?.batchSize ?? env.PREDICTION_CONFIRM_BATCH_SIZE;
    this.maxAttempts = opts?.maxAttempts ?? env.PREDICTION_CONFIRM_MAX_ATTEMPTS;
    this.db = opts?.db ?? ({} as Db);
    // Default emitter uses dispatchEvent; lazily imported to avoid
    // pulling in BullMQ/Redis at load time (which causes test hangs
    // when the queue module is not mocked).
    this.emitWebhook =
      opts?.emitWebhook ??
      (async (db: Db, eventType: string, payload: Record<string, unknown>) => {
        const { dispatchEvent } = await import("../services/webhookDispatcher");
        await dispatchEvent(db, eventType, payload);
      });
  }

  /**
   * One poll cycle — all DB work inside a single transactional tick:
   *  1. Confirm pending predictions with matching indexer_events.
   *  2. Increment confirmAttempts for unmatched pending predictions.
   *  3. Mark predictions as failed when attempts >= maxAttempts.
   *  4. Emit `prediction.confirmed` webhooks for confirmed rows.
   */
  async pollOnce(): Promise<PollResult> {
    const correlationId = randomUUID();
    const start = Date.now();

    logger.info({ correlationId }, "predictions_confirmer: poll starting");

    // ── Single transactional DB tick ──────────────────────────────────────────
    const { confirmed, incremented, failedIds } =
      await this.repo.transactionalTick(this.batchSize, this.maxAttempts);

    const confirmedCount = confirmed.length;
    const failedCount = failedIds.length;

    if (confirmedCount > 0) {
      logger.info(
        { correlationId, confirmedCount },
        "predictions_confirmer: confirmed predictions",
      );
    }
    if (incremented > 0) {
      logger.info(
        { correlationId, incremented },
        "predictions_confirmer: incremented attempts",
      );
    }
    if (failedCount > 0) {
      logger.info(
        { correlationId, failedCount },
        "predictions_confirmer: marked failed",
      );
    }

    // ── Emit webhooks ─────────────────────────────────────────────────────────
    let webhookErrors = 0;
    for (const row of confirmed) {
      try {
        await this.emitWebhook(this.db, "prediction.confirmed", {
          predictionId: row.id,
          marketId: row.marketId,
          userId: row.userId,
          outcome: row.outcome,
          amount: row.amount,
          txHash: row.txHash,
        });
      } catch (err) {
        logger.error(
          { correlationId, predictionId: row.id, err },
          "predictions_confirmer: webhook dispatch failed",
        );
        webhookErrors++;
      }
    }

    const durationMs = Date.now() - start;
    const totalProcessed = confirmedCount + incremented + failedCount;

    logger.info(
      {
        correlationId,
        processed: totalProcessed,
        confirmed: confirmedCount,
        incremented,
        failed: failedCount,
        webhookErrors,
        durationMs,
      },
      "predictions_confirmer: poll complete",
    );

    return {
      processed: totalProcessed,
      confirmed: confirmedCount,
      incremented,
      failed: failedCount,
      webhookErrors,
    };
  }
}

// ─── Drizzle repository ────────────────────────────────────────────────────

/**
 * Production implementation of PredictionsConfirmerRepo backed by Drizzle ORM.
 * All three batch mutations run inside a single Drizzle transaction so partial
 * failures never leave the database in an inconsistent state.
 */
export class DrizzlePredictionsConfirmerRepo implements PredictionsConfirmerRepo {
  private readonly db: ReturnType<typeof drizzle>;

  constructor(db: ReturnType<typeof drizzle>) {
    this.db = db;
  }

  async findConfirmedCandidateIds(batchSize: number): Promise<string[]> {
    // DISTINCT ensures a prediction ID appears at most once even when its
    // txHash has multiple indexer_event rows (different op_index values).
    const rows = await this.db
      .selectDistinct({ id: predictions.id })
      .from(predictions)
      .innerJoin(
        indexerEvents,
        eq(predictions.txHash, indexerEvents.txHash),
      )
      .where(
        and(
          eq(predictions.status, "pending"),
          sql`${predictions.txHash} != ''`,
        ),
      )
      .limit(batchSize);

    return rows.map((r) => r.id);
  }

  async confirmBatch(predictionIds: string[]): Promise<ConfirmedPrediction[]> {
    if (predictionIds.length === 0) return [];

    const rows = await this.db
      .update(predictions)
      .set({
        status: "confirmed",
        confirmAttempts: 0,
        lastError: null,
      })
      .where(inArray(predictions.id, predictionIds))
      .returning({
        id: predictions.id,
        marketId: predictions.marketId,
        userId: predictions.userId,
        outcome: predictions.outcome,
        amount: predictions.amount,
        txHash: predictions.txHash,
        status: predictions.status,
      });

    return rows;
  }

  async incrementAttempts(
    maxAttempts: number,
    _batchSize: number,
  ): Promise<number> {
    const result = await this.db
      .update(predictions)
      .set({
        confirmAttempts: sql`${predictions.confirmAttempts} + 1`,
      })
      .where(
        and(
          eq(predictions.status, "pending"),
          sql`${predictions.txHash} != ''`,
          sql`${predictions.confirmAttempts} < ${maxAttempts}`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${indexerEvents}
            WHERE ${indexerEvents.txHash} = ${predictions.txHash}
          )`,
        ),
      );

    return result.rowCount ?? 0;
  }

  async markFailed(
    maxAttempts: number,
    _batchSize: number,
  ): Promise<string[]> {
    const rows = await this.db
      .update(predictions)
      .set({
        status: "failed",
        lastError: `No matching indexer event found after ${maxAttempts} attempts`,
      })
      .where(
        and(
          eq(predictions.status, "pending"),
          sql`${predictions.txHash} != ''`,
          sql`${predictions.confirmAttempts} >= ${maxAttempts}`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${indexerEvents}
            WHERE ${indexerEvents.txHash} = ${predictions.txHash}
          )`,
        ),
      )
      .returning({ id: predictions.id });

    return rows.map((r) => r.id);
  }

  async getPredictionsByIds(ids: string[]): Promise<ConfirmedPrediction[]> {
    if (ids.length === 0) return [];

    const rows = await this.db
      .select({
        id: predictions.id,
        marketId: predictions.marketId,
        userId: predictions.userId,
        outcome: predictions.outcome,
        amount: predictions.amount,
        txHash: predictions.txHash,
        status: predictions.status,
      })
      .from(predictions)
      .where(inArray(predictions.id, ids));

    return rows;
  }

  /**
   * Execute the full tick inside a single Drizzle transaction:
   *  1. Find candidate IDs (matching indexer_events) → confirm batch.
   *  2. Increment attempts for unmatched pending predictions.
   *  3. Mark attempts-exhausted predictions as failed.
   *
   * If the transaction rolls back, none of the mutations are persisted.
   */
  async transactionalTick(
    batchSize: number,
    maxAttempts: number,
  ): Promise<{
    confirmed: ConfirmedPrediction[];
    incremented: number;
    failedIds: string[];
  }> {
    return this.db.transaction(async (tx) => {
      // Use the same tx instance for all repo operations.
      const txRepo = new DrizzlePredictionsConfirmerRepo(
        tx as unknown as ReturnType<typeof drizzle>,
      );

      // Phase 1: Find and confirm matched predictions.
      const candidateIds = await txRepo.findConfirmedCandidateIds(batchSize);
      const confirmed = await txRepo.confirmBatch(candidateIds);

      // Phase 2: Increment attempts for unmatched predictions.
      const incremented = await txRepo.incrementAttempts(maxAttempts, batchSize);

      // Phase 3: Mark exhausted predictions as failed.
      const failedIds = await txRepo.markFailed(maxAttempts, batchSize);

      return { confirmed, incremented, failedIds };
    });
  }
}

// ─── Standalone entry point ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = drizzle(pool);
  const repo = new DrizzlePredictionsConfirmerRepo(db);
  const service = new PredictionsConfirmerService(repo, {
    db: db as unknown as Db,
  });
  const intervalMs = env.PREDICTION_CONFIRM_INTERVAL_MS;

  let shuttingDown = false;
  let activeTick: Promise<unknown> = Promise.resolve();

  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      { signal },
      "predictions_confirmer: shutdown requested; draining current tick",
    );
  };

  process.on("SIGTERM", requestShutdown);
  process.on("SIGINT", requestShutdown);

  logger.info(
    {
      intervalMs,
      batchSize: env.PREDICTION_CONFIRM_BATCH_SIZE,
      maxAttempts: env.PREDICTION_CONFIRM_MAX_ATTEMPTS,
    },
    "predictions_confirmer: worker started",
  );

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const onSignal = (): void => {
        clearTimeout(timer);
        resolve();
      };
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
    });

  while (!shuttingDown) {
    try {
      activeTick = service.pollOnce();
      await activeTick;
    } catch (err) {
      logger.error({ err }, "predictions_confirmer: tick failed");
    }
    if (shuttingDown) break;
    await sleep(intervalMs);
  }

  await activeTick.catch(() => undefined);
  await pool.end();
  logger.info({}, "predictions_confirmer: worker stopped");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, "predictions_confirmer: worker crashed");
      process.exit(1);
    });
}

// ─── Server integration ───────────────────────────────────────────────────────

/**
 * Start the predictions confirmer worker on the configured interval.
 *
 * Returns the interval handle so callers can cancel it during shutdown.
 * This function is imported and called from src/server.ts.
 */
export function startPredictionsConfirmer(
  intervalMs: number = env.PREDICTION_CONFIRM_INTERVAL_MS,
): NodeJS.Timeout {
  const db = drizzle(pool);
  const repo = new DrizzlePredictionsConfirmerRepo(db);
  const service = new PredictionsConfirmerService(repo, {
    db: db as unknown as Db,
  });

  // Run immediately on start, then on the interval.
  const tick = async (): Promise<void> => {
    try {
      await service.pollOnce();
    } catch (err) {
      logger.error({ err }, "predictions_confirmer: tick failed");
    }
  };

  tick();

  const id = setInterval(tick, intervalMs);
  id.unref();

  logger.info(
    {
      intervalMs,
      batchSize: env.PREDICTION_CONFIRM_BATCH_SIZE,
      maxAttempts: env.PREDICTION_CONFIRM_MAX_ATTEMPTS,
    },
    "predictions_confirmer: worker started (server mode)",
  );

  return id;
}
