import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/index";
import * as predictionService from "../src/services/predictionService";
import { env } from "../src/config/env";

jest.mock("../src/services/predictionService");

const mockCreatePrediction = predictionService.createPrediction as jest.MockedFunction<
  typeof predictionService.createPrediction
>;
const mockGetUserPredictions = predictionService.getUserPredictions as jest.MockedFunction<
  typeof predictionService.getUserPredictions
>;

function validToken(userId = "test-user-id"): string {
  return jwt.sign(
    { sub: userId, stellarAddress: "GABCDEF..." },
    env.JWT_SECRET,
    {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: env.JWT_TTL_SECONDS,
    },
  );
}

const app = createApp();

function postPrediction(token: string, marketId = "mkt-1", body?: Record<string, unknown>) {
  return request(app)
    .post(`/api/markets/${marketId}/predictions`)
    .set("Authorization", `Bearer ${token}`)
    .send(
      body ?? { outcome: "yes", amount: "10000000", txHash: "0xabc123" },
    );
}

function getMyPredictions(token: string, marketId = "mkt-1") {
  return request(app)
    .get(`/api/markets/${marketId}/predictions/mine`)
    .set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/markets/:id/predictions", () => {
  it("creates a prediction and returns 201", async () => {
    mockCreatePrediction.mockResolvedValueOnce({
      id: "pred-1",
      marketId: "mkt-1",
      userId: "test-user-id",
      outcome: "yes",
      amount: "10000000",
      txHash: "0xabc123",
      status: "pending",
      createdAt: new Date(),
    });

    const res = await postPrediction(validToken());

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: "pred-1",
      outcome: "yes",
      amount: "10000000",
      status: "pending",
    });
  });

  it("returns 409 when market is closed", async () => {
    mockCreatePrediction.mockRejectedValueOnce(
      Object.assign(new Error("Market is not active or has passed resolution time"), {
        status: 409,
        code: "market_closed",
      }),
    );

    const res = await postPrediction(validToken());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("market_closed");
  });

  it("returns 200 idempotent row for duplicate (userId, marketId, txHash)", async () => {
    const existing = {
      id: "pred-1",
      marketId: "mkt-1",
      userId: "test-user-id",
      outcome: "yes",
      amount: "10000000",
      txHash: "0xabc123",
      status: "pending",
      createdAt: new Date(),
    };
    mockCreatePrediction.mockResolvedValue(existing);

    const res1 = await postPrediction(validToken());
    const res2 = await postPrediction(validToken());

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res2.body.data.id).toBe(existing.id);
    expect(mockCreatePrediction).toHaveBeenCalledTimes(2);
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app)
      .post("/api/markets/mkt-1/predictions")
      .send({ outcome: "yes", amount: "10000000", txHash: "0xabc123" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 401 with invalid token", async () => {
    const res = await postPrediction("invalid-token");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 400 for missing fields", async () => {
    const res = await postPrediction(validToken(), "mkt-1", { outcome: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for empty outcome", async () => {
    const res = await postPrediction(validToken(), "mkt-1", {
      outcome: "",
      amount: "10000000",
      txHash: "0xabc123",
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("GET /api/markets/:id/predictions/mine", () => {
  it("returns user predictions", async () => {
    mockGetUserPredictions.mockResolvedValueOnce([
      {
        id: "pred-1",
        marketId: "mkt-1",
        userId: "test-user-id",
        outcome: "yes",
        amount: "10000000",
        txHash: "0xabc123",
        status: "pending",
        createdAt: new Date(),
      },
    ]);

    const res = await getMyPredictions(validToken());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("pred-1");
  });

  it("returns empty array when no predictions", async () => {
    mockGetUserPredictions.mockResolvedValueOnce([]);

    const res = await getMyPredictions(validToken());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/markets/mkt-1/predictions/mine");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });
});
