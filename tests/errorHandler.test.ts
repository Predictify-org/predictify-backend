jest.mock("../src/config/env", () => ({
  env: {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    PORT: 0,
    DATABASE_URL: "postgres://mock:5432/db",
    JWT_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
    JWT_ISSUER: "test",
    JWT_AUDIENCE: "test",
    JWT_TTL_SECONDS: 3600,
    STELLAR_NETWORK: "testnet",
    SOROBAN_RPC_URL: "https://soroban.mock",
    HORIZON_URL: "https://horizon.mock",
    PREDICTIFY_CONTRACT_ID: "CCYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    INDEXER_POLL_INTERVAL_MS: 5000,
    INDEXER_START_LEDGER: 0,
  },
}));

import request from "supertest";
import express from "express";
import { z } from "zod";
import { errorHandler } from "../src/middleware/errorHandler";

function buildApp(stub: (req: express.Request, res: express.Response, next: express.NextFunction) => void) {
  const app = express();
  app.use(express.json());
  app.get("/test", stub);
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  describe("ZodError", () => {
    it("returns 400 with validation_error code and details", async () => {
      const app = buildApp(() => {
        z.object({ name: z.string().min(1) }).parse({ name: "" });
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(400);
      expect(res.body).toMatchSnapshot();
    });

    it("includes field paths and messages in details", async () => {
      const app = buildApp(() => {
        z.object({ email: z.string().email(), age: z.number().int().positive() }).parse({ email: "bad", age: -1 });
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.details).toBeInstanceOf(Array);
      expect(res.body.error.details).toHaveLength(2);
      expect(res.body.error.details[0]).toMatchObject({ path: ["email"], message: expect.any(String) });
      expect(res.body.error.details[1]).toMatchObject({ path: ["age"], message: expect.any(String) });
    });
  });

  describe("4xx with status", () => {
    it("returns 404 with not_found code", async () => {
      const app = buildApp((_req, _res, next) => {
        const err = new Error("not found");
        (err as any).status = 404;
        (err as any).code = "not_found";
        next(err);
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found" } });
    });

    it("falls back to request_failed when no code is set", async () => {
      const app = buildApp((_req, _res, next) => {
        const err = new Error("bad request");
        (err as any).status = 400;
        next(err);
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: "request_failed" } });
    });
  });

  describe("500 / unknown", () => {
    it("hides internals for 500 errors", async () => {
      const app = buildApp(() => {
        throw new Error("something went terribly wrong");
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: "internal_error" } });
    });

    it("treats sub-400 status as internal", async () => {
      const app = buildApp((_req, _res, next) => {
        const err = new Error("weird");
        (err as any).status = 399;
        next(err);
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: "internal_error" } });
    });

    it("handles non-Error thrown values", async () => {
      const app = buildApp(() => {
        throw "string error"; // eslint-disable-line no-throw-literal
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: "internal_error" } });
    });
  });
});
