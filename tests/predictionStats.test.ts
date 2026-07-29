import request from "supertest";
import { createApp } from "../src/index";
import * as predictionStatsService from "../src/services/predictionStatsService";
import { NotFoundError } from "../src/errors";

jest.mock("../src/services/predictionStatsService");

const mockGetPredictionStats =
  predictionStatsService.getPredictionStats as jest.MockedFunction<
    typeof predictionStatsService.getPredictionStats
  >;

const app = createApp();

beforeEach(() => jest.clearAllMocks());

describe("GET /api/predictions/:id/stats", () => {
  it("returns per-prediction statistics", async () => {
    mockGetPredictionStats.mockResolvedValue({
      prediction: {
        id: "pred-1",
        marketId: "mkt-1",
        outcome: "yes",
        amount: "100",
        status: "confirmed",
      },
      market: { id: "mkt-1", question: "Will it rain?", status: "active" },
      totals: { predictions: 3, pool: "300", outcomePool: "150" },
      ranking: { rank: 1, outOf: 2 },
      outcomeShare: 0.6667,
      expectedPayout: "200",
    });

    const res = await request(app).get("/api/predictions/pred-1/stats");

    expect(res.status).toBe(200);
    expect(res.body.data.ranking).toEqual({ rank: 1, outOf: 2 });
    expect(res.body.data.expectedPayout).toBe("200");
    expect(mockGetPredictionStats).toHaveBeenCalledWith("pred-1");
  });

  it("returns 404 when the prediction does not exist", async () => {
    mockGetPredictionStats.mockRejectedValue(new NotFoundError("Prediction missing not found"));

    const res = await request(app).get("/api/predictions/missing/stats");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBeDefined();
  });
});
