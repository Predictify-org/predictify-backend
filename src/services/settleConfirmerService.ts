import { randomUUID } from "crypto";
import { logger } from "../config/logger";
import {
  settleConfirmerPollsTotal,
  settleConfirmerSettledTotal,
  settleConfirmerFailedTotal,
} from "../metrics/registry";

// ─── Backoff schedule ─────────────────────────────────────────────────────────

/**
 * Fixed backoff schedule (in milliseconds) for re-checking a claim's
 * transaction finality.  Each index corresponds to the number of
 * previous attempts made (0-indexed).
 *
 *   attempt 0 →  5 s   (first check)
 *   attempt 1 → 15 s
 *   attempt 2 → 30 s
 *   attempt 3 →  1 m
 *   attempt 4 →  5 m
 *   attempt 5 → 15 m
 *   attempt 6 →  1 h   (last)
 *
 * After 7 failed attempts the claim is marked as permanently failed.
 */
export const SETTLE_BACKOFF_MS: readonly number[] = [
  5 * 1_000,
  15 * 1_000,
  30 * 1_000,
  60 * 1_000,
  5 * 60 * 1_000,
  15 * 60 * 1_000,
  60 * 60 * 1_000,
] as const;

export const MAX_SETTLE_ATTEMPTS = SETTLE_BACKOFF_MS.length; // 7

// ─── Public types ─────────────────────────────────────────────────────────────

/** Minimal claim data the service needs from the repository. */
export interface PendingClaim {
  id: string;
  settlementTx: string;
  settleAttempts: number;
}

export interface TransactionInfo {
  successful: boolean;
  ledger: number;
}

/** Repository abstraction — injectable for tests. */
export interface SettleConfirmerRepo {
  /** Returns claims in status "paid" that are due for a finality check. */
  getPendingSettlements(now: Date): Promise<PendingClaim[]>;
  /** Marks a claim as settled with the given timestamp. */
  markSettled(claimId: string, settledAt: Date): Promise<void>;
  /** Schedules a retry with an incremented attempt count and next-check timestamp. */
  scheduleRetry(claimId: string, nextAttemptAt: Date, settleAttempts: number): Promise<void>;
  /** Marks a claim as permanently failed. */
  markFailed(claimId: string): Promise<void>;
}

/** Horizon transaction lookup abstraction — injectable for tests. */
export interface HorizonClient {
  getTransaction(txHash: string): Promise<TransactionInfo>;
  getCurrentLedger(): Promise<number>;
}

// ─── Backoff helper ───────────────────────────────────────────────────────────

/**
 * Returns the next retry Date based on the number of attempts already made.
 * Returns `null` when `attempts >= MAX_SETTLE_ATTEMPTS`, indicating the
 * claim should be marked permanently failed.
 */
export function calculateNextRetry(attempts: number): Date | null {
  if (attempts >= MAX_SETTLE_ATTEMPTS) return null;
  const delayMs = SETTLE_BACKOFF_MS[attempts];
  return new Date(Date.now() + delayMs);
}

// ─── Poll result ──────────────────────────────────────────────────────────────

export interface PollResult {
  processed: number;
  settled: number;
  failed: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class SettleConfirmerService {
  private readonly repo: SettleConfirmerRepo;
  private readonly horizon: HorizonClient;
  private readonly confirmationLedgers: number;

  constructor(
    repo: SettleConfirmerRepo,
    horizon: HorizonClient,
    confirmationLedgers: number,
  ) {
    this.repo = repo;
    this.horizon = horizon;
    this.confirmationLedgers = confirmationLedgers;
  }

  /**
   * One poll cycle:
   *  1. Fetch all pending claims that are due for a finality check.
   *  2. For each, query Horizon for the tx status and current ledger.
   *  3. If the tx is successful and has enough confirmations → mark settled.
   *  4. Otherwise schedule a retry (or mark failed if max attempts reached).
   */
  async pollOnce(): Promise<PollResult> {
    const correlationId = randomUUID();
    const now = new Date();

    logger.info({ correlationId }, "settle_confirmer: poll starting");

    const pending = await this.repo.getPendingSettlements(now);
    logger.info(
      { correlationId, count: pending.length },
      "settle_confirmer: pending claims fetched",
    );

    let settled = 0;
    let failed = 0;

    for (const claim of pending) {
      const outcome = await this._processClaim(claim, correlationId);
      if (outcome === "settled") settled++;
      else if (outcome === "failed") failed++;
    }

    logger.info(
      { correlationId, processed: pending.length, settled, failed },
      "settle_confirmer: poll complete",
    );

    settleConfirmerPollsTotal.inc();
    settleConfirmerSettledTotal.inc(settled);
    settleConfirmerFailedTotal.inc(failed);

    return { processed: pending.length, settled, failed };
  }

  /**
   * Process a single pending claim.
   *
   * Returns the outcome: "settled" (confirmed), "retried" (scheduled for
   * later), or "failed" (terminal).
   */
  private async _processClaim(
    claim: PendingClaim,
    correlationId: string,
  ): Promise<"settled" | "retried" | "failed"> {
    const logCtx = {
      correlationId,
      claimId: claim.id,
      txHash: claim.settlementTx,
      attempt: claim.settleAttempts + 1,
    };

    let txInfo: TransactionInfo;
    let currentLedger: number;

    try {
      [txInfo, currentLedger] = await Promise.all([
        this.horizon.getTransaction(claim.settlementTx),
        this.horizon.getCurrentLedger(),
      ]);
    } catch (err) {
      logger.error(
        { ...logCtx, err },
        "settle_confirmer: Horizon request failed, scheduling retry",
      );
      return this._scheduleRetryOrFail(claim, correlationId);
    }

    if (!txInfo.successful) {
      logger.warn(
        { ...logCtx, ledger: txInfo.ledger },
        "settle_confirmer: transaction not successful on-chain — marking failed",
      );
      await this.repo.markFailed(claim.id);
      return "failed";
    }

    const confirmations = currentLedger - txInfo.ledger;

    if (confirmations >= this.confirmationLedgers) {
      logger.info(
        { ...logCtx, ledger: txInfo.ledger, confirmations },
        "settle_confirmer: settlement confirmed",
      );
      await this.repo.markSettled(claim.id, new Date());
      return "settled";
    }

    logger.info(
      {
        ...logCtx,
        ledger: txInfo.ledger,
        confirmations,
        required: this.confirmationLedgers,
      },
      "settle_confirmer: not yet enough confirmations, scheduling retry",
    );

    return this._scheduleRetryOrFail(claim, correlationId);
  }

  /**
   * Schedule the next retry using the exponential backoff schedule.
   * If the claim has exhausted all attempts, mark it as permanently failed.
   */
  private async _scheduleRetryOrFail(
    claim: PendingClaim,
    correlationId: string,
  ): Promise<"retried" | "failed"> {
    const nextAttempt = calculateNextRetry(claim.settleAttempts + 1);

    if (nextAttempt === null) {
      logger.warn(
        { correlationId, claimId: claim.id, attempts: claim.settleAttempts + 1 },
        "settle_confirmer: max attempts reached — marking failed",
      );
      await this.repo.markFailed(claim.id);
      return "failed";
    }

    logger.info(
      {
        correlationId,
        claimId: claim.id,
        nextAttemptAt: nextAttempt.toISOString(),
        attempt: claim.settleAttempts + 1,
      },
      "settle_confirmer: scheduling retry",
    );

    await this.repo.scheduleRetry(claim.id, nextAttempt, claim.settleAttempts + 1);
    return "retried";
  }
}

// ─── Default Horizon client (production) ──────────────────────────────────────

/**
 * Production Horizon client that uses `fetch` to call the Horizon REST API.
 */
export class HttpHorizonClient implements HorizonClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async getTransaction(txHash: string): Promise<TransactionInfo> {
    const url = `${this.baseUrl}/transactions/${txHash}`;
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Transaction not found: ${txHash}`);
      }
      throw new Error(
        `Horizon transaction lookup failed: HTTP ${response.status}`,
      );
    }

    const body = (await response.json()) as {
      successful: boolean;
      ledger: number;
    };

    return {
      successful: body.successful,
      ledger: body.ledger,
    };
  }

  async getCurrentLedger(): Promise<number> {
    const url = this.baseUrl;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Horizon root request failed: HTTP ${response.status}`,
      );
    }

    const body = (await response.json()) as {
      core_latest_ledger: number;
    };

    return body.core_latest_ledger;
  }
}
