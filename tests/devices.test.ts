/**
 * Tests for GET /api/me/devices (#214).
 * requireAuth and the DB are mocked; we assert session-family collapsing and
 * that token hashes are never leaked.
 */
import request from "supertest";
import express from "express";

let whereResult: unknown[] = [];

jest.mock("../src/db", () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn(() => Promise.resolve(whereResult)),
  };
  return { db: chain };
});

jest.mock("../src/middleware/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: { id: string; stellarAddress: string } }).user = { id: "user-1", stellarAddress: "GUSER" };
    next();
  },
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { devicesRouter } from "../src/routes/devices";
import { errorHandler } from "../src/middleware/errorHandler";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/me/devices", devicesRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /api/me/devices", () => {
  beforeEach(() => {
    whereResult = [];
  });

  it("collapses refresh-token families into one device each, newest first", async () => {
    const older = new Date("2026-06-20T00:00:00.000Z");
    const newer = new Date("2026-06-27T00:00:00.000Z");
    const exp = new Date("2026-07-27T00:00:00.000Z");
    whereResult = [
      { familyId: "fam-a", createdAt: older, expiresAt: exp },
      { familyId: "fam-a", createdAt: newer, expiresAt: exp }, // rotation within same session
      { familyId: "fam-b", createdAt: older, expiresAt: exp },
    ];

    const res = await request(makeApp()).get("/api/me/devices");

    expect(res.status).toBe(200);
    const devices = res.body.data.devices as Array<{ id: string; createdAt: string }>;
    expect(devices).toHaveLength(2);
    expect(devices[0].id).toBe("fam-a"); // newest session first
    expect(devices[0].createdAt).toBe(newer.toISOString());
    // No token material leaked.
    expect(JSON.stringify(res.body)).not.toContain("tokenHash");
  });

  it("returns an empty list when there are no active sessions", async () => {
    const res = await request(makeApp()).get("/api/me/devices");
    expect(res.status).toBe(200);
    expect(res.body.data.devices).toEqual([]);
  });

  it("rejects unknown query parameters", async () => {
    const res = await request(makeApp()).get("/api/me/devices?unknown=1");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});
