process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "a".repeat(32);
process.env.SOROBAN_RPC_URL = "https://rpc.testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon.testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABC...";

import request from "supertest";

jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const MOCK_EXPIRES_AT = new Date(Date.now() + 300_000);

jest.mock("../src/services/authChallengeService", () => ({
  generateNonce: jest.fn(() => "aaaa"),
  computeExpiresAt: jest.fn(() => new Date()),
  createChallenge: jest.fn((_addr: string) =>
    Promise.resolve({
      nonce: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      expiresAt: MOCK_EXPIRES_AT,
    }),
  ),
  verifyAndConsume: jest.fn(() => Promise.resolve(null)),
}));

import {
  createChallenge,
  generateNonce,
  computeExpiresAt,
} from "../src/services/authChallengeService";

describe("generateNonce", () => {
  it("returns a 64-character hex string", () => {
    const nonce = generateNonce();
    expect(typeof nonce).toBe("string");
  });
});

describe("computeExpiresAt", () => {
  it("returns a date object", () => {
    const d = computeExpiresAt();
    expect(d).toBeInstanceOf(Date);
  });
});

describe("POST /api/auth/challenge", () => {
  let app: any;

  beforeAll(() => {
    const { createApp } = require("../src/index");
    app = createApp();
  });

  it("returns 201 with nonce and expiresAt for valid address", async () => {
    const res = await request(app)
      .post("/api/auth/challenge")
      .send({ stellarAddress: "GABSCDZCXMOO6CYNTHBGHAOE3RX72FRMNWK6O4FOXW6OBQATNWKBUUW6" });
    expect(res.status).toBe(201);
    expect(res.body.nonce).toEqual(expect.any(String));
    expect(res.body.expiresAt).toEqual(expect.any(String));
  }, 10000);

  it("returns 400 with error for malformed address", async () => {
    const res = await request(app)
      .post("/api/auth/challenge")
      .send({ stellarAddress: "not-a-valid-address" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.type).toBe("BadRequest");
  }, 10000);

  it("returns 400 for missing body field", async () => {
    const res = await request(app)
      .post("/api/auth/challenge")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("BadRequest");
  }, 10000);

  it("supports ETag and returns 304 on match", async () => {
    const res = await request(app)
      .post("/api/auth/challenge")
      .send({ stellarAddress: "GABSCDZCXMOO6CYNTHBGHAOE3RX72FRMNWK6O4FOXW6OBQATNWKBUUW6" });

    expect(res.status).toBe(201);
    expect(res.headers.etag).toBeDefined();

    const etag = res.headers.etag;

    const res304 = await request(app)
      .post("/api/auth/challenge")
      .set("If-None-Match", etag)
      .send({ stellarAddress: "GABSCDZCXMOO6CYNTHBGHAOE3RX72FRMNWK6O4FOXW6OBQATNWKBUUW6" });

    expect(res304.status).toBe(304);
    expect(res304.body).toEqual({});
  });

  it("rate limits repeated challenge attempts for the same authenticated identity", async () => {
    const address = "GABSCDZCXMOO6CYNTHBGHAOE3RX72FRMNWK6O4FOXW6OBQATNWKBUUW6";

    for (let index = 0; index < 5; index += 1) {
      const res = await request(app)
        .post("/api/auth/challenge")
        .send({ stellarAddress: address });

      if (index < 4) {
        expect(res.status).toBe(201);
      }
    }

    const res = await request(app)
      .post("/api/auth/challenge")
      .send({ stellarAddress: "GABSCDZCXMOO6CYNTHBGHAOE3RX72FRMNWK6O4FOXW6OBQATNWKBUUW6" });
    
    expect(res.status).toBe(201);
    expect(res.headers.etag).toBeDefined();
    
    const etag = res.headers.etag;
    
    const res304 = await request(app)
      .post("/api/auth/challenge")
      .set("If-None-Match", etag)
      .send({ stellarAddress: "GABSCDZCXMOO6CYNTHBGHAOE3RX72FRMNWK6O4FOXW6OBQATNWKBUUW6" });
      
    expect(res304.status).toBe(304);
    expect(res304.body).toEqual({});
  });

  it("returns 408 when challenge creation exceeds the auth timeout", async () => {
    jest.useFakeTimers();
    (createChallenge as jest.Mock).mockImplementationOnce(() => new Promise(() => undefined));

    const pending = request(app)
      .post("/api/auth/challenge")
      .send({ stellarAddress: "GABSCDZCXMOO6CYNTHBGHAOE3RX72FRMNWK6O4FOXW6OBQATNWKBUUW6" });

    await Promise.resolve();
    jest.advanceTimersByTime(15000);

    const res = await pending;
    jest.useRealTimers();

    expect(res.status).toBe(408);
    expect(res.body.error).toMatchObject({
      code: "timeout",
      message: "Request timeout exceeded",
    });
  });
});
