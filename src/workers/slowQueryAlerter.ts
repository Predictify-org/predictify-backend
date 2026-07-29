import { v4 as uuidv4 } from "uuid";
import { Pool } from "pg";
import { logger } from "../config/logger";
import { env } from "../config/env";
import { getPool } from "../db/client";

interface SlowQuery {
  queryid: string | number;
  query: string;
  calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  max_exec_time: number;
  rows: number;
}

function sanitizeAndTruncateQuery(query: string, maxLength: number): string {
  let sanitized = query;
  // Remove or sanitize sensitive literals (simple approach)
  sanitized = sanitized.replace(/'[^']*'/g, "?").replace(/"[^"]*"/g, "?");
  // Truncate if necessary
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength - 3) + "...";
  }
  return sanitized;
}

export async function checkSlowQueries(pool: Pool = getPool()): Promise<SlowQuery[]> {
  const correlationId = uuidv4();
  logger.info({ correlationId }, "slow_query_alerter.check_start");

  const {
    SLOW_QUERY_ALERTER_MEAN_EXEC_TIME_THRESHOLD_MS,
    SLOW_QUERY_ALERTER_MAX_EXEC_TIME_THRESHOLD_MS,
    SLOW_QUERY_ALERTER_LIMIT,
    SLOW_QUERY_ALERTER_QUERY_MAX_LENGTH,
  } = env;

  const result = await pool.query(
    `
    SELECT
      queryid,
      query,
      calls,
      total_exec_time,
      mean_exec_time,
      max_exec_time,
      rows
    FROM pg_stat_statements
    WHERE mean_exec_time > $1 OR max_exec_time > $2
    ORDER BY mean_exec_time DESC
    LIMIT $3;
    `,
    [
      SLOW_QUERY_ALERTER_MEAN_EXEC_TIME_THRESHOLD_MS,
      SLOW_QUERY_ALERTER_MAX_EXEC_TIME_THRESHOLD_MS,
      SLOW_QUERY_ALERTER_LIMIT,
    ]
  );

  const slowQueries: SlowQuery[] = result.rows.map((row) => ({
    ...row,
    query: sanitizeAndTruncateQuery(row.query, SLOW_QUERY_ALERTER_QUERY_MAX_LENGTH),
  }));

  if (slowQueries.length > 0) {
    slowQueries.forEach((query) => {
      logger.warn(
        {
          correlationId,
          queryId: query.queryid,
          calls: query.calls,
          totalExecTime: query.total_exec_time,
          meanExecTime: query.mean_exec_time,
          maxExecTime: query.max_exec_time,
          rows: query.rows,
          query: query.query,
        },
        "slow_query_alerter.slow_query_detected"
      );
    });
  }

  logger.info({ correlationId, count: slowQueries.length }, "slow_query_alerter.check_complete");
  return slowQueries;
}

let intervalId: NodeJS.Timeout | null = null;

export function startSlowQueryAlerter(): NodeJS.Timeout | null {
  if (!env.SLOW_QUERY_ALERTER_ENABLED) {
    logger.info("slow_query_alerter.disabled");
    return null;
  }

  if (intervalId) {
    logger.warn("slow_query_alerter.already_started");
    return intervalId;
  }

  logger.info(
    {
      pollInterval: env.SLOW_QUERY_ALERTER_POLL_INTERVAL_MS,
      meanThreshold: env.SLOW_QUERY_ALERTER_MEAN_EXEC_TIME_THRESHOLD_MS,
      maxThreshold: env.SLOW_QUERY_ALERTER_MAX_EXEC_TIME_THRESHOLD_MS,
      limit: env.SLOW_QUERY_ALERTER_LIMIT,
    },
    "slow_query_alerter.starting"
  );

  // Run immediately on start
  checkSlowQueries().catch((err) => {
    logger.error({ err }, "slow_query_alerter.initial_check_failed");
  });

  intervalId = setInterval(() => {
    checkSlowQueries().catch((err) => {
      logger.error({ err }, "slow_query_alerter.check_failed");
    });
  }, env.SLOW_QUERY_ALERTER_POLL_INTERVAL_MS);

  return intervalId;
}

export function stopSlowQueryAlerter(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info("slow_query_alerter.stopped");
  }
}
