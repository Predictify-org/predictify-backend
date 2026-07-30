/**
 * tests/leaderboardMetrics.test.ts
 *
 * Focused tests for the `leaderboard_request_duration_seconds` Prometheus
 * histogram on GET /api/leaderboard (metrics/leaderboardMetrics.ts,
 * metrics/registry.ts).
 *
 * Test strategy: mount `leaderboardRouter` directly on a small Express app,
 * rather than going through `createApp()` from src/index.ts. This mirrors
 * the existing pattern in tests/statsMetrics.test.ts and keeps this suite
 * independent of unrelated wiring elsewhere in the app. A minimal local
 * error-handling middleware is used in place of the shared
 * src/middleware/errorHandler.ts, which is unrelated to this change and
 * currently fails to compile.
 *
 * Coverage matrix
 * ─────────────────────────────────────────────────────────
 *   ✓ histogram is registered with the expected name and explicit buckets
 *   ✓ observes a sample with route="/" and status="200" on success
 *   ✓ observes a sample with status="500" when the service throws
 *   ✓ sample count increases by exactly 1 per request
 *   ✓ metric is exposed in Prometheus exposition format via register.metrics()
 *   ✓ registers the histogram on the shared prom-client registry
 */

process.env.NODE_ENV = "test";

import express from "express";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { leaderboardRouter } from "../src/routes/leaderboard";
import { requestContextStorage } from "../src/lib/requestContext";
import * as leaderboardService from "../src/services/leaderboardService";
import { leaderboardRequestDuration, register } from "../src/metrics/registry";

jest.mock("../src/services/leaderboardService");

const mockGetLeaderboard = leaderboardService.getLeaderboard as jest.MockedFunction<
  typeof leaderboardService.getLeaderboard
>;

const sampleEntry = {
  user_id: "u1",
  stellar_address: "GAAA",
  total_predictions: 10,
  correct_predictions: 7,
  accuracy_percentage: 70.0,
  rank: 1,
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
  app.use("/api/leaderboard", leaderboardRouter);
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
  mockGetLeaderboard.mockResolvedValue([sampleEntry]);
});

/**
 * Reads the current sample count for a given label subset via the
 * histogram's own `.get()` snapshot (public prom-client API only).
 */
async function sampleCount(
  histogram: typeof leaderboardRequestDuration,
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

describe("leaderboard_request_duration_seconds histogram", () => {
  it("is registered with the expected name and explicit buckets", () => {
    expect(leaderboardRequestDuration.name).toBe(
      "leaderboard_request_duration_seconds",
    );
    // @ts-expect-error -- accessing an internal prom-client field for a
    // configuration assertion; there is no public getter for bucket bounds.
    const buckets: number[] = leaderboardRequestDuration.buckets;
    expect(buckets).toEqual([0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]);
  });

  it("observes a sample labeled route=/ status=200 on a successful request", async () => {
    const before = await sampleCount(leaderboardRequestDuration, {
      route: "/",
      status: "200",
    });

    const res = await request(app).get("/api/leaderboard");
    expect(res.status).toBe(200);

    const after = await sampleCount(leaderboardRequestDuration, {
      route: "/",
      status: "200",
    });
    expect(after).toBe(before + 1);
  });

  it("observes a sample labeled status=500 when the service throws", async () => {
    mockGetLeaderboard.mockRejectedValue(new Error("DB connection lost"));

    const before = await sampleCount(leaderboardRequestDuration, {
      route: "/",
      status: "500",
    });

    const res = await request(app).get("/api/leaderboard");
    expect(res.status).toBe(500);

    const after = await sampleCount(leaderboardRequestDuration, {
      route: "/",
      status: "500",
    });
    expect(after).toBe(before + 1);
  });

  it("increments the sample count by exactly 1 per request", async () => {
    const before = await sampleCount(leaderboardRequestDuration, {
      route: "/",
      status: "200",
    });

    await request(app).get("/api/leaderboard");
    await request(app).get("/api/leaderboard");

    const after = await sampleCount(leaderboardRequestDuration, {
      route: "/",
      status: "200",
    });
    expect(after).toBe(before + 2);
  });

  it("is exposed in Prometheus exposition format via register.metrics()", async () => {
    await request(app).get("/api/leaderboard");

    const metricsRes = await request(app).get("/api/metrics");
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.text).toContain(
      "# HELP leaderboard_request_duration_seconds",
    );
    expect(metricsRes.text).toContain(
      "# TYPE leaderboard_request_duration_seconds histogram",
    );
    expect(metricsRes.text).toMatch(
      /leaderboard_request_duration_seconds_bucket\{.*route="\/".*status="200".*\}/,
    );
  });

  it("registers the histogram on the shared prom-client registry", () => {
    expect(
      register.getSingleMetric("leaderboard_request_duration_seconds"),
    ).toBe(leaderboardRequestDuration);
  });
});
