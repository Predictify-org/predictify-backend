/**
 * Focused tests for the per-endpoint /api/markets Prometheus metrics
 * (markets_request_duration_seconds, markets_requests_total).
 *
 * Mounts marketsRouter + metricsRouter directly rather than going through
 * createApp(), since createApp() also wires up unrelated routers that are
 * broken independent of this change (see src/index.ts's webhooksRouter
 * import, which does not match src/routes/webhooks.ts's actual exports).
 */

import request from "supertest";
import express from "express";
import { marketsRouter } from "../src/routes/markets";
import { metricsRouter } from "../src/routes/metrics";
import { errorHandler } from "../src/middleware/errorHandler";
import * as marketService from "../src/services/marketService";

jest.mock("../src/services/marketService", () => ({
  ...jest.requireActual("../src/services/marketService"),
  listMarkets: jest.fn(),
  listUpcomingMarkets: jest.fn(),
  getMarketById: jest.fn(),
}));

const mockListMarkets = marketService.listMarkets as jest.Mock;
const mockListUpcoming = marketService.listUpcomingMarkets as jest.Mock;
const mockGetMarketById = marketService.getMarketById as jest.Mock;

const METRICS_PATH = "/api/metrics";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Inject a default Origin header so the CORS allowlist middleware
  // applied inside marketsRouter passes in tests.
  app.use((req, _res, next) => {
    if (!req.headers["origin"]) {
      req.headers["origin"] = "http://localhost:5173";
    }
    next();
  });
  app.use("/api/markets", marketsRouter);
  app.use(METRICS_PATH, metricsRouter);
  app.use(errorHandler);
  return app;
}

describe("Per-endpoint /api/markets metrics", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("declares the markets metric names on /api/metrics", async () => {
    const res = await request(makeApp()).get(METRICS_PATH);
    expect(res.text).toContain("markets_request_duration_seconds");
    expect(res.text).toContain("markets_requests_total");
  });

  it("records list endpoint requests with a 200 status label", async () => {
    mockListMarkets.mockResolvedValue({ data: [], nextCursor: null });

    const app = makeApp();
    await request(app).get("/api/markets");
    const res = await request(app).get(METRICS_PATH);

    expect(res.text).toContain(
      'markets_requests_total{endpoint="list",method="GET",status="200"}',
    );
    expect(res.text).toMatch(
      /markets_request_duration_seconds_count\{endpoint="list",method="GET",status="200"\}\s+1/,
    );
  });

  it("records upcoming endpoint requests with a distinct endpoint label", async () => {
    mockListUpcoming.mockResolvedValue([]);

    const app = makeApp();
    await request(app).get("/api/markets/upcoming");
    const res = await request(app).get(METRICS_PATH);

    expect(res.text).toContain(
      'markets_requests_total{endpoint="upcoming",method="GET",status="200"}',
    );
  });

  it("records get-by-id 404 responses with a 404 status label", async () => {
    mockGetMarketById.mockResolvedValue(null);

    const app = makeApp();
    await request(app).get("/api/markets/does-not-exist");
    const res = await request(app).get(METRICS_PATH);

    expect(res.text).toContain(
      'markets_requests_total{endpoint="get",method="GET",status="404"}',
    );
  });

  it("records patch endpoint auth failures (401) before the handler runs", async () => {
    const app = makeApp();
    const patchRes = await request(app)
      .patch("/api/markets/some-id")
      .send({ question: "Updated?", expectedVersion: 1 });
    expect(patchRes.status).toBe(401);

    const res = await request(app).get(METRICS_PATH);
    expect(res.text).toContain(
      'markets_requests_total{endpoint="patch",method="PATCH",status="401"}',
    );
  });

  it("increments the counter across repeated requests to the same endpoint", async () => {
    mockListUpcoming.mockResolvedValue([]);

    const app = makeApp();
    await request(app).get("/api/markets/upcoming");
    await request(app).get("/api/markets/upcoming");
    const res = await request(app).get(METRICS_PATH);

    const match = res.text.match(
      /markets_requests_total\{endpoint="upcoming",method="GET",status="200"\}\s+(\d+)/,
    );
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(2);
  });
});
