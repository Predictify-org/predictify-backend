// Set up environment variables before importing anything that parses them
process.env.JWT_SECRET = "super-secret-key-that-is-at-least-32-bytes-long";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF";
process.env.ADMIN_ALLOWLIST = "G-ADMIN-ADDRESS-1,G-ADMIN-ADDRESS-2";

import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/index";
import { env } from "../src/config/env";

// Mock the DB connection entirely
const mockSelect = jest.fn();
const mockUpdate = jest.fn();
const mockInsert = jest.fn();

const mockTx = {
  select: jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => mockSelect()),
      })),
    })),
  })),
  update: jest.fn(() => ({
    set: jest.fn(() => ({
      where: jest.fn(() => ({
        returning: jest.fn(() => mockUpdate()),
      })),
    })),
  })),
  insert: jest.fn(() => ({
    values: jest.fn(() => mockInsert()),
  })),
};

jest.mock("../src/db", () => {
  return {
    db: {
      transaction: jest.fn((cb) => cb(mockTx)),
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => mockSelect()),
          })),
        })),
      })),
    },
  };
});

describe("PATCH /api/markets/:id", () => {
  let adminToken: string;
  let nonAdminToken: string;

  beforeAll(() => {
    adminToken = jwt.sign({ sub: "G-ADMIN-ADDRESS-1" }, env.JWT_SECRET, {
      audience: env.JWT_AUDIENCE,
      issuer: env.JWT_ISSUER,
    });

    nonAdminToken = jwt.sign({ sub: "G-USER-ADDRESS" }, env.JWT_SECRET, {
      audience: env.JWT_AUDIENCE,
      issuer: env.JWT_ISSUER,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when no token is provided", async () => {
    const res = await request(createApp())
      .patch("/api/markets/market1")
      .send({
        question: "Updated question?",
        expectedVersion: 1,
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 403 when a non-admin token is provided", async () => {
    const res = await request(createApp())
      .patch("/api/markets/market1")
      .set("Authorization", `Bearer ${nonAdminToken}`)
      .send({
        question: "Updated question?",
        expectedVersion: 1,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns 400 when invalid body is provided (strict schema)", async () => {
    const res = await request(createApp())
      .patch("/api/markets/market1")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Updated question?",
        status: "resolved", // Read-only / invalid field for PATCH
        expectedVersion: 1,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 404 when market is not found", async () => {
    mockSelect.mockResolvedValueOnce([]); // No market found

    const res = await request(createApp())
      .patch("/api/markets/nonexistent")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "New question?",
        expectedVersion: 1,
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 409 when there is a version conflict", async () => {
    // Current version is 2, expectedVersion is 1
    mockSelect.mockResolvedValueOnce([
      {
        id: "market1",
        question: "Old question",
        metadata: {},
        version: 2,
      },
    ]);

    const res = await request(createApp())
      .patch("/api/markets/market1")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "Updated question?",
        expectedVersion: 1,
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("version_conflict");
  });

  it("successfully updates market question, increments version, and logs audit entry", async () => {
    mockSelect.mockResolvedValueOnce([
      {
        id: "market1",
        question: "Old question",
        metadata: { category: "crypto" },
        version: 1,
      },
    ]);

    mockUpdate.mockResolvedValueOnce([
      {
        id: "market1",
        question: "New question?",
        metadata: { category: "crypto" },
        version: 2,
      },
    ]);

    mockInsert.mockResolvedValueOnce([]);

    const res = await request(createApp())
      .patch("/api/markets/market1")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        question: "New question?",
        expectedVersion: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.question).toBe("New question?");

    // Verify transaction calls
    expect(mockTx.select).toHaveBeenCalled();
    expect(mockTx.update).toHaveBeenCalled();
    expect(mockTx.insert).toHaveBeenCalled();
  });
});
