import request from "supertest";
import { createApp } from "../src/index";
import * as predictionExplainService from "../src/services/predictionExplainService";
import { randomUUID } from "crypto";

jest.mock("../src/services/predictionExplainService");

const mockGetPredictionExplanation = predictionExplainService.getPredictionExplanation as jest.MockedFunction<
  typeof predictionExplainService.getPredictionExplanation
>;

const app = createApp();

describe("GET /api/predictions/:id/explain", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 and the explanation for a valid UUID", async () => {
    const validId = randomUUID();
    const mockExplanation = {
      predictionId: validId,
      marketId: "market-123",
      outcome: "yes",
      status: "won",
      payout: "150.00",
      resolution: {
        timestamp: "2026-07-25T12:00:00Z",
        oracleInput: "data",
      }
    };
    
    // Using any cast here since we don't have the exact type of explanation but it just serializes whatever is returned.
    mockGetPredictionExplanation.mockResolvedValueOnce(mockExplanation as any);

    const res = await request(app).get(`/api/predictions/${validId}/explain`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockExplanation);
    expect(mockGetPredictionExplanation).toHaveBeenCalledWith(validId);
  });

  it("returns 400 validation_error for an invalid UUID", async () => {
    const res = await request(app).get("/api/predictions/not-a-uuid/explain");

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.message).toContain("must be a valid UUID");
    expect(mockGetPredictionExplanation).not.toHaveBeenCalled();
  });

  it("returns 500 when service throws", async () => {
    const validId = randomUUID();
    mockGetPredictionExplanation.mockRejectedValueOnce(new Error("Service failure"));

    const res = await request(app).get(`/api/predictions/${validId}/explain`);

    expect(res.status).toBe(500);
  });
});
