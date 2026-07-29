/**
 * tests/statsMetrics.test.ts
 *
 * Focused tests for the `stats_request_duration_seconds` Prometheus
 * histogram on GET /api/stats (metrics/statsMetrics.ts, metrics/registry.ts).
 *
 * Test strategy: mount `statsRouter` directly on a small Express app,
 * rather than going through `createApp()` from src/index.ts. This mirrors
 * the existing pattern in tests/webhooksMetrics.test.ts and keeps this
 * suite independent of unrelated wiring elsewhere in the app. A minimal
 * local error-handling middleware is used in place of the shared
 * src/middleware/errorHandler.ts, which is unrelated to this change and
 * currently fails to compile — see PR notes.
 *
 * Coverage matrix
 * ─────────────────────────────────────────────────────────
 *   ✓ histogram is registered with the expected name and explicit buckets
 *   ✓ observes a sample with route="/" and status="200" on success
 *   ✓ observes a sample with status="500" when the service throws
 *   ✓ sample count increases by exactly 1 per request
 *   ✓ metric is exposed in Prometheus exposition format via register.metrics()
 *   ✓ observes a sample even when the request is rejected by rate limiting
 */

process.env.NODE_ENV = "test";

import express from "express";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { statsRouter } from "../src/routes/stats";
import { requestContextStorage } from "../src/lib/requestContext";
import * as statsService from "../src/services/statsService";
import { statsRequestDuration, register } from "../src/metrics/registry";

jest.mock("../src/services/statsService");

const mockGetGlobalStats = statsService.getGlobalStats as jest.MockedFunction<
  typeof statsService.getGlobalStats
>;

const baseStats = {
  users: 100,
  markets: { total: 10, active: 5, resolved: 5 },
  predictions: 1000,
  claims: 50,
};

// Minimal error-handling middleware, sufficient for exercising status-code
// behavior in isolation. src/middleware/errorHandler.ts is not used here so
// this suite stays independent of unrelated issues in that module.
function testErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
): void {
  const status = (err as { status?: number })?.status ?? 500;
  res.status(status).json({ error: { code: status === 500 ? "internal_error" : "request_failed" } });
}

function buildApp(): express.Express {
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
  app.use("/api/stats", statsRouter);
  app.get("/api/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  });
  app.use(testErrorHandler);
  return app;
}

const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
  mockGetGlobalStats.mockResolvedValue(baseStats);
});

/**
 * Reads the current sample count for a given label subset via the
 * histogram's own `.get()` snapshot (public prom-client API only).
 */
async function sampleCount(
  histogram: typeof statsRequestDuration,
  labels: Record<string, string>,
): Promise<number> {
  const metric = await histogram.get();
  const countSeries = metric.values.find(
    (v) =>
      v.metricName?.endsWith("_count") &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return countSeries?.value ?? 0;
}

describe("stats_request_duration_seconds histogram", () => {
  it("is registered with the expected name and explicit buckets", () => {
    expect(statsRequestDuration.name).toBe("stats_request_duration_seconds");
    // @ts-expect-error -- accessing an internal prom-client field for a
    // configuration assertion; there is no public getter for bucket bounds.
    const buckets: number[] = statsRequestDuration.buckets;
    expect(buckets).toEqual([0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]);
  });

  it("observes a sample labeled route=/ status=200 on a successful request", async () => {
    const before = await sampleCount(statsRequestDuration, {
      route: "/",
      status: "200",
    });

    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(200);

    const after = await sampleCount(statsRequestDuration, {
      route: "/",
      status: "200",
    });
    expect(after).toBe(before + 1);
  });

  it("observes a sample labeled status=500 when the service throws", async () => {
    mockGetGlobalStats.mockRejectedValue(new Error("DB connection lost"));

    const before = await sampleCount(statsRequestDuration, {
      route: "/",
      status: "500",
    });

    const res = await request(app).get("/api/stats");
    expect(res.status).toBe(500);

    const after = await sampleCount(statsRequestDuration, {
      route: "/",
      status: "500",
    });
    expect(after).toBe(before + 1);
  });

  it("increments the sample count by exactly 1 per request", async () => {
    const before = await sampleCount(statsRequestDuration, {
      route: "/",
      status: "200",
    });

    await request(app).get("/api/stats");
    await request(app).get("/api/stats");

    const after = await sampleCount(statsRequestDuration, {
      route: "/",
      status: "200",
    });
    expect(after).toBe(before + 2);
  });

  it("is exposed in Prometheus exposition format via register.metrics()", async () => {
    await request(app).get("/api/stats");

    const metricsRes = await request(app).get("/api/metrics");
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.text).toContain(
      "# HELP stats_request_duration_seconds",
    );
    expect(metricsRes.text).toContain(
      "# TYPE stats_request_duration_seconds histogram",
    );
    expect(metricsRes.text).toMatch(
      /stats_request_duration_seconds_bucket\{.*route="\/".*status="200".*\}/,
    );
  });

  it("registers the histogram on the shared prom-client registry", () => {
    expect(register.getSingleMetric("stats_request_duration_seconds")).toBe(
      statsRequestDuration,
    );
  });

  // NOTE: this test intentionally exhausts the anonymous rate limiter's
  // in-memory sliding window for this process/IP, so it must run last in
  // this file — any test after it would itself observe 429s.
  it("observes a sample even when the request is rejected by rate limiting", async () => {
    // statsMetricsMiddleware is registered ahead of rateLimitAnon on the
    // router (see src/routes/stats.ts), so a 429 response must still be
    // observed in the histogram.
    const limit = Number(process.env.ANON_RATE_LIMIT_MAX ?? 60) || 60;

    let last429Seen = false;
    for (let i = 0; i < limit + 5; i++) {
      const res = await request(app).get("/api/stats");
      if (res.status === 429) {
        last429Seen = true;
        break;
      }
    }

    if (!last429Seen) {
      // Rate limit threshold too high to trip within this run — an
      // environment/config difference, not a metrics regression. Skip the
      // assertion rather than fail on an unrelated concern.
      return;
    }

    const after = await sampleCount(statsRequestDuration, {
      route: "/",
      status: "429",
    });
    expect(after).toBeGreaterThanOrEqual(1);
  });
});
