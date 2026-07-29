import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { featureFlags } from "../db/schema";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";

export interface FeatureFlag {
  id: string;
  enabled: boolean;
  variant?: string | null;
  description?: string | null;
}

// In-memory cache
const flagsCache = new Map<string, FeatureFlag>();
let refreshInterval: NodeJS.Timeout | null = null;

/**
 * Loads all flags from Postgres into the in-memory map.
 */
async function loadFlags() {
  const start = Date.now();
  try {
    const rows = await db.select().from(featureFlags);
    flagsCache.clear();
    for (const row of rows) {
      flagsCache.set(row.id, {
        id: row.id,
        enabled: row.enabled,
        variant: row.variant,
        description: row.description,
      });
    }
    const duration = Date.now() - start;
    logger.info(
      { count: rows.length, duration, reqId: getRequestId() },
      "Feature flags cache refreshed",
    );
  } catch (error) {
    logger.error(
      { err: error, reqId: getRequestId() },
      "Failed to refresh feature flags cache, continuing with stale cache",
    );
  }
}

/**
 * Initializes the feature flags service.
 * Loads the initial state and starts the refresh interval.
 *
 * Cache invalidation strategy:
 * - We rely on a periodic background refresh (default 30s) to sync all instances.
 * - This provides eventual consistency across multiple nodes.
 * - Local mutations immediately write-through to Postgres and update the local map,
 *   so the writer immediately sees their own changes.
 */
export async function initFeatureFlags() {
  await loadFlags();
  const ttlMs = env.FLAGS_CACHE_TTL_SECONDS * 1000;
  refreshInterval = setInterval(() => {
    loadFlags().catch((err) => {
      logger.error({ err, reqId: getRequestId() }, "Unhandled error in loadFlags background task");
    });
  }, ttlMs);
}

/** Stop the polling loop, mainly for tests/shutdown. */
export function stopFeatureFlags() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

export function getFlag(key: string): { enabled: boolean; variant?: string } | undefined {
  const flag = flagsCache.get(key);
  if (!flag) return undefined;
  return { enabled: flag.enabled, variant: flag.variant ?? undefined };
}

export function getAllFlags(): FeatureFlag[] {
  return Array.from(flagsCache.values());
}

export async function createFlag(data: {
  key: string;
  enabled: boolean;
  variant?: string | null;
  description?: string | null;
}): Promise<FeatureFlag> {
  const [row] = await db.insert(featureFlags)
    .values({
      id: data.key,
      enabled: data.enabled,
      variant: data.variant,
      description: data.description,
    })
    .returning();

  const flag = {
    id: row.id,
    enabled: row.enabled,
    variant: row.variant,
    description: row.description,
  };
  
  flagsCache.set(data.key, flag);
  logger.info({ action: "create_flag", key: data.key, reqId: getRequestId() }, "Feature flag created");
  return flag;
}

export async function updateFlag(key: string, data: Partial<{ enabled: boolean; variant: string | null; description: string | null }>): Promise<FeatureFlag | undefined> {
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.enabled !== undefined) updateData.enabled = data.enabled;
  if (data.variant !== undefined) updateData.variant = data.variant;
  if (data.description !== undefined) updateData.description = data.description;

  const [row] = await db.update(featureFlags)
    .set(updateData)
    .where(eq(featureFlags.id, key))
    .returning();

  if (!row) {
    return undefined;
  }

  const flag = {
    id: row.id,
    enabled: row.enabled,
    variant: row.variant,
    description: row.description,
  };

  flagsCache.set(key, flag);
  logger.info({ action: "update_flag", key, reqId: getRequestId() }, "Feature flag updated");
  return flag;
}

export async function deleteFlag(key: string): Promise<boolean> {
  const [row] = await db.delete(featureFlags)
    .where(eq(featureFlags.id, key))
    .returning();

  if (row) {
    flagsCache.delete(key);
    logger.info({ action: "delete_flag", key, reqId: getRequestId() }, "Feature flag deleted");
    return true;
  }
  return false;
}
