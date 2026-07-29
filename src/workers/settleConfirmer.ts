import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNotNull, lte, or, isNull } from "drizzle-orm";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { pool, getDb } from "../db/client";
import { claims } from "../db/schema";
import {
  SettleConfirmerService,
  HttpHorizonClient,
  type SettleConfirmerRepo,
  type PendingClaim,
} from "../services/settleConfirmerService";

// ─── Drizzle repository ───────────────────────────────────────────────────────

class DrizzleSettleConfirmerRepo implements SettleConfirmerRepo {
  private readonly db: ReturnType<typeof drizzle>;

  constructor(db: ReturnType<typeof drizzle>) {
    this.db = db;
  }

  async getPendingSettlements(now: Date): Promise<PendingClaim[]> {
    const rows = await this.db
      .select({
        id: claims.id,
        settlementTx: claims.settlementTx,
        settleAttempts: claims.settleAttempts,
      })
      .from(claims)
      .where(
        and(
          eq(claims.status, "paid"),
          isNotNull(claims.settlementTx),
          or(
            isNull(claims.nextSettleAttemptAt),
            lte(claims.nextSettleAttemptAt, now),
          ),
        ),
      );

    return rows as PendingClaim[];
  }

  async markSettled(claimId: string, settledAt: Date): Promise<void> {
    await this.db
      .update(claims)
      .set({ status: "settled", settledAt })
      .where(eq(claims.id, claimId));
  }

  async scheduleRetry(
    claimId: string,
    nextAttemptAt: Date,
    settleAttempts: number,
  ): Promise<void> {
    await this.db
      .update(claims)
      .set({ settleAttempts, nextSettleAttemptAt: nextAttemptAt })
      .where(eq(claims.id, claimId));
  }

  async markFailed(claimId: string): Promise<void> {
    await this.db
      .update(claims)
      .set({ status: "rejected" })
      .where(eq(claims.id, claimId));
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createSettleConfirmerService(): SettleConfirmerService {
  const db = getDb();
  const repo = new DrizzleSettleConfirmerRepo(db);
  const horizon = new HttpHorizonClient(env.HORIZON_URL);
  return new SettleConfirmerService(
    repo,
    horizon,
    env.SETTLE_CONFIRMER_CONFIRMATION_LEDGERS,
  );
}

// ─── Standalone entry point ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const service = createSettleConfirmerService();

  let shuttingDown = false;
  let activeTick: Promise<unknown> = Promise.resolve();

  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "settle_confirmer: shutdown requested; draining current tick");
  };

  process.on("SIGTERM", requestShutdown);
  process.on("SIGINT", requestShutdown);

  logger.info(
    {
      horizon: env.HORIZON_URL,
      interval: env.SETTLE_CONFIRMER_POLL_INTERVAL_MS,
      confirmationLedgers: env.SETTLE_CONFIRMER_CONFIRMATION_LEDGERS,
    },
    "settle_confirmer: worker started",
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
      logger.error({ err }, "settle_confirmer: tick failed");
    }
    if (shuttingDown) break;
    await sleep(env.SETTLE_CONFIRMER_POLL_INTERVAL_MS);
  }

  await activeTick.catch(() => undefined);
  await pool.end();
  logger.info({}, "settle_confirmer: worker stopped");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, "settle_confirmer: worker crashed");
      process.exit(1);
    });
}
