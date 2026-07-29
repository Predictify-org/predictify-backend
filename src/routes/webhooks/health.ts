/**
 * webhooks/health.ts
 *
 * GET /api/webhooks/health
 *
 * Focused health probe for the webhook delivery subsystem. Checks the two
 * runtime dependencies that the webhook pipeline relies on:
 *   1. database — Postgres (SELECT 1), where deliveries & subscriptions live
 *   2. queue    — Redis / BullMQ (PING), used by the webhook worker
 *
 * This complements the existing broader probes:
 *   • GET /health                  — process liveness (no I/O)
 *   • GET /healthz/dependencies    — shallow cached probe (5 s TTL)
 *   • GET /api/health/ready        — deep readiness for orchestrators
 *   • GET /api/health/dependencies — uncached full dependency snapshot
 *   • GET /api/webhooks/health     — this file; webhook-subsystem focused
 *
 * Response codes
 * ──────────────
 *   200 OK           — both probes pass ("ok")
 *   503 Unavailable  — at least one probe fails ("down")
 *
 * Response shape
 * ──────────────
 * {
 *   "status":        "ok" | "down",
 *   "correlationId": "<uuid>",
 *   "checkedAt":     "<ISO-8601>",
 *   "dependencies": {
 *     "database": { "status": "ok"|"down", "latencyMs": <n>, "error?": "…" },
 *     "queue":    { "status": "ok"|"down", "latencyMs": <n>, "error?": "…" }
 *   }
 * }
 *
 * Security
 * ────────
 * No authentication required — the response contains no sensitive data.
 * In production, restrict access at the infrastructure level (internal ALB,
 * VPC-only routing, etc.).
 *
 * The response is NOT cached. Callers that want caching should add a cache
 * layer in front of this endpoint.
 *
 * Injectable dependencies
 * ───────────────────────
 * All external I/O is encapsulated in the `WebhooksHealthRouterDeps` callbacks
 * so tests can substitute fully-controlled stubs without touching real
 * infrastructure.
 */

import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { logger } from "../../config/logger";
import { pool } from "../../db/client";
import { redisConnection } from "../../queue";

// ── Types ────────────────────────────────────────────────────────────────────

export type WebhookProbeStatus = "ok" | "down";

export interface WebhookProbeResult {
  status: WebhookProbeStatus;
  latencyMs: number;
  error?: string;
}

export interface WebhookDependencyHealth {
  database: WebhookProbeResult;
  queue: WebhookProbeResult;
}

export type WebhookCompositeStatus = "ok" | "down";

// ── Injectable dependency interface ──────────────────────────────────────────

export type ProbeDatabaseFn = () => Promise<WebhookProbeResult>;
export type ProbeQueueFn = () => Promise<WebhookProbeResult>;

export interface WebhooksHealthRouterDeps {
  probeDatabase?: ProbeDatabaseFn;
  probeQueue?: ProbeQueueFn;
}

// ── Default probes ───────────────────────────────────────────────────────────

async function defaultProbeDatabase(): Promise<WebhookProbeResult> {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return { status: "ok", latencyMs: Date.now() - start };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      error: "Database unavailable",
    };
  }
}

async function defaultProbeQueue(): Promise<WebhookProbeResult> {
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

// ── Composite status ─────────────────────────────────────────────────────────

function computeCompositeStatus(health: WebhookDependencyHealth): WebhookCompositeStatus {
  if (health.database.status === "ok" && health.queue.status === "ok") return "ok";
  return "down";
}

function compositeToHttpStatus(composite: WebhookCompositeStatus): number {
  return composite === "ok" ? 200 : 503;
}

// ── Router factory ───────────────────────────────────────────────────────────

/**
 * Creates the /api/webhooks/health router with injected dependencies.
 *
 * @param deps - Override probe functions for testing. Defaults to production
 *               implementations that hit real Postgres and Redis.
 */
export function createWebhooksHealthRouter(
  deps: WebhooksHealthRouterDeps = {},
): Router {
  const probeDb: ProbeDatabaseFn = deps.probeDatabase ?? defaultProbeDatabase;
  const probeQ: ProbeQueueFn = deps.probeQueue ?? defaultProbeQueue;
  const router = Router();

  /**
   * GET /
   *
   * Runs both webhook-subsystem probes and returns the health snapshot.
   */
  router.get("/", async (req: Request, res: Response, next) => {
    const correlationId =
      ((req.headers["x-correlation-id"] as string | undefined) ?? "").trim() ||
      randomUUID();

    const requestStart = Date.now();

    try {
      const [database, queue] = await Promise.all([probeDb(), probeQ()]);
      const health: WebhookDependencyHealth = { database, queue };
      const composite = computeCompositeStatus(health);
      const httpStatus = compositeToHttpStatus(composite);

      logger.info(
        {
          correlationId,
          status: composite,
          httpStatus,
          elapsedMs: Date.now() - requestStart,
          database: database.status,
          queue: queue.status,
        },
        "webhooks_health_check_complete",
      );

      res.status(httpStatus).json({
        status: composite,
        correlationId,
        checkedAt: new Date().toISOString(),
        dependencies: health,
      });
    } catch (err) {
      logger.error(
        { correlationId, err, elapsedMs: Date.now() - requestStart },
        "webhooks_health_probe_threw",
      );
      next(err);
    }
  });

  return router;
}

// ── Default export ───────────────────────────────────────────────────────────

/** Production router instance wired into src/index.ts. */
export const webhooksHealthRouter = createWebhooksHealthRouter();
