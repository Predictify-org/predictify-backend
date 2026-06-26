import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/index";

const JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-that-is-at-least-32-chars!!";
const JWT_ISSUER = "predictify";
const JWT_AUDIENCE = "predictify-app";

function makeToken(overrides?: Partial<{ sub: string; stellarAddress: string }>): string {
  return jwt.sign(
    { sub: overrides?.sub ?? "550e8400-e29b-41d4-a716-446655440000", stellarAddress: overrides?.stellarAddress ?? "GABCDEF123..." },
    JWT_SECRET,
    { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: "1h" },
  );
}

jest.mock("../src/services/disputeService", () => {
  const actual = jest.requireActual("../src/services/disputeService");
  return {
    ...actual,
    openDispute: jest.fn(),
  };
});

jest.mock("../src/utils/url", () => ({
  validateHttpsUrl: jest.fn().mockReturnValue({ valid: true }),
  validateSsrf: jest.fn().mockResolvedValue({ valid: true }),
}));

import { openDispute, DisputeError } from "../src/services/disputeService";
import { validateHttpsUrl, validateSsrf } from "../src/utils/url";

const mockedOpenDispute = openDispute as jest.MockedFunction<typeof openDispute>;
const mockedValidateHttpsUrl = validateHttpsUrl as jest.MockedFunction<typeof validateHttpsUrl>;
const mockedValidateSsrf = validateSsrf as jest.MockedFunction<typeof validateSsrf>;

const VALID_BODY = { reason: "The outcome is incorrect because the oracle data was manipulated." };

describe("POST /api/markets/:id/disputes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedValidateHttpsUrl.mockReturnValue({ valid: true });
    mockedValidateSsrf.mockResolvedValue({ valid: true });
  });

  it("returns 401 without auth token", async () => {
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 401 with malformed auth header", async () => {
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", "Invalid token")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", "Bearer invalid-token")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it("returns 400 when reason is too short", async () => {
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send({ reason: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when reason exceeds 500 characters", async () => {
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send({ reason: "x".repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when evidenceUri is not HTTPS", async () => {
    mockedValidateHttpsUrl.mockReturnValue({ valid: false, error: "evidenceUri must use HTTPS" });
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send({ reason: "This is a valid reason for opening a dispute.", evidenceUri: "http://example.com/ev" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_evidence_uri");
  });

  it("returns 400 when evidenceUri fails SSRF check", async () => {
    mockedValidateSsrf.mockResolvedValue({ valid: false, error: "URL resolves to a private IP" });
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send({ reason: "This is a valid reason for opening a dispute.", evidenceUri: "https://192.168.1.1/ev" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ssrf_check_failed");
  });

  it("returns 403 when caller has no prediction in the market", async () => {
    mockedOpenDispute.mockRejectedValue(
      new DisputeError(403, "no_prediction", "Caller does not hold a confirmed prediction in this market"),
    );
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("no_prediction");
  });

  it("returns 409 when a prior open dispute exists", async () => {
    mockedOpenDispute.mockRejectedValue(
      new DisputeError(409, "duplicate_dispute", "An open dispute already exists for this user and market"),
    );
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("duplicate_dispute");
  });

  it("returns 404 when the market does not exist", async () => {
    mockedOpenDispute.mockRejectedValue(
      new DisputeError(404, "market_not_found", "Market not found"),
    );
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("market_not_found");
  });

  it("returns 201 with the created dispute on success", async () => {
    const fakeDispute = {
      id: "disc-123",
      marketId: "market-1",
      openedBy: "550e8400-e29b-41d4-a716-446655440000",
      reason: "The outcome is incorrect because the oracle data was manipulated.",
      evidenceUri: null,
      status: "open",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    };
    mockedOpenDispute.mockResolvedValue(fakeDispute);

    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      ...fakeDispute,
      createdAt: fakeDispute.createdAt.toISOString(),
    });
  });

  it("accepts optional evidenceUri", async () => {
    const fakeDispute = {
      id: "disc-456",
      marketId: "market-1",
      openedBy: "550e8400-e29b-41d4-a716-446655440000",
      reason: "The outcome is incorrect because the oracle data was manipulated.",
      evidenceUri: "https://example.com/evidence",
      status: "open",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    };
    mockedOpenDispute.mockResolvedValue(fakeDispute);

    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send({ ...VALID_BODY, evidenceUri: "https://example.com/evidence" });
    expect(res.status).toBe(201);
    expect(res.body.data.evidenceUri).toBe("https://example.com/evidence");
  });

  it("rejects extra fields in the body", async () => {
    const res = await request(createApp())
      .post("/api/markets/market-1/disputes")
      .set("Authorization", `Bearer ${makeToken()}`)
      .send({ ...VALID_BODY, extraField: "should not be allowed" });
    expect(res.status).toBe(400);
  });
});
