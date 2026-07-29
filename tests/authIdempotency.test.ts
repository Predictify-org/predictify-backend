process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.LOG_LEVEL = "fatal";
process.env.DATABASE_URL = "postgres://localhost/test";
process.env.JWT_SECRET = "a-very-long-test-secret-at-least-32-bytes!!";
process.env.JWT_ISSUER = "predictify";
process.env.JWT_AUDIENCE = "predictify-app";
process.env.JWT_TTL_SECONDS = "3600";
process.env.STELLAR_NETWORK = "testnet";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF1234567890";

const VALID_STELLAR_ADDRESS = "GABSCDZCXMOO6CYNTHBGHAOE3RX72FRMNWK6O4FOXW6OBQATNWKBUUW6";
const VALID_STELLAR_ADDRESS_2 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const mockCreateChallenge = jest.fn();
const mockRevokeFamily = jest.fn();
const idempotencyStore = new Map<string, unknown>();
const mockSelect = jest.fn(async () => Array.from(idempotencyStore.values()));
const mockInsert = jest.fn(async (record: any) => {
  idempotencyStore.set(record.key, record);
  return undefined;
});

jest.mock("../src/middleware/rateLimit", () => ({
  createPerUserRateLimiter: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock("../src/middleware/loginRateLimit", () => ({
  loginRateLimit: jest.fn((_: any, _res: any, next: any) => next()),
}));

jest.mock("../src/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockSelect }) }) }),
    insert: () => ({ values: mockInsert }),
  },
}));

jest.mock("../src/services/authChallengeService", () => ({
  __esModule: true,
  createChallenge: mockCreateChallenge,
  verifyChallengeAndIssueJwt: jest.fn(),
}));

jest.mock("../src/services/refreshTokenService", () => ({
  __esModule: true,
  revokeFamily: mockRevokeFamily,
  rotateRefreshToken: jest.fn(),
}));

import express from "express";
import request from "supertest";
import { authRouter } from "../src/routes/auth";
import { errorHandler } from "../src/middleware/errorHandler";
import { idempotency } from "../src/middleware/idempotency";

let app: express.Express;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", idempotency);
  app.use("/api/auth", authRouter);
  app.use(errorHandler);
  return app;
}

beforeAll(() => {
  app = makeApp();
});

beforeEach(() => {
  jest.clearAllMocks();
  idempotencyStore.clear();
});

describe("Idempotency for /api/auth POST operations", () => {
  it("replays POST /api/auth/challenge with the same Idempotency-Key and body", async () => {
    mockCreateChallenge.mockResolvedValueOnce({
      nonce: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      expiresAt: new Date(Date.now() + 300_000),
    });

    const key = "idemp-auth-challenge-1";
    const body = { stellarAddress: VALID_STELLAR_ADDRESS };

    const first = await request(app)
      .post("/api/auth/challenge")
      .set("Idempotency-Key", key)
      .send(body);

    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(first.body).toEqual({
      nonce: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(mockCreateChallenge).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post("/api/auth/challenge")
      .set("Idempotency-Key", key)
      .send(body);

    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(mockCreateChallenge).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the same Idempotency-Key is reused with a different body", async () => {
    mockCreateChallenge.mockResolvedValueOnce({
      nonce: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      expiresAt: new Date(Date.now() + 300_000),
    });

    const key = "idemp-auth-challenge-2";

    await request(app)
      .post("/api/auth/challenge")
      .set("Idempotency-Key", key)
      .send({ stellarAddress: VALID_STELLAR_ADDRESS })
      .expect(201);

    const conflict = await request(app)
      .post("/api/auth/challenge")
      .set("Idempotency-Key", key)
      .send({ stellarAddress: VALID_STELLAR_ADDRESS_2 })
      .expect(409);

    expect(conflict.body.error.code).toBe("idempotency_conflict");
  });

  it("replays POST /api/auth/logout with 204 No Content for the same Idempotency-Key and payload", async () => {
    mockRevokeFamily.mockResolvedValue(undefined);
    const key = "idemp-auth-logout-1";
    const body = { refreshToken: "logout-token-1" };

    await request(app)
      .post("/api/auth/logout")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(204);

    const replay = await request(app)
      .post("/api/auth/logout")
      .set("Idempotency-Key", key)
      .send(body)
      .expect(204);

    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(mockRevokeFamily).toHaveBeenCalledTimes(1);
  });

  it("returns 409 for same logout key when the request payload changes", async () => {
    mockRevokeFamily.mockResolvedValue(undefined);
    const key = "idemp-auth-logout-2";

    await request(app)
      .post("/api/auth/logout")
      .set("Idempotency-Key", key)
      .send({ refreshToken: "logout-token-1" })
      .expect(204);

    const conflict = await request(app)
      .post("/api/auth/logout")
      .set("Idempotency-Key", key)
      .send({ refreshToken: "logout-token-2" })
      .expect(409);

    expect(conflict.body.error.code).toBe("idempotency_conflict");
  });
});
