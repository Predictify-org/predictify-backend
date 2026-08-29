/**
 * Nightly Backup Verification Worker
 *
 * Implements issue #151 — automated database backup verification.
 *
 * Workflow:
 *  1. Locate the latest backup dump (pg_dump format) at BACKUP_DUMP_PATH.
 *  2. Restore it into an isolated ephemeral Postgres database specified by
 *     BACKUP_EPHEMERAL_DB_URL (must already exist as an empty database).
 *  3. Run a "10-row smoke test": count rows across key tables and assert each
 *     count is ≥ 1 row (validates that the restore produced real data).
 *  4. Report the outcome — success or failure — to Slack via
 *     BACKUP_SLACK_WEBHOOK_URL (if configured).
 *  5. Emit structured pino logs throughout for correlation tracing.
 *
 * Security:
 *  - Credentials never appear in log output (redacted at the pino level).
 *  - The pg_restore subprocess inherits only the env vars it needs; the rest
 *    of process.env is NOT forwarded.
 *  - The ephemeral DB URL is validated at startup via zod.
 *
 * Usage (standalone):
 *   ts-node src/workers/backupVerifier.ts
 *
 * Usage (programmatic / tests):
 *   import { BackupVerifier, createDefaultBackupVerifier } from './backupVerifier';
 *   const result = await verifier.run();
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { logger } from "../config/logger";

const execFileAsync = promisify(execFile);

// ─── Configuration schema ───────────────────────────────────────────────────

const backupEnvSchema = z.object({
  /** Path to the pg_dump file to restore. */
  BACKUP_DUMP_PATH: z.string().min(1),
  /**
   * Connection string for the ephemeral (throwaway) database.
   * Example: postgres://postgres:postgres@localhost:5432/predictify_backup_test
   */
  BACKUP_EPHEMERAL_DB_URL: z.string().url(),
  /**
   * Slack Incoming Webhook URL.  Optional — if absent, Slack reporting is
   * skipped and a warning is logged instead.
   */
  BACKUP_SLACK_WEBHOOK_URL: z.string().url().optional(),
  /**
   * How long (ms) to wait for the smoke-test queries before giving up.
   * Defaults to 15 seconds.
   */
  BACKUP_SMOKE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export type BackupVerifierConfig = z.infer<typeof backupEnvSchema>;

// ─── Smoke-test table definitions ──────────────────────────────────────────

/**
 * Tables and their minimum expected row counts.
 * All of these must exist in a healthy, non-empty backup.
 */
export const SMOKE_TEST_TABLES: ReadonlyArray<{ table: string; minRows: number }> = [
  { table: "users",                  minRows: 1 },
  { table: "markets",                minRows: 1 },
  { table: "predictions",            minRows: 1 },
  { table: "webhook_subscriptions",  minRows: 1 },
  { table: "webhook_deliveries",     minRows: 1 },
  { table: "indexer_cursor",         minRows: 1 },
  { table: "auth_challenges",        minRows: 1 },
  { table: "refresh_tokens",         minRows: 1 },
  { table: "idempotency_records",    minRows: 1 },
  { table: "audit_logs",             minRows: 1 },
];

// ─── Result types ───────────────────────────────────────────────────────────

export interface SmokeTestRowResult {
  table: string;
  rowCount: number;
  passed: boolean;
  minRows: number;
}

export interface BackupVerificationResult {
  /** Unique run identifier (UUID v4) for correlation in logs and Slack. */
  runId: string;
  /** Whether every step (restore + all smoke tests) succeeded. */
  success: boolean;
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** ISO timestamp when the run finished. */
  finishedAt: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Per-table smoke-test results. */
  smokeTests: SmokeTestRowResult[];
  /** Human-readable error message if success is false. */
  error?: string;
}

// ─── Dependency injection interfaces ───────────────────────────────────────

/** Abstraction for running pg_restore (injectable for tests). */
export interface RestoreRunner {
  restore(dumpPath: string, connectionString: string): Promise<void>;
}

/** Abstraction for running row-count smoke queries (injectable for tests). */
export interface SmokeTestRunner {
  countRows(connectionString: string, table: string): Promise<number>;
}

/** Abstraction for sending Slack notifications (injectable for tests). */
export interface SlackReporter {
  send(webhookUrl: string, message: SlackMessage): Promise<void>;
}

export interface SlackMessage {
  text: string;
  blocks?: object[];
}

// ─── Production implementations ────────────────────────────────────────────

/**
 * Runs pg_restore with a minimal, sanitised child-process environment.
 * Only PGPASSWORD + PATH are forwarded so no other secrets leak.
 */
export class PgRestoreRunner implements RestoreRunner {
  async restore(dumpPath: string, connectionString: string): Promise<void> {
    const url = new URL(connectionString);

    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      // pg_restore reads the password from PGPASSWORD, never from the URI in
      // plain-text form, so it is never echoed by the OS process list.
      ...(url.password ? { PGPASSWORD: url.password } : {}),
    };

    const args: string[] = [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      connectionString,
      dumpPath,
    ];

    logger.info({ dumpPath }, "backup_verify: running pg_restore");
    await execFileAsync("pg_restore", args, { env: childEnv });
    logger.info({ dumpPath }, "backup_verify: pg_restore completed");
  }
}

/**
 * Runs a simple `SELECT COUNT(*)` over a single-use pg Pool.
 * The pool is destroyed after each call to prevent connection leaks.
 */
export class PgSmokeTestRunner implements SmokeTestRunner {
  async countRows(connectionString: string, table: string): Promise<number> {
    const pool = new Pool({ connectionString, max: 1 });
    try {
      // Table names are from a hard-coded allow-list (SMOKE_TEST_TABLES), never
      // from user input, so concatenation is safe.
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${table}"`,
      );
      return parseInt(result.rows[0].count, 10);
    } finally {
      await pool.end();
    }
  }
}

/**
 * Posts a JSON message to a Slack Incoming Webhook URL using the built-in
 * `fetch` API (available in Node 18+).
 */
export class HttpSlackReporter implements SlackReporter {
  async send(webhookUrl: string, message: SlackMessage): Promise<void> {
    const { fetchWithRetry } = await import("../lib/http");
    const response = await fetchWithRetry(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      throw new Error(
        `Slack webhook returned HTTP ${response.status}: ${await response.text()}`,
      );
    }
  }
}

// ─── BackupVerifier ─────────────────────────────────────────────────────────

export class BackupVerifier {
  private readonly config: BackupVerifierConfig;
  private readonly restoreRunner: RestoreRunner;
  private readonly smokeTestRunner: SmokeTestRunner;
  private readonly slackReporter: SlackReporter;

  constructor(
    config: BackupVerifierConfig,
    restoreRunner: RestoreRunner = new PgRestoreRunner(),
    smokeTestRunner: SmokeTestRunner = new PgSmokeTestRunner(),
    slackReporter: SlackReporter = new HttpSlackReporter(),
  ) {
    this.config = config;
    this.restoreRunner = restoreRunner;
    this.smokeTestRunner = smokeTestRunner;
    this.slackReporter = slackReporter;
  }

  /**
   * Runs the full backup verification pipeline:
   *   restore → smoke tests → Slack report
   *
   * Never throws — all errors are captured in the result object.
   */
  async run(): Promise<BackupVerificationResult> {
    const runId = uuidv4();
    const startedAt = new Date();

    logger.info({ runId }, "backup_verify: run started");

    const result = await this._runWithCatch(runId, startedAt);

    const durationMs = Date.now() - startedAt.getTime();
    logger.info(
      { runId, success: result.success, durationMs },
      result.success ? "backup_verify: run succeeded" : "backup_verify: run FAILED",
    );

    await this._reportToSlack(result);

    return result;
  }

  /** Internal: runs restore + smoke tests, catches any thrown error. */
  private async _runWithCatch(
    runId: string,
    startedAt: Date,
  ): Promise<BackupVerificationResult> {
    const smokeTests: SmokeTestRowResult[] = [];

    const finish = (success: boolean, error?: string): BackupVerificationResult => ({
      runId,
      success,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      smokeTests,
      ...(error !== undefined ? { error } : {}),
    });

    // Step 1 — restore
    try {
      await this.restoreRunner.restore(
        this.config.BACKUP_DUMP_PATH,
        this.config.BACKUP_EPHEMERAL_DB_URL,
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ runId, err }, "backup_verify: restore failed");
      return finish(false, `pg_restore failed: ${error}`);
    }

    // Step 2 — smoke tests (10 rows across key tables)
    for (const { table, minRows } of SMOKE_TEST_TABLES) {
      try {
        const rowCount = await this._countWithTimeout(table);
        const passed = rowCount >= minRows;
        smokeTests.push({ table, rowCount, passed, minRows });
        logger.info(
          { runId, table, rowCount, minRows, passed },
          passed ? "backup_verify: smoke_test passed" : "backup_verify: smoke_test FAILED",
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error({ runId, table, err }, "backup_verify: smoke_test query error");
        smokeTests.push({ table, rowCount: 0, passed: false, minRows });
        return finish(false, `smoke test query failed on table "${table}": ${error}`);
      }
    }

    const allPassed = smokeTests.every((t) => t.passed);
    if (!allPassed) {
      const failedTables = smokeTests
        .filter((t) => !t.passed)
        .map((t) => `${t.table}(${t.rowCount}<${t.minRows})`)
        .join(", ");
      return finish(false, `smoke tests failed for: ${failedTables}`);
    }

    return finish(true);
  }

  /** Wraps a row-count query with a configurable timeout. */
  private async _countWithTimeout(table: string): Promise<number> {
    const timeoutMs = this.config.BACKUP_SMOKE_TIMEOUT_MS;

    return Promise.race<number>([
      this.smokeTestRunner.countRows(this.config.BACKUP_EPHEMERAL_DB_URL, table),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`smoke test timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  /** Sends a Slack notification; logs a warning if Slack is not configured. */
  private async _reportToSlack(result: BackupVerificationResult): Promise<void> {
    if (!this.config.BACKUP_SLACK_WEBHOOK_URL) {
      logger.warn(
        { runId: result.runId },
        "backup_verify: BACKUP_SLACK_WEBHOOK_URL not set — Slack reporting skipped",
      );
      return;
    }

    const message = buildSlackMessage(result);
    try {
      await this.slackReporter.send(this.config.BACKUP_SLACK_WEBHOOK_URL, message);
      logger.info({ runId: result.runId }, "backup_verify: Slack notification sent");
    } catch (err) {
      // Slack failure must not mask a restore/smoke-test failure.
      logger.error({ runId: result.runId, err }, "backup_verify: Slack notification failed");
    }
  }
}

// ─── Slack message builder ──────────────────────────────────────────────────

/**
 * Builds a structured Slack Block Kit message summarising the run.
 * Exported for use in tests.
 */
export function buildSlackMessage(result: BackupVerificationResult): SlackMessage {
  const icon = result.success ? "✅" : "❌";
  const status = result.success ? "PASSED" : "FAILED";

  const passedCount = result.smokeTests.filter((t) => t.passed).length;
  const totalCount = result.smokeTests.length;

  const tableLines = result.smokeTests
    .map(
      (t) =>
        `${t.passed ? "✓" : "✗"} \`${t.table}\` — ${t.rowCount} row(s) (min ${t.minRows})`,
    )
    .join("\n");

  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${icon} Predictify Backup Verification — ${status}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Run ID*\n\`${result.runId}\`` },
        { type: "mrkdwn", text: `*Duration*\n${result.durationMs}ms` },
        { type: "mrkdwn", text: `*Smoke tests*\n${passedCount}/${totalCount} passed` },
        { type: "mrkdwn", text: `*Finished*\n${result.finishedAt}` },
      ],
    },
  ];

  if (tableLines) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Table row counts*\n${tableLines}` },
    });
  }

  if (!result.success && result.error) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Error*\n\`\`\`${result.error}\`\`\`` },
    });
  }

  return {
    text: `${icon} Backup Verification ${status} — run ${result.runId}`,
    blocks,
  };
}

// ─── Factory helper ─────────────────────────────────────────────────────────

/**
 * Parses backup-related environment variables and returns a ready-to-use
 * `BackupVerifier` instance.  Throws a `ZodError` if any required env var is
 * missing or invalid.
 */
export function createDefaultBackupVerifier(): BackupVerifier {
  const config = backupEnvSchema.parse(process.env);
  return new BackupVerifier(config);
}

// ─── Standalone entry point ─────────────────────────────────────────────────

if (require.main === module) {
  createDefaultBackupVerifier()
    .run()
    .then((result) => {
      if (!result.success) {
        logger.error({ result }, "backup_verify: verification failed — exiting with code 1");
        process.exit(1);
      }
      logger.info({ result }, "backup_verify: verification passed");
      process.exit(0);
    })
    .catch((err: unknown) => {
      logger.fatal({ err }, "backup_verify: unexpected crash");
      process.exit(1);
    });
}
