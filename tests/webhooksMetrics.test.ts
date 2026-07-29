/**
 * Tests for per-endpoint Prometheus metrics on /api/webhooks.
 *
 * Verifies that `webhooksEndpointRequestsTotal` (Counter) and
 * `webhooksEndpointDuration` (Histogram) are incremented/observed for each
 * route handler in src/routes/webhooks.ts and src/routes/adminWebhooks.ts.
 *
 * Strategy: mount the webhook routers directly on a small Express app
 * with mocked deps so we exercise only the route + metrics wiring.
 */

// ---------------------------------------------------------------------------
// 1. Env vars (must run BEFORE project imports)
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "webhooks-metrics-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ---------------------------------------------------------------------------
// 2. Project imports (env is set)
// ---------------------------------------------------------------------------
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { createWebhooksRouter } from "../src/routes/webhooks";
import { createAdminWebhooksRouter } from "../src/routes/adminWebhooks";
import { errorHandler } from "../src/middleware/errorHandler";
import { requestContextStorage } from "../src/lib/requestContext";
import { WebhookDispatcher, type HttpSender } from "../src/services/webhookDispatcher";
import { InMemoryWebhookStore } from "../src/services/webhookStore";
import {
  webhooksEndpointRequestsTotal,
  webhooksEndpointDuration,
} from "../src/metrics/registry";

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET!;
const SIGNING_SECRET = "test-webhook-signing-secret";

function token(role?: string) {
  return jwt.sign({ sub: "user_1", ...(role ? { role } : {}) }, JWT_SECRET, {
    issuer: process.env.JWT_ISSUER!,
    audience: process.env.JWT_AUDIENCE!,
    expiresIn: "5m",
  });
}

const adminAuth = { Authorization: `Bearer ${token("admin")}` };
const userAuth = { Authorization: `Bearer ${token()}` };

function buildHarness(send: HttpSender = async () => ({ status: 200 })) {
  const store = new InMemoryWebhookStore();
  const dispatcher = new WebhookDispatcher({
    store,
    send,
    signingSecret: SIGNING_SECRET,
    backoffMs: () => 0,
  });
  const app = express();
  app.use(express.json());
  app.use(
    (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      const requestId = uuidv4();
      (req as { id?: string }).id = requestId;
      requestContextStorage.run({ requestId }, next);
    },
  );
  app.use("/api/webhooks", createWebhooksRouter({ store }));
  app.use(
    "/api/admin/webhooks",
    createAdminWebhooksRouter({ store, dispatcher }),
  );
  app.use(errorHandler);
  return { app, store, dispatcher };
}

async function seedDeliveries(dispatcher: WebhookDispatcher, n: number) {
  for (let i = 0; i < n; i++) {
    await dispatcher.enqueue({
      eventId: `evt_${i}`,
      eventType: "market.resolved",
      targetUrl: "https://example.test/hook",
      payload: Buffer.from(`body-${i}`),
      maxAttempts: 3,
    });
  }
}

/**
 * Read the current value (.value) for a given label set from the counter's
 * internal hashMap.
 */
function counterValue(
  counter: typeof webhooksEndpointRequestsTotal,
  labels: Record<string, string>,
): number {
  const key = Object.keys(labels)
    .sort()
    .map((k) => `${k}:${labels[k]}`)
    .join(",") + ",";
  const entry = counter.hashMap[key] as { value: number } | undefined;
  return entry?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Per-endpoint metrics on /api/webhooks", () => {
  describe("GET /api/webhooks", () => {
    it("increments counter with method, route, and status labels on 200", async () => {
      const { app, dispatcher } = buildHarness();
      await seedDeliveries(dispatcher, 2);

      const before = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/",
        status: "200",
      });

      await request(app).get("/api/webhooks?limit=10").set(adminAuth);

      const after = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram on 200", async () => {
      const { app, dispatcher } = buildHarness();
      await seedDeliveries(dispatcher, 1);

      const res = await request(app).get("/api/webhooks").set(adminAuth);

      expect(res.status).toBe(200);
      const metrics = await webhooksEndpointDuration.get();
      const routeMetric = metrics.values.find(
        (v) => v.labels.route === "/" && v.labels.method === "GET",
      );
      expect(routeMetric).toBeDefined();
    });

    it("records status=403 for unauthenticated requests", async () => {
      const { app } = buildHarness();

      const before = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/",
        status: "403",
      });

      await request(app).get("/api/webhooks");

      const after = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/",
        status: "403",
      });
      expect(after).toBe(before + 1);
    });

    it("records status=403 for non-admin token", async () => {
      const { app } = buildHarness();

      const before = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/",
        status: "403",
      });

      await request(app).get("/api/webhooks").set(userAuth);

      const after = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/",
        status: "403",
      });
      expect(after).toBe(before + 1);
    });

    it("records status=400 for invalid query params", async () => {
      const { app } = buildHarness();

      const before = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/",
        status: "400",
      });

      await request(app).get("/api/webhooks?limit=abc").set(adminAuth);

      const after = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/",
        status: "400",
      });
      expect(after).toBe(before + 1);
    });
  });

  // ── GET /api/admin/webhooks/dlq ─────────────────────────────────────

  describe("GET /api/admin/webhooks/dlq", () => {
    it("increments counter on 200", async () => {
      const { app } = buildHarness();

      const before = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/dlq",
        status: "200",
      });

      await request(app).get("/api/admin/webhooks/dlq").set(adminAuth);

      const after = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/dlq",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram", async () => {
      const { app } = buildHarness();

      const res = await request(app).get("/api/admin/webhooks/dlq").set(adminAuth);

      expect(res.status).toBe(200);
      const metrics = await webhooksEndpointDuration.get();
      const routeMetric = metrics.values.find(
        (v) => v.labels.route === "/dlq" && v.labels.method === "GET",
      );
      expect(routeMetric).toBeDefined();
    });

    it("records status=403 for unauthenticated requests", async () => {
      const { app } = buildHarness();

      const before = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/dlq",
        status: "403",
      });

      await request(app).get("/api/admin/webhooks/dlq");

      const after = counterValue(webhooksEndpointRequestsTotal, {
        method: "GET",
        route: "/dlq",
        status: "403",
      });
      expect(after).toBe(before + 1);
    });
  });

  // ── POST /api/admin/webhooks/dlq/:id/replay ─────────────────────────

  describe("POST /api/admin/webhooks/dlq/:id/replay", () => {
    it("increments counter on 404 (not found)", async () => {
      const { app } = buildHarness();

      const before = counterValue(webhooksEndpointRequestsTotal, {
        method: "POST",
        route: "/dlq/:id/replay",
        status: "404",
      });

      await request(app)
        .post(
          "/api/admin/webhooks/dlq/550e8400-e29b-41d4-a716-446655440000/replay",
        )
        .set(adminAuth)
        .send();

      const after = counterValue(webhooksEndpointRequestsTotal, {
        method: "POST",
        route: "/dlq/:id/replay",
        status: "404",
      });
      expect(after).toBe(before + 1);
    });

    it("records status=403 for unauthenticated requests", async () => {
      const { app } = buildHarness();

      const before = counterValue(webhooksEndpointRequestsTotal, {
        method: "POST",
        route: "/dlq/:id/replay",
        status: "403",
      });

      await request(app)
        .post(
          "/api/admin/webhooks/dlq/550e8400-e29b-41d4-a716-446655440000/replay",
        )
        .send();

      const after = counterValue(webhooksEndpointRequestsTotal, {
        method: "POST",
        route: "/dlq/:id/replay",
        status: "403",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram", async () => {
      const { app } = buildHarness();

      const res = await request(app)
        .post(
          "/api/admin/webhooks/dlq/550e8400-e29b-41d4-a716-446655440000/replay",
        )
        .set(adminAuth)
        .send();

      expect(res.status).toBe(404);
      const metrics = await webhooksEndpointDuration.get();
      const routeMetric = metrics.values.find(
        (v) =>
          v.labels.route === "/dlq/:id/replay" && v.labels.method === "POST",
      );
      expect(routeMetric).toBeDefined();
    });
  });

  // ── Label structure ──────────────────────────────────────────────────

  describe("histogram label structure", () => {
    it("includes method, route, and status labels", async () => {
      const { app, dispatcher } = buildHarness();
      await seedDeliveries(dispatcher, 1);

      await request(app).get("/api/webhooks").set(adminAuth);

      const metrics = await webhooksEndpointDuration.get();
      const hookMetric = metrics.values.find(
        (v) => v.labels.route === "/",
      );
      expect(hookMetric).toBeDefined();
      expect(hookMetric!.labels).toHaveProperty("method", "GET");
      expect(hookMetric!.labels).toHaveProperty("status", "200");
    });
  });

  describe("counter label structure", () => {
    it("includes method, route, and status labels", async () => {
      const { app, dispatcher } = buildHarness();
      await seedDeliveries(dispatcher, 1);

      await request(app).get("/api/webhooks").set(adminAuth);

      const metrics = await webhooksEndpointRequestsTotal.get();
      const hookMetric = metrics.values.find(
        (v) => v.labels.route === "/",
      );
      expect(hookMetric).toBeDefined();
      expect(hookMetric!.labels).toHaveProperty("method", "GET");
      expect(hookMetric!.labels).toHaveProperty("status", "200");
      expect(hookMetric!.value).toBeGreaterThanOrEqual(1);
    });
  });
});
