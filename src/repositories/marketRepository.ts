  
/* eslint-disable @typescript-eslint/no-unused-vars */ 
  
/* eslint-disable @typescript-eslint/no-explicit-any */ 
import { sql } from "drizzle-orm";
import { db, getDb } from "../db/client";

export interface MarketSearchQuery {
  query: string;
  limit?: number;
  offset?: number;
}

export interface MarketSearchResult {
  data: any[];
  total: number;
  fallback: boolean;
}

function mapRow(row: any) {
  const { full_total, rank_score, sim_score, ...rest } = row;
  return {
    ...rest,
    resolutionTime: rest.resolutionTime instanceof Date ? rest.resolutionTime.toISOString() : rest.resolutionTime,
  };
}

/**
 * Searches markets using Postgres Full-Text Search (tsvector) with GIN indexing.
 * If FTS returns 0 rows, falls back to pg_trgm trigram similarity matching.
 */
export async function searchMarkets(params: MarketSearchQuery): Promise<MarketSearchResult> {
  const queryText = (params.query || "").trim();
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);

  if (!queryText) {
    return { data: [], total: 0, fallback: false };
  }

  // 1. Full-Text Search rank ordering
  const ftsSql = sql`
    SELECT count(*) OVER()::int AS full_total,
           id, question, status, resolution_outcome AS "resolutionOutcome",
           resolution_time AS "resolutionTime", winning_outcome AS "winningOutcome",
           metadata, indexed_ledger AS "indexedLedger", archived, version,
           ts_rank(to_tsvector('english', coalesce(question, '')), plainto_tsquery('english', ${queryText})) AS rank_score
    FROM markets
    WHERE archived = false
      AND (
        to_tsvector('english', coalesce(question, '')) @@ plainto_tsquery('english', ${queryText})
        OR (search_vector IS NOT NULL AND search_vector @@ plainto_tsquery('english', ${queryText}))
      )
    ORDER BY rank_score DESC, id ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  try {
    const ftsRes = await db.execute(ftsSql);
    const ftsRows = (ftsRes as any).rows ?? ftsRes;

    if (Array.isArray(ftsRows) && ftsRows.length > 0) {
      const total = Number(ftsRows[0]?.full_total ?? ftsRows.length);
      const data = ftsRows.map(mapRow);
      return { data, total, fallback: false };
    }
  } catch (e) {
    // Ignore if search_vector column doesn't exist yet before migration
  }

  // 2. Trigram fallback (pg_trgm)
  const trgmSql = sql`
    SELECT count(*) OVER()::int AS full_total,
           id, question, status, resolution_outcome AS "resolutionOutcome",
           resolution_time AS "resolutionTime", winning_outcome AS "winningOutcome",
           metadata, indexed_ledger AS "indexedLedger", archived, version,
           similarity(question, ${queryText}) AS sim_score
    FROM markets
    WHERE archived = false
      AND (question % ${queryText} OR question ILIKE ${'%' + queryText + '%'})
    ORDER BY similarity(question, ${queryText}) DESC, id ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  try {
    const trgmRes = await db.execute(trgmSql);
    const trgmRows = (trgmRes as any).rows ?? trgmRes;

    if (Array.isArray(trgmRows) && trgmRows.length > 0) {
      const total = Number(trgmRows[0]?.full_total ?? trgmRows.length);
      const data = trgmRows.map(mapRow);
      return { data, total, fallback: true };
    }
  } catch (e) {
    // Fallback if extension pg_trgm not installed in test environment
  }

  return { data: [], total: 0, fallback: false };
}

export interface MarketTag {
  tag: string;
  count: number;
}

/**
 * Gets market tags with counts from non-archived markets
 */
export async function getMarketTags(): Promise<MarketTag[]> {
  // Use PostgreSQL query to unnest tags from metadata.tags
  const tagsSql = sql`
    SELECT
      tag,
      COUNT(*) AS count
    FROM markets,
         jsonb_array_elements_text(metadata->'tags') AS tag
    WHERE archived = false
      AND metadata ? 'tags'
      AND jsonb_typeof(metadata->'tags') = 'array'
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `;
  const result = await getDb().execute(tagsSql);
  const rows = (result as any).rows ?? result;
  if (!Array.isArray(rows)) return [];
  return rows.map(row => ({
    tag: String(row.tag),
    count: Number(row.count),
  }));
}
