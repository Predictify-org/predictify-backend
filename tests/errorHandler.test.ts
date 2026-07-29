process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "a".repeat(32);
process.env.SOROBAN_RPC_URL = "https://rpc.testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon.testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABC...";

import request from "supertest";
import { ZodError, z } from "zod";
import express from "express";
import { AppError, ErrorCodes } from "../src/errors";
import { RouteError } from "../src/errors/RouteError";

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
    expect(res.body.error.type).toBe("custom_code");
    expect(res.body.error.message).toBe("custom msg");
    expect(res.body.error.correlationId).toEqual(expect.any(String));
  });

  it("handles ZodError with validation envelope", async () => {
    const schema = z.object({ name: z.string().min(1) });
    let zodErr: ZodError | null = null;
    try { schema.parse({ name: "" }); } catch (e) { zodErr = e as ZodError; }

    const app = createAppWithError(zodErr!);
    const res = await request(app).get("/error");
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(res.body.error.message).toBe("Validation failed");
    expect(res.body.error.details).toBeInstanceOf(Array);
    expect(res.body.error.correlationId).toEqual(expect.any(String));
  });

  it("handles unknown error with 500 envelope", async () => {
    const app = createAppWithError(new Error("unexpected"));
    const res = await request(app).get("/error");
    expect(res.status).toBe(500);
    expect(res.body.error.type).toBe(ErrorCodes.INTERNAL_ERROR);
    expect(res.body.error.message).toBe("Internal error");
    expect(res.body.error.correlationId).toEqual(expect.any(String));
  });

  it("does not leak stack traces", async () => {
    const app = createAppWithError(new Error("hidden"));
    const res = await request(app).get("/error");
    expect(res.body.error.stack).toBeUndefined();
    expect(res.text).not.toContain("Error: hidden");
  });

  describe("RouteError handling", () => {
    it("handles NotFound RouteError with 404", async () => {
      const error: RouteError = { kind: "NotFound", message: "User not found", resource: "User" };
      const app = createAppWithError(error);
      const res = await request(app).get("/error");
      expect(res.status).toBe(404);
      expect(res.body.error.type).toBe("NotFound");
      expect(res.body.error.message).toBe("User not found");
      expect(res.body.error.correlationId).toEqual(expect.any(String));
    });

    it("handles Unauthorized RouteError with 401", async () => {
      const error: RouteError = { kind: "Unauthorized", message: "Invalid token" };
      const app = createAppWithError(error);
      const res = await request(app).get("/error");
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe("Unauthorized");
      expect(res.body.error.message).toBe("Invalid token");
      expect(res.body.error.correlationId).toEqual(expect.any(String));
    });

    it("handles Forbidden RouteError with 403", async () => {
      const error: RouteError = {
        kind: "Forbidden",
        message: "Insufficient permissions",
        reason: "admin role required",
      };
      const app = createAppWithError(error);
      const res = await request(app).get("/error");
      expect(res.status).toBe(403);
      expect(res.body.error.type).toBe("Forbidden");
      expect(res.body.error.message).toBe("Insufficient permissions");
      expect(res.body.error.correlationId).toEqual(expect.any(String));
    });

    it("handles ValidationError RouteError with 422 and fields", async () => {
      const error: RouteError = {
        kind: "ValidationError",
        message: "Validation failed",
        fields: { email: ["invalid format"], password: ["too short"] },
      };
      const app = createAppWithError(error);
      const res = await request(app).get("/error");
      expect(res.status).toBe(422);
      expect(res.body.error.type).toBe("ValidationError");
      expect(res.body.error.message).toBe("Validation failed");
      expect(res.body.error.fields).toEqual({
        email: ["invalid format"],
        password: ["too short"],
      });
      expect(res.body.error.correlationId).toEqual(expect.any(String));
    });

    it("handles Conflict RouteError with 409", async () => {
      const error: RouteError = {
        kind: "Conflict",
        message: "Resource already exists",
        resource: "prediction",
      };
      const app = createAppWithError(error);
      const res = await request(app).get("/error");
      expect(res.status).toBe(409);
      expect(res.body.error.type).toBe("Conflict");
      expect(res.body.error.message).toBe("Resource already exists");
      expect(res.body.error.correlationId).toEqual(expect.any(String));
    });

    it("handles BadRequest RouteError with 400", async () => {
      const error: RouteError = {
        kind: "BadRequest",
        message: "Bad request",
        detail: "Missing required field: id",
      };
      const app = createAppWithError(error);
      const res = await request(app).get("/error");
      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("BadRequest");
      expect(res.body.error.message).toBe("Bad request");
      expect(res.body.error.correlationId).toEqual(expect.any(String));
    });

    it("handles InternalError RouteError with 500 and hides cause", async () => {
      const cause = new Error("Database connection failed");
      const error: RouteError = { kind: "InternalError", message: "Internal error", cause };
      const app = createAppWithError(error);
      const res = await request(app).get("/error");
      expect(res.status).toBe(500);
      expect(res.body.error.type).toBe("InternalError");
      expect(res.body.error.message).toBe("An unexpected error occurred");
      expect(res.body.error.correlationId).toEqual(expect.any(String));
      expect(res.text).not.toContain("Database connection failed");
    });

    it("echoes correlationId from x-correlation-id header", async () => {
      const error: RouteError = { kind: "NotFound", message: "Not found" };
      const app = createAppWithError(error);
      const correlationId = "custom-correlation-id-12345";
      const res = await request(app)
        .get("/error")
        .set("x-correlation-id", correlationId);
      expect(res.status).toBe(404);
      expect(res.body.error.correlationId).toBe(correlationId);
    });

    it("generates correlationId when x-correlation-id header is absent", async () => {
      const error: RouteError = { kind: "NotFound", message: "Not found" };
      const app = createAppWithError(error);
      const res = await request(app).get("/error");
      expect(res.status).toBe(404);
      expect(res.body.error.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it("does not leak RouteError cause details to client for InternalError", async () => {
      const cause = new Error("sensitive database error");
      const error: RouteError = { kind: "InternalError", message: "internal error", cause };
      const app = createAppWithError(error);
      const res = await request(app).get("/error");
      expect(res.body).not.toContain("sensitive database error");
      expect(res.text).not.toContain("sensitive database error");
    });
  });
});

describe("RouteErrorFactory", () => {
  it("notFound creates correct RouteError", () => {
    const { RouteErrorFactory } = require("../src/errors/RouteError");
    const err = RouteErrorFactory.notFound("User not found", "User");
    expect(err.kind).toBe("NotFound");
    expect(err.message).toBe("User not found");
    expect(err.resource).toBe("User");
  });

  it("unauthorized creates correct RouteError", () => {
    const { RouteErrorFactory } = require("../src/errors/RouteError");
    const err = RouteErrorFactory.unauthorized("Access denied");
    expect(err.kind).toBe("Unauthorized");
    expect(err.message).toBe("Access denied");
  });

  it("forbidden creates correct RouteError", () => {
    const { RouteErrorFactory } = require("../src/errors/RouteError");
    const err = RouteErrorFactory.forbidden("No permission", "admin only");
    expect(err.kind).toBe("Forbidden");
    expect(err.message).toBe("No permission");
    expect(err.reason).toBe("admin only");
  });

  it("validation creates correct RouteError with fields", () => {
    const { RouteErrorFactory } = require("../src/errors/RouteError");
    const fields = { email: ["invalid"] };
    const err = RouteErrorFactory.validation("Invalid input", fields);
    expect(err.kind).toBe("ValidationError");
    expect(err.message).toBe("Invalid input");
    expect(err.fields).toEqual(fields);
  });

  it("conflict creates correct RouteError", () => {
    const { RouteErrorFactory } = require("../src/errors/RouteError");
    const err = RouteErrorFactory.conflict("Already exists", "resource");
    expect(err.kind).toBe("Conflict");
    expect(err.message).toBe("Already exists");
    expect(err.resource).toBe("resource");
  });

  it("internal creates correct RouteError", () => {
    const { RouteErrorFactory } = require("../src/errors/RouteError");
    const cause = new Error("db error");
    const err = RouteErrorFactory.internal("Something went wrong", cause);
    expect(err.kind).toBe("InternalError");
    expect(err.message).toBe("Something went wrong");
    expect(err.cause).toBe(cause);
  });

  it("badRequest creates correct RouteError", () => {
    const { RouteErrorFactory } = require("../src/errors/RouteError");
    const err = RouteErrorFactory.badRequest("Bad input", "detail");
    expect(err.kind).toBe("BadRequest");
    expect(err.message).toBe("Bad input");
    expect(err.detail).toBe("detail");
  });
});

describe("toErrorEnvelope", () => {
  it("returns type matching error kind", () => {
    const { toErrorEnvelope } = require("../src/errors/RouteError");
    const err: RouteError = { kind: "NotFound", message: "Not found" };
    const envelope = toErrorEnvelope(err, "test-cid");
    expect(envelope.type).toBe("NotFound");
    expect(envelope.message).toBe("Not found");
    expect(envelope.correlationId).toBe("test-cid");
  });

  it("masks InternalError message with generic message", () => {
    const { toErrorEnvelope } = require("../src/errors/RouteError");
    const err: RouteError = { kind: "InternalError", message: "db crash", cause: new Error("crash") };
    const envelope = toErrorEnvelope(err, "test-cid");
    expect(envelope.message).toBe("An unexpected error occurred");
  });

  it("includes fields for ValidationError", () => {
    const { toErrorEnvelope } = require("../src/errors/RouteError");
    const err: RouteError = { kind: "ValidationError", message: "Invalid", fields: { name: ["required"] } };
    const envelope = toErrorEnvelope(err, "test-cid");
    expect(envelope.fields).toEqual({ name: ["required"] });
  });

  it("does not include fields for non-ValidationError", () => {
    const { toErrorEnvelope } = require("../src/errors/RouteError");
    const err: RouteError = { kind: "NotFound", message: "Not found" };
    const envelope = toErrorEnvelope(err, "test-cid");
    expect(envelope.fields).toBeUndefined();
  });
});
