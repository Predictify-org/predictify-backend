import request from "supertest";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp } from "../src/index";

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
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";

jest.mock("../src/services/authChallengeService", () => ({
  __esModule: true,
  createChallenge: jest.fn(() => Promise.resolve({
    nonce: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    expiresAt: new Date(Date.now() + 300000),
  })),
  verifyAndConsume: jest.fn(),
}));

jest.mock("../src/db/userRepo", () => ({
  __esModule: true,
  upsertUserByStellarAddress: jest.fn(),
}));

const { verifyAndConsume } = require("../src/services/authChallengeService");
const { upsertUserByStellarAddress } = require("../src/db/userRepo");

function createFixtureKeypair() {
  return Keypair.random();
}

function signatureForNonce(keypair: Keypair, nonce: string): string {
  return keypair.sign(Buffer.from(nonce, "utf8")).toString("base64");
}

describe("POST /api/auth/verify", () => {
  let app: ReturnType<typeof createApp>;
  let keypair: Keypair;
  let address: string;
  let nonce: string;

  beforeAll(() => {
    app = createApp();
    keypair = createFixtureKeypair();
    address = keypair.publicKey();
    nonce = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns accessToken and expiresIn for valid signature", async () => {
    verifyAndConsume.mockResolvedValueOnce({ nonce, expiresAt: new Date(Date.now() + 300000) });
    upsertUserByStellarAddress.mockResolvedValueOnce({ id: "user-1", stellarAddress: address, createdAt: new Date() });

    const res = await request(app)
      .post("/api/auth/verify")
      .send({
        stellarAddress: address,
        nonce,
        signature: signatureForNonce(keypair, nonce),
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ expiresIn: 3600 });
    expect(res.body.accessToken).toEqual(expect.any(String));

    const decoded: any = jwt.verify(res.body.accessToken, process.env.JWT_SECRET as string);
    expect(decoded.iss).toBe(process.env.JWT_ISSUER);
    expect(decoded.aud).toBe(process.env.JWT_AUDIENCE);
    expect(decoded.sub).toBe(address);
  });

  it("returns 401 challenge_used when nonce reuse is detected", async () => {
    verifyAndConsume.mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/auth/verify")
      .send({
        stellarAddress: address,
        nonce,
        signature: signatureForNonce(keypair, nonce),
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("challenge_used");
  });

  it("supports ETag and returns 304 on match", async () => {
    const mockExpiresAt = new Date(Date.now() + 300000);
    const mockCreatedAt = new Date();

    verifyAndConsume.mockResolvedValueOnce({ nonce, expiresAt: mockExpiresAt });
    upsertUserByStellarAddress.mockResolvedValueOnce({ id: "user-1", stellarAddress: address, createdAt: mockCreatedAt });

    const payload = {
      stellarAddress: address,
      nonce,
      signature: signatureForNonce(keypair, nonce),
    };

    const res = await request(app).post("/api/auth/verify").send(payload);

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();

    const etag = res.headers.etag;

    verifyAndConsume.mockResolvedValueOnce({ nonce, expiresAt: mockExpiresAt });
    upsertUserByStellarAddress.mockResolvedValueOnce({ id: "user-1", stellarAddress: address, createdAt: mockCreatedAt });

    const res304 = await request(app)
      .post("/api/auth/verify")
      .set("If-None-Match", etag)
      .send(payload);

    expect(res304.status).toBe(304);
    expect(res304.body).toEqual({});
  });

  it("returns 401 bad_signature for wrong signer", async () => {
    verifyAndConsume.mockResolvedValueOnce({ nonce, expiresAt: new Date(Date.now() + 300000) });
    const wrongKeypair = Keypair.random();

    const res = await request(app)
      .post("/api/auth/verify")
      .send({
        stellarAddress: address,
        nonce,
        signature: signatureForNonce(wrongKeypair, nonce),
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("bad_signature");
  });

  it("supports ETag and returns 304 on match", async () => {
    verifyAndConsume.mockResolvedValueOnce({ nonce, expiresAt: new Date(Date.now() + 300000) });
    upsertUserByStellarAddress.mockResolvedValueOnce({ id: "user-1", stellarAddress: address, createdAt: new Date() });

    const payload = {
      stellarAddress: address,
      nonce,
      signature: signatureForNonce(keypair, nonce),
    };

    const res = await request(app).post("/api/auth/verify").send(payload);
    
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    
    const etag = res.headers.etag;
    
    // We mock the service again to simulate the same response being generated
    verifyAndConsume.mockResolvedValueOnce({ nonce, expiresAt: new Date(Date.now() + 300000) });
    upsertUserByStellarAddress.mockResolvedValueOnce({ id: "user-1", stellarAddress: address, createdAt: new Date() });

    const res304 = await request(app)
      .post("/api/auth/verify")
      .set("If-None-Match", etag)
      .send(payload);
      
    expect(res304.status).toBe(304);
    expect(res304.body).toEqual({});
  });
});
