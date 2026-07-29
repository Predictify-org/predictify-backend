/**
 * Tests for POST /api/me/devices/:id/revoke (#215).
 * requireAuth and the DB are mocked.
 */
import request from "supertest";
import express from "express";

let returningResult: unknown[] = [];

jest.mock("../src/db", () => {
  const chain = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn(() => Promise.resolve(returningResult)),
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

import { devicesRevokeRouter } from "../src/routes/devicesRevoke";
import { errorHandler } from "../src/middleware/errorHandler";

const FAMILY = "11111111-1111-1111-1111-111111111111";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/me/devices/:id/revoke", devicesRevokeRouter);
  app.use(errorHandler);
  return app;
}

describe("POST /api/me/devices/:id/revoke", () => {
  beforeEach(() => {
    returningResult = [];
  });

  it("revokes a session and reports the number of tokens revoked", async () => {
    returningResult = [{ id: "t1" }, { id: "t2" }];
    const res = await request(makeApp()).post(`/api/me/devices/${FAMILY}/revoke`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: FAMILY, revoked: 2 });
  });

  it("returns 404 when no active session matches for this user", async () => {
    returningResult = [];
    const res = await request(makeApp()).post(`/api/me/devices/${FAMILY}/revoke`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("rejects a malformed device id", async () => {
    const res = await request(makeApp()).post("/api/me/devices/not-a-uuid/revoke");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});
