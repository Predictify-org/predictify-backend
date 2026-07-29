/**
 * Tests for GET /api/markets/:id/audit (#216).
 * The DB is mocked; we assert existence handling, shape, and pagination.
 */
import request from "supertest";
import express from "express";

// Queue of results returned by successive `.limit(...)` terminal calls.
const limitResults: unknown[][] = [];

jest.mock("../src/db", () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(() => Promise.resolve(limitResults.shift() ?? [])),
  };
  return { db: chain };
});

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { marketAuditRouter } from "../src/routes/marketAudit";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Mirror how marketsRouter mounts it.
  app.use("/api/markets/:id/audit", marketAuditRouter);
  return app;
}

describe("GET /api/markets/:id/audit", () => {
  beforeEach(() => {
    limitResults.length = 0;
  });

  it("returns 404 when the market does not exist", async () => {
    limitResults.push([]); // existence check → no rows
    const res = await request(makeApp()).get("/api/markets/missing/audit");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 for a malformed limit", async () => {
    const res = await request(makeApp()).get("/api/markets/m1/audit?limit=abc");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns audit entries with a nextCursor when more remain", async () => {
    const now = new Date("2026-06-27T12:00:00.000Z");
    limitResults.push([{ id: "m1" }]); // existence check
    limitResults.push([
      { id: "a1", marketId: "m1", action: "update", createdAt: now },
      { id: "a2", marketId: "m1", action: "disable", createdAt: now },
    ]); // list with take=1 → hasMore

    const res = await request(makeApp()).get("/api/markets/m1/audit?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("a1");
    expect(res.body.nextCursor).not.toBeNull();
  });
});
