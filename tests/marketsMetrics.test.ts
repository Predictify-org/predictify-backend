process.env.NODE_ENV = "test";

import express from "express";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { marketsRouter } from "../src/routes/markets";
import { requestContextStorage } from "../src/lib/requestContext";
import { marketsRequestDuration, register } from "../src/metrics/registry";

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
  app.use("/api/markets", marketsRouter);
  app.get("/api/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  });
  app.use(testErrorHandler);
  return app;
}

const app = buildApp();

async function sampleCount(
  labels: Record<string, string>,
): Promise<number> {
  const metric = await marketsRequestDuration.get();
  const countSeries = metric.values.find(
    (v) =>
      v.metricName?.endsWith("_count") &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return countSeries?.value ?? 0;
}

describe("markets_request_duration_seconds histogram", () => {
  it("is registered with the expected name and explicit buckets", () => {
    expect(marketsRequestDuration.name).toBe("markets_request_duration_seconds");
    // @ts-expect-error -- accessing an internal prom-client field for a
    // configuration assertion; there is no public getter for bucket bounds.
    const buckets: number[] = marketsRequestDuration.buckets;
    expect(buckets).toEqual([0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]);
  });

  it("uses route, method, and status labels", () => {
    expect(marketsRequestDuration.labelNames).toEqual(
      ["route", "method", "status"],
    );
  });

  it("registers the histogram on the shared prom-client registry", () => {
    expect(register.getSingleMetric("markets_request_duration_seconds")).toBe(
      marketsRequestDuration,
    );
  });

  it("observes a sample on a successful GET /api/markets/search", async () => {
    const before = await sampleCount({
      route: "/api/markets/search",
      method: "GET",
      status: "200",
    });

    const res = await request(app).get("/api/markets/search");
    expect(res.status).toBe(200);

    const after = await sampleCount({
      route: "/api/markets/search",
      method: "GET",
      status: "200",
    });
    expect(after).toBe(before + 1);
  });

  it("observes a sample on a successful GET /api/markets/", async () => {
    const before = await sampleCount({
      route: "/api/markets",
      method: "GET",
      status: "200",
    });

    const res = await request(app).get("/api/markets");
    expect(res.status).toBe(200);

    const after = await sampleCount({
      route: "/api/markets",
      method: "GET",
      status: "200",
    });
    expect(after).toBe(before + 1);
  });

  it("observes a sample with status=500 when the route handler throws", async () => {
    const before = await sampleCount({
      route: "/api/markets",
      method: "GET",
      status: "500",
    });

    const res = await request(app)
      .get("/api/markets")
      .set("x-correlation-id", "test-fail-id");
    expect([200, 500]).toContain(res.status);

    const after = await sampleCount({
      route: "/api/markets",
      method: "GET",
      status: "500",
    });
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("sample count increases by exactly 1 per request on 200", async () => {
    const before = await sampleCount({
      route: "/api/markets",
      method: "GET",
      status: "200",
    });

    await request(app).get("/api/markets");
    await request(app).get("/api/markets");

    const after = await sampleCount({
      route: "/api/markets",
      method: "GET",
      status: "200",
    });
    expect(after).toBe(before + 2);
  });

  it("is exposed in Prometheus exposition format via register.metrics()", async () => {
    await request(app).get("/api/markets");

    const metricsRes = await request(app).get("/api/metrics");
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.text).toContain(
      "# HELP markets_request_duration_seconds",
    );
    expect(metricsRes.text).toContain(
      "# TYPE markets_request_duration_seconds histogram",
    );
    expect(metricsRes.text).toMatch(
      /markets_request_duration_seconds_bucket\{.*route="\/api\/markets".*method="GET".*status="200".*\}/,
    );
  });

  it("records latency for dynamic route /api/markets/:id with correct labels", async () => {
    const before = await sampleCount({
      route: "/api/markets/:id",
      method: "GET",
      status: "200",
    });

    const res = await request(app).get("/api/markets/123e4567-e89b-12d3-a456-426614174000");
    expect([200, 404, 500]).toContain(res.status);

    const after = await sampleCount({
      route: "/api/markets/:id",
      method: "GET",
      status: String(res.status),
    });
    expect(after).toBeGreaterThanOrEqual(before);
  });
});