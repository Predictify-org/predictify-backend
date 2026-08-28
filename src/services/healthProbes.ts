/**
 * healthProbes.ts
 *
 * Probes all external dependencies (Postgres, Soroban RPC, Horizon, webhook queue).
 * Each probe runs in parallel with a 5-second timeout per probe.
 * Results are cached for 5 seconds to prevent probe storms.
 */

import { rpc } from "@stellar/stellar-sdk";
import { pool } from "../db/client";
import { redisConnection } from "../queue";
import { env } from "../config/env";

// ─── Types ───────────────────────────────────────────────────────────────

export type ProbeStatus = "ok" | "degraded" | "down";

export interface ProbeResult {
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
}

export interface DependencyHealth {
  postgres: ProbeResult;
  sorobanRpc: ProbeResult;
  horizon: ProbeResult;
  webhookQueue: ProbeResult;
}

export type CompositeStatus = "ok" | "degraded" | "down";

// ─── Probes ──────────────────────────────────────────────────────────────

/**
 * Probe Postgres with a lightweight query.
 */
async function probePostgres(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: "Postgres unavailable",
    };
  }
}

/**
 * Probe Soroban RPC by calling getLatestLedger.
 */
async function probeSorobanRpc(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const server = new rpc.Server(env.SOROBAN_RPC_URL, {
      allowHttp: env.SOROBAN_RPC_URL.startsWith("http://"),
    });
    await server.getLatestLedger();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: "Soroban RPC unavailable",
    };
  }
}

/**
 * Probe Horizon by checking its root endpoint.
 */
async function probeHorizon(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const { fetchWithRetry } = await import("../lib/http");
      await fetchWithRetry(env.HORIZON_URL, { signal: controller.signal });
      return { status: "ok", latencyMs: Date.now() - start };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: "Horizon unavailable",
    };
  }
}

/**
 * Probe webhook queue (Redis) by calling PING.
 */
async function probeWebhookQueue(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    await redisConnection.ping();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: "Webhook queue unavailable",
    };
  }
}

// ─── Parallel probe execution with timeout ───────────────────────────────

const TIMEOUT_MS = 5000;

/**
 * Wraps a promise with a timeout.
 * Returns the fallback value if the promise does not settle within TIMEOUT_MS.
 */
function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), TIMEOUT_MS)
    ),
  ]);
}

/**
 * Probes all 4 dependencies in parallel.
 * Each probe has its own 5-second timeout.
 */
export async function probeAllDependencies(): Promise<DependencyHealth> {
  const [postgres, sorobanRpc, horizon, webhookQueue] = await Promise.all([
    withTimeout(probePostgres(), {
      status: "down",
      latencyMs: TIMEOUT_MS,
      error: "Probe timed out",
    }),
    withTimeout(probeSorobanRpc(), {
      status: "down",
      latencyMs: TIMEOUT_MS,
      error: "Probe timed out",
    }),
    withTimeout(probeHorizon(), {
      status: "down",
      latencyMs: TIMEOUT_MS,
      error: "Probe timed out",
    }),
    withTimeout(probeWebhookQueue(), {
      status: "down",
      latencyMs: TIMEOUT_MS,
      error: "Probe timed out",
    }),
  ]);

  return { postgres, sorobanRpc, horizon, webhookQueue };
}

// ─── Composite status ─────────────────────────────────────────────────────

/**
 * Computes the overall health status:
 * - 'ok' if all probes are ok
 * - 'down' if any probe is down
 * - 'degraded' otherwise (some ok, some degraded)
 */
export function computeCompositeStatus(health: DependencyHealth): CompositeStatus {
  const statuses = Object.values(health).map((p) => p.status);

  if (statuses.every((s) => s === "ok")) return "ok";
  if (statuses.some((s) => s === "down")) return "down";
  return "degraded";
}

// ─── Cache ───────────────────────────────────────────────────────────────

interface CacheEntry {
  data: DependencyHealth;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 5000;

/**
 * Gets cached dependency health if available and not expired.
 * Otherwise runs probeAllDependencies and caches the result for 5 seconds.
 */
export async function getCachedDependencyHealth(): Promise<DependencyHealth> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  const data = await probeAllDependencies();
  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}
