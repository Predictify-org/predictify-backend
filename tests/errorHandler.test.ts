process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "a".repeat(32);
process.env.SOROBAN_RPC_URL = "https://rpc.testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon.testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABC...";

import request from "supertest";
import { ZodError, z } from "zod";
import express from "express";
import { AppError, ErrorCodes } from "../src/errors";

describe("AppError", () => {
  it("creates an error with code, message, status", () => {
    const err = new AppError("my_code", "my message", 400);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("my_code");
    expect(err.message).toBe("my message");
    expect(err.status).toBe(400);
    expect(err.details).toBeUndefined();
  });

  it("creates an error with details", () => {
    const err = new AppError("my_code", "my message", 422, { field: "name" });
    expect(err.details).toEqual({ field: "name" });
  });

  it("defaults to 500", () => {
    const err = new AppError("my_code", "msg");
    expect(err.status).toBe(500);
  });

  describe("static factories", () => {
    it("notFound creates 404", () => {
      const err = AppError.notFound("X not found");
      expect(err.code).toBe(ErrorCodes.NOT_FOUND);
      expect(err.status).toBe(404);
      expect(err.message).toBe("X not found");
    });

    it("internal creates 500", () => {
      const err = AppError.internal("Boom");
      expect(err.code).toBe(ErrorCodes.INTERNAL_ERROR);
      expect(err.status).toBe(500);
      expect(err.message).toBe("Boom");
    });

    it("validation creates 400", () => {
      const err = AppError.validation({ fields: ["email"] });
      expect(err.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(err.status).toBe(400);
      expect(err.details).toEqual({ fields: ["email"] });
    });
  });
});

describe("GET /api/markets/:id", () => {
  it("returns 404 with standard envelope for unknown market", async () => {
    const { createApp } = await import("../src/index");
    const res = await request(createApp()).get("/api/markets/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("not_found");
    expect(res.body.error.message).toBe("Market not found");
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });
});

describe("errorHandler", () => {
  function createAppWithError(err: unknown): express.Express {
    const app = express();
    app.use(express.json());
    app.get("/error", () => { throw err; });
    const { errorHandler } = require("../src/middleware/errorHandler");
    app.use(errorHandler);
    return app;
  }

  it("handles AppError with correct envelope", async () => {
    const app = createAppWithError(new AppError("custom_code", "custom msg", 418));
    const res = await request(app).get("/error");
    expect(res.status).toBe(418);
    expect(res.body.error.code).toBe("custom_code");
    expect(res.body.error.message).toBe("custom msg");
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });

  it("handles ZodError with validation envelope", async () => {
    const schema = z.object({ name: z.string().min(1) });
    let zodErr: ZodError | null = null;
    try { schema.parse({ name: "" }); } catch (e) { zodErr = e as ZodError; }

    const app = createAppWithError(zodErr!);
    const res = await request(app).get("/error");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(res.body.error.message).toBe("Validation failed");
    expect(res.body.error.details).toBeInstanceOf(Array);
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });

  it("handles unknown error with 500 envelope", async () => {
    const app = createAppWithError(new Error("unexpected"));
    const res = await request(app).get("/error");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe(ErrorCodes.INTERNAL_ERROR);
    expect(res.body.error.message).toBe("Internal error");
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });

  it("does not leak stack traces", async () => {
    const app = createAppWithError(new Error("hidden"));
    const res = await request(app).get("/error");
    expect(res.body.error.stack).toBeUndefined();
    expect(res.text).not.toContain("Error: hidden");
  });
});
