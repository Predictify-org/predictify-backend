/**
 * Tests for the idempotency-key cleanup worker and internal trigger route (#212).
 */
import request from "supertest";
import express from "express";

const whereMock = jest.fn();

jest.mock("../src/db", () => ({
  db: {
    delete: jest.fn(() => ({ where: whereMock })),
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { cleanupIdempotencyKeys } from "../src/workers/cleanupIdempotency";
import { internalJobsRouter } from "../src/routes/internal/jobs";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/internal/jobs", internalJobsRouter);
  return app;
}

describe("cleanupIdempotencyKeys", () => {
  beforeEach(() => jest.clearAllMocks());

  it("deletes expired rows and returns the rowCount", async () => {
    whereMock.mockResolvedValue({ rowCount: 7 });
    const deleted = await cleanupIdempotencyKeys();
    expect(deleted).toBe(7);
  });

  it("returns 0 when rowCount is absent", async () => {
    whereMock.mockResolvedValue({});
    expect(await cleanupIdempotencyKeys()).toBe(0);
  });
});

describe("POST /api/internal/jobs/cleanup-idempotency-keys", () => {
  const ORIGINAL = process.env.INTERNAL_JOB_TOKEN;
  afterEach(() => {
    process.env.INTERNAL_JOB_TOKEN = ORIGINAL;
    jest.clearAllMocks();
  });

  it("404s when no internal token is configured (fail closed)", async () => {
    delete process.env.INTERNAL_JOB_TOKEN;
    const res = await request(makeApp()).post(
      "/api/internal/jobs/cleanup-idempotency-keys",
    );
    expect(res.status).toBe(404);
  });

  it("401s with a wrong token", async () => {
    process.env.INTERNAL_JOB_TOKEN = "secret";
    const res = await request(makeApp())
      .post("/api/internal/jobs/cleanup-idempotency-keys")
      .set("Authorization", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("runs the cleanup with a valid token", async () => {
    process.env.INTERNAL_JOB_TOKEN = "secret";
    whereMock.mockResolvedValue({ rowCount: 3 });
    const res = await request(makeApp())
      .post("/api/internal/jobs/cleanup-idempotency-keys")
      .set("Authorization", "Bearer secret");
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(3);
  });
});
