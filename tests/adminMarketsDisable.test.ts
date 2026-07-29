// Env setup must precede imports that parse it.
process.env.JWT_SECRET = "super-secret-key-that-is-at-least-32-bytes-long";
process.env.JWT_ISSUER = process.env.JWT_ISSUER || "predictify";
process.env.JWT_AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";
process.env.ADMIN_ALLOWLIST = "GADMIN";

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

jest.mock("../src/services/marketService", () => ({
  disableMarket: jest.fn(),
  MarketAlreadyDisabledError: class extends Error {},
}));

jest.mock("../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { adminMarketsRouter } from "../src/routes/admin/markets";
import {
  disableMarket,
  MarketAlreadyDisabledError,
} from "../src/services/marketService";

const mockDisable = disableMarket as jest.MockedFunction<typeof disableMarket>;

function adminJwt(): string {
  return jwt.sign({ sub: "GADMIN", role: "admin" }, process.env.JWT_SECRET as string, {
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
    expiresIn: "1h",
  });
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/markets", adminMarketsRouter);
  return app;
}

describe("POST /api/admin/markets/disable", () => {
  beforeEach(() => jest.clearAllMocks());

  it("disables a market and returns the updated row", async () => {
    mockDisable.mockResolvedValue({ id: "m1", status: "disabled" });
    const res = await request(makeApp())
      .post("/api/admin/markets/disable")
      .set("Authorization", `Bearer ${adminJwt()}`)
      .send({ marketId: "m1", reason: "spam" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("disabled");
    expect(mockDisable).toHaveBeenCalledWith("m1", "spam", "GADMIN");
  });

  it("rejects requests without admin auth", async () => {
    const res = await request(makeApp())
      .post("/api/admin/markets/disable")
      .send({ marketId: "m1", reason: "spam" });
    expect(res.status).toBe(403);
  });

  it("validates the body", async () => {
    const res = await request(makeApp())
      .post("/api/admin/markets/disable")
      .set("Authorization", `Bearer ${adminJwt()}`)
      .send({ marketId: "m1" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 409 when already disabled", async () => {
    mockDisable.mockRejectedValue(new MarketAlreadyDisabledError());
    const res = await request(makeApp())
      .post("/api/admin/markets/disable")
      .set("Authorization", `Bearer ${adminJwt()}`)
      .send({ marketId: "m1", reason: "spam" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_disabled");
  });
});
