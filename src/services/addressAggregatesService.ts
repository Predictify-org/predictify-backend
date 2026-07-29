import { db } from "../db";
import { sql } from "drizzle-orm";

export interface AddressAggregate extends Record<string, unknown> {
  user_id: string;
  stellar_address: string;
  total_predictions: number;
  correct_predictions: number;
  accuracy_percentage: number;
  rank: number;
}

/**
 * Refresh the address_aggregates_mv materialized view concurrently.
 * Uses CONCURRENTLY to avoid locking reads during refresh.
 */
export async function refreshAddressAggregates(): Promise<void> {
  await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY address_aggregates_mv`);
}

/**
 * Get paginated address aggregates ordered by rank.
 */
export async function getAddressAggregates(
  limit: number = 50,
  offset: number = 0
): Promise<AddressAggregate[]> {
  const result = await db.execute<AddressAggregate>(
    sql`
      SELECT user_id, stellar_address, total_predictions, correct_predictions,
             accuracy_percentage, rank
      FROM address_aggregates_mv
      ORDER BY rank ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `
  );
  return result.rows;
}

/**
 * Look up a single address aggregate by stellar address.
 */
export async function getAddressAggregate(
  stellarAddress: string
): Promise<AddressAggregate | null> {
  const result = await db.execute<AddressAggregate>(
    sql`
      SELECT user_id, stellar_address, total_predictions, correct_predictions,
             accuracy_percentage, rank
      FROM address_aggregates_mv
      WHERE stellar_address = ${stellarAddress}
      LIMIT 1
    `
  );
  return result.rows[0] || null;
}

/**
 * Refresh the view then return paginated results.
 */
export async function getAddressAggregatesWithRefresh(
  limit: number = 50,
  offset: number = 0
): Promise<AddressAggregate[]> {
  await refreshAddressAggregates();
  return getAddressAggregates(limit, offset);
}
