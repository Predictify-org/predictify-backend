import express from "express";
import request from "supertest";
import { db } from "../../db/client";
import { errorHandler } from "../../middleware/errorHandler";
import { createAnalyticsSummaryRouter } from "../../routes/analytics/summary";

jest.mock("../../db/client", () => ({
  db: {
    execute: jest.fn(),
  },
}));

jest.mock("../../config/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const execute = db.execute as jest.MockedFunction<typeof db.execute>;

function makeApp(): express.Express {
  const app = express();
  app.use("/api/analytics/summary", createAnalyticsSummaryRouter());
  app.use(errorHandler);
  return app;
}

describe("GET /api/analytics/summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the aggregate summary in the standard data envelope", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          total_users: "12",
          total_markets: "8",
          active_markets: "5",
          resolved_markets: "3",
          total_predictions: "42",
          total_volume: "1234.5600000",
        },
      ],
    } as never);

    const response = await request(makeApp())
      .get("/api/analytics/summary")
      .set("x-correlation-id", "analytics-test-1");

    expect(response.status).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe("analytics-test-1");
    expect(response.body).toEqual({
      data: {
        totalUsers: 12,
        totalMarkets: 8,
        activeMarkets: 5,
        resolvedMarkets: 3,
        totalPredictions: 42,
        totalVolume: "1234.5600000",
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns zero values when the aggregate query has no row", async () => {
    execute.mockResolvedValueOnce({ rows: [] } as never);

    const response = await request(makeApp()).get("/api/analytics/summary");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      totalUsers: 0,
      totalMarkets: 0,
      activeMarkets: 0,
      resolvedMarkets: 0,
      totalPredictions: 0,
      totalVolume: "0",
    });
  });

  it("rejects unsupported query parameters at the boundary", async () => {
    const response = await request(makeApp()).get("/api/analytics/summary?from=2026-01-01");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes database failures to the standard error handler", async () => {
    execute.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await request(makeApp()).get("/api/analytics/summary");

    expect(response.status).toBe(500);
  });
});
