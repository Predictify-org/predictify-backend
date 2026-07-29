/**
 * Tests for per-endpoint Prometheus metrics on /api/notifications.
 *
 * Verifies that `notificationsEndpointRequestsTotal` (Counter) and
 * `notificationsEndpointDuration` (Histogram) are incremented/observed
 * for every handler in src/routes/notifications.ts.
 *
 * Strategy: mount `notificationsRouter` on a minimal Express app with all
 * external dependencies mocked, then assert on the prom-client internal
 * state after each request.
 */

// ---------------------------------------------------------------------------
// 1. Env vars — must be set before any project imports
// ---------------------------------------------------------------------------
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET =
  "notifications-metrics-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

// ---------------------------------------------------------------------------
// 2. Mocks
// ---------------------------------------------------------------------------

/** Replace requireAuth so every request is treated as authenticated. */
jest.mock("../src/middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-test-123", stellarAddress: "GTEST" };
    req.id = "req-test-id";
    next();
  },
}));

/** Stub idempotency to a no-op so we don't need Redis. */
jest.mock("../src/middleware/idempotency", () => ({
  idempotency: jest.fn((_req: any, _res: any, next: any) => next()),
}));

/** Stub notificationPrefs service. */
jest.mock("../src/services/notificationPrefs", () => ({
  getNotificationPreferences: jest.fn(),
  patchNotificationPreferences: jest.fn(),
  notificationCategories: ["market_resolved", "claim_ready", "dispute_opened"],
  notificationChannels: ["email", "webhook"],
}));

/** Stub notificationService. */
jest.mock("../src/services/notificationService", () => ({
  markNotificationsAsRead: jest.fn(),
}));

// ---------------------------------------------------------------------------
// 3. Project imports (safe now — env set, mocks in place)
// ---------------------------------------------------------------------------
import express from "express";
import request from "supertest";
import { notificationsRouter } from "../src/routes/notifications";
import { errorHandler } from "../src/middleware/errorHandler";
import {
  getNotificationPreferences,
  patchNotificationPreferences,
} from "../src/services/notificationPrefs";
import { markNotificationsAsRead } from "../src/services/notificationService";
import {
  notificationsEndpointRequestsTotal,
  notificationsEndpointDuration,
} from "../src/metrics/registry";

const mockGetPrefs = getNotificationPreferences as jest.MockedFunction<
  typeof getNotificationPreferences
>;
const mockPatchPrefs = patchNotificationPreferences as jest.MockedFunction<
  typeof patchNotificationPreferences
>;
const mockMarkRead = markNotificationsAsRead as jest.MockedFunction<
  typeof markNotificationsAsRead
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
  app.use(errorHandler);
  return app;
}

/**
 * Read the current hit-count for a label set from a prom-client Counter's
 * internal hashMap.  Returns 0 when the label combination has never been seen.
 */
function counterValue(
  counter: typeof notificationsEndpointRequestsTotal,
  labels: Record<string, string>,
): number {
  const key =
    Object.keys(labels)
      .sort()
      .map((k) => `${k}:${labels[k]}`)
      .join(",") + ",";
  const entry = counter.hashMap[key] as { value: number } | undefined;
  return entry?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Per-endpoint metrics on /api/notifications", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── GET /api/notifications/preferences ─────────────────────────────────

  describe("GET /api/notifications/preferences", () => {
    it("increments counter with method, route, and status labels on 200", async () => {
      mockGetPrefs.mockResolvedValueOnce([] as any);

      const before = counterValue(notificationsEndpointRequestsTotal, {
        method: "GET",
        route: "/preferences",
        status: "200",
      });

      await request(app).get("/api/notifications/preferences");

      const after = counterValue(notificationsEndpointRequestsTotal, {
        method: "GET",
        route: "/preferences",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram on 200", async () => {
      mockGetPrefs.mockResolvedValueOnce([
        { category: "market_resolved", channel: "email", enabled: true },
      ] as any);

      const res = await request(app).get("/api/notifications/preferences");

      expect(res.status).toBe(200);
      const metrics = await notificationsEndpointDuration.get();
      const hit = metrics.values.find(
        (v) => v.labels.route === "/preferences" && v.labels.method === "GET",
      );
      expect(hit).toBeDefined();
    });

    it("records a non-zero duration observation", async () => {
      mockGetPrefs.mockResolvedValueOnce([] as any);

      const before = await notificationsEndpointDuration.get();
      const countBefore = before.values.find(
        (v) =>
          v.labels.route === "/preferences" &&
          v.labels.method === "GET" &&
          v.metricName === "notifications_endpoint_duration_seconds_count",
      );

      await request(app).get("/api/notifications/preferences");

      const after = await notificationsEndpointDuration.get();
      const countAfter = after.values.find(
        (v) =>
          v.labels.route === "/preferences" &&
          v.labels.method === "GET" &&
          v.metricName === "notifications_endpoint_duration_seconds_count",
      );

      expect((countAfter?.value ?? 0)).toBeGreaterThan(
        countBefore?.value ?? -1,
      );
    });
  });

  // ── PATCH /api/notifications/preferences ───────────────────────────────

  describe("PATCH /api/notifications/preferences", () => {
    it("increments counter on 200 after successful patch", async () => {
      mockPatchPrefs.mockResolvedValueOnce([
        { category: "market_resolved", channel: "email", enabled: false },
      ] as any);

      const before = counterValue(notificationsEndpointRequestsTotal, {
        method: "PATCH",
        route: "/preferences",
        status: "200",
      });

      await request(app)
        .patch("/api/notifications/preferences")
        .send({
          preferences: [
            { category: "market_resolved", channel: "email", enabled: false },
          ],
        });

      const after = counterValue(notificationsEndpointRequestsTotal, {
        method: "PATCH",
        route: "/preferences",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("increments counter with status=400 for invalid body", async () => {
      const before = counterValue(notificationsEndpointRequestsTotal, {
        method: "PATCH",
        route: "/preferences",
        status: "400",
      });

      await request(app)
        .patch("/api/notifications/preferences")
        .send({ preferences: [{ category: "invalid", channel: "email", enabled: true }] });

      const after = counterValue(notificationsEndpointRequestsTotal, {
        method: "PATCH",
        route: "/preferences",
        status: "400",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram", async () => {
      mockPatchPrefs.mockResolvedValueOnce([] as any);

      const res = await request(app)
        .patch("/api/notifications/preferences")
        .send({
          preferences: [
            { category: "claim_ready", channel: "webhook", enabled: true },
          ],
        });

      expect(res.status).toBe(200);
      const metrics = await notificationsEndpointDuration.get();
      const hit = metrics.values.find(
        (v) =>
          v.labels.route === "/preferences" && v.labels.method === "PATCH",
      );
      expect(hit).toBeDefined();
    });
  });

  // ── POST /api/notifications/mark-read ──────────────────────────────────

  describe("POST /api/notifications/mark-read", () => {
    it("increments counter on 200 when marking all as read", async () => {
      mockMarkRead.mockResolvedValueOnce({ updatedCount: 5 });

      const before = counterValue(notificationsEndpointRequestsTotal, {
        method: "POST",
        route: "/mark-read",
        status: "200",
      });

      await request(app)
        .post("/api/notifications/mark-read")
        .send({ markAllAsRead: true });

      const after = counterValue(notificationsEndpointRequestsTotal, {
        method: "POST",
        route: "/mark-read",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("increments counter on 200 when marking specific IDs", async () => {
      mockMarkRead.mockResolvedValueOnce({ updatedCount: 2 });

      const before = counterValue(notificationsEndpointRequestsTotal, {
        method: "POST",
        route: "/mark-read",
        status: "200",
      });

      await request(app)
        .post("/api/notifications/mark-read")
        .send({
          notificationIds: [
            "550e8400-e29b-41d4-a716-446655440000",
            "550e8400-e29b-41d4-a716-446655440001",
          ],
        });

      const after = counterValue(notificationsEndpointRequestsTotal, {
        method: "POST",
        route: "/mark-read",
        status: "200",
      });
      expect(after).toBe(before + 1);
    });

    it("increments counter with status=400 for invalid body", async () => {
      const before = counterValue(notificationsEndpointRequestsTotal, {
        method: "POST",
        route: "/mark-read",
        status: "400",
      });

      await request(app)
        .post("/api/notifications/mark-read")
        .send({ notificationIds: [] }); // empty array is invalid

      const after = counterValue(notificationsEndpointRequestsTotal, {
        method: "POST",
        route: "/mark-read",
        status: "400",
      });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram", async () => {
      mockMarkRead.mockResolvedValueOnce({ updatedCount: 0 });

      const res = await request(app)
        .post("/api/notifications/mark-read")
        .send({ markAllAsRead: true });

      expect(res.status).toBe(200);
      const metrics = await notificationsEndpointDuration.get();
      const hit = metrics.values.find(
        (v) =>
          v.labels.route === "/mark-read" && v.labels.method === "POST",
      );
      expect(hit).toBeDefined();
    });
  });

  // ── Label structure ─────────────────────────────────────────────────────

  describe("histogram label structure", () => {
    it("includes method, route, and status labels", async () => {
      mockGetPrefs.mockResolvedValueOnce([] as any);

      await request(app).get("/api/notifications/preferences");

      const metrics = await notificationsEndpointDuration.get();
      const hit = metrics.values.find(
        (v) => v.labels.route === "/preferences",
      );
      expect(hit).toBeDefined();
      expect(hit!.labels).toHaveProperty("method", "GET");
      expect(hit!.labels).toHaveProperty("status", "200");
    });
  });

  describe("counter label structure", () => {
    it("includes method, route, and status labels", async () => {
      mockGetPrefs.mockResolvedValueOnce([] as any);

      await request(app).get("/api/notifications/preferences");

      const metrics = await notificationsEndpointRequestsTotal.get();
      const hit = metrics.values.find(
        (v) => v.labels.route === "/preferences",
      );
      expect(hit).toBeDefined();
      expect(hit!.labels).toHaveProperty("method", "GET");
      expect(hit!.labels).toHaveProperty("status", "200");
      expect(hit!.value).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Histogram buckets ───────────────────────────────────────────────────

  describe("histogram buckets", () => {
    it("uses the expected explicit bucket boundaries", async () => {
      mockGetPrefs.mockResolvedValueOnce([] as any);

      await request(app).get("/api/notifications/preferences");

      const metrics = await notificationsEndpointDuration.get();
      // Extract all unique upper-bound values from the _bucket series.
      const boundValues = metrics.values
        .filter((v) => v.metricName === "notifications_endpoint_duration_seconds_bucket")
        .map((v) => v.labels.le)
        .filter((le): le is string => le !== "+Inf" && le !== undefined)
        .map(Number);

      const expectedBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];
      for (const b of expectedBuckets) {
        expect(boundValues).toContain(b);
      }
    });
  });

  // ── Prometheus output ───────────────────────────────────────────────────

  describe("Prometheus output", () => {
    it("exposes notifications_endpoint_requests_total metric name", async () => {
      mockGetPrefs.mockResolvedValueOnce([] as any);
      await request(app).get("/api/notifications/preferences");

      const metrics = await notificationsEndpointRequestsTotal.get();
      expect(metrics.name).toBe("notifications_endpoint_requests_total");
    });

    it("exposes notifications_endpoint_duration_seconds metric name", async () => {
      mockGetPrefs.mockResolvedValueOnce([] as any);
      await request(app).get("/api/notifications/preferences");

      const metrics = await notificationsEndpointDuration.get();
      expect(metrics.name).toBe("notifications_endpoint_duration_seconds");
    });
  });
});
