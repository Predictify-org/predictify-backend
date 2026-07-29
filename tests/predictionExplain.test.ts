import request from "supertest";
import { createApp } from "../src/index";
import { getPredictionExplanation } from "../src/services/predictionExplainService";
import { generateETag } from "../src/middleware/etag";

jest.mock("../src/services/predictionExplainService");

const mockGetPredictionExplanation = getPredictionExplanation as jest.MockedFunction<
  typeof getPredictionExplanation
>;

const app = createApp();

describe("GET /api/predictions/:id/explain", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with the explanation and ETag", async () => {
    const mockExplanation = { steps: ["step 1", "step 2"] };
    // @ts-expect-error - Mocking a subset of the actual response
    mockGetPredictionExplanation.mockResolvedValueOnce(mockExplanation);

    const res = await request(app).get("/api/predictions/123/explain");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockExplanation);
    expect(res.headers.etag).toBe(generateETag(mockExplanation));
  });

  it("returns 304 Not Modified when If-None-Match matches ETag", async () => {
    const mockExplanation = { steps: ["step 1", "step 2"] };
    // @ts-expect-error - Mocking a subset of the actual response
    mockGetPredictionExplanation.mockResolvedValueOnce(mockExplanation);
    const etag = generateETag(mockExplanation);

    const res = await request(app)
      .get("/api/predictions/123/explain")
      .set("If-None-Match", etag);

    expect(res.status).toBe(304);
    expect(res.body).toEqual({});
  });

  it("returns 500 when service throws an error", async () => {
    mockGetPredictionExplanation.mockRejectedValueOnce(new Error("Service error"));

    const res = await request(app).get("/api/predictions/123/explain");

    expect(res.status).toBe(500);
  });
});
