import { eq, and, gte, lte, asc } from "drizzle-orm";
import { db } from "../db";
import { predictions } from "../db/schema";
import { logger } from "../config/logger";

export interface ExportFilters {
  startDate?: Date;
  endDate?: Date;
}

export interface PredictionRow {
  id: string;
  marketId: string;
  userId: string;
  outcome: string;
  amount: string;
  txHash: string;
  status: string;
  result: string | null;
  createdAt: Date;
}

/**
 * Escapes a single field for CSV compliance.
 */
export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Formats a prediction row into a CSV line.
 */
export function formatPredictionAsCsv(row: PredictionRow): string {
  return [
    escapeCsvField(row.id),
    escapeCsvField(row.marketId),
    escapeCsvField(row.userId),
    escapeCsvField(row.outcome),
    escapeCsvField(row.amount),
    escapeCsvField(row.txHash),
    escapeCsvField(row.status),
    escapeCsvField(row.result),
    escapeCsvField(row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt),
  ].join(",") + "\n";
}

/**
 * Generator function that yields user predictions in chunks to avoid buffering
 * the entire dataset into memory.
 */
export async function* getPredictionsStream(
  userId: string,
  filters: ExportFilters,
  correlationId: string,
): AsyncGenerator<PredictionRow, void, unknown> {
  const batchSize = 500;
  let offset = 0;

  logger.info(
    { userId, filters, correlationId },
    "start_prediction_export_stream",
  );

  while (true) {
    const conditions = [eq(predictions.userId, userId)];

    if (filters.startDate) {
      conditions.push(gte(predictions.createdAt, filters.startDate));
    }
    if (filters.endDate) {
      conditions.push(lte(predictions.createdAt, filters.endDate));
    }

    const batch = await db
      .select({
        id: predictions.id,
        marketId: predictions.marketId,
        userId: predictions.userId,
        outcome: predictions.outcome,
        amount: predictions.amount,
        txHash: predictions.txHash,
        status: predictions.status,
        result: predictions.result,
        createdAt: predictions.createdAt,
      })
      .from(predictions)
      .where(and(...conditions))
      .orderBy(asc(predictions.createdAt))
      .limit(batchSize)
      .offset(offset);

    if (batch.length === 0) {
      logger.info(
        { userId, totalFetched: offset, correlationId },
        "prediction_export_stream_complete_empty",
      );
      break;
    }

    for (const row of batch) {
      yield row;
    }

    if (batch.length < batchSize) {
      logger.info(
        { userId, totalFetched: offset + batch.length, correlationId },
        "prediction_export_stream_complete",
      );
      break;
    }

    offset += batch.length;
  }
}
