import { describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createCorsAllowlistMiddleware } from "../src/middleware/cors";

/**
 * Lightweight error handler for CORS tests.
 * Avoids importing the broken errorHandler.ts which contains a merge conflict.
 */
function testErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
): void {
  const status = (err as { status?: number }).status ?? 500;
  const code = (err as { code?: string }).code ?? "internal_error";
  res.status(status).json({ error: { code } });
}

/**
 * Builds a test app with a cors-protected /api/stats route to verify
 * the CORS allowlist behaviour. Uses createCorsAllowlistMiddleware directly
 * to simulate what statsCors() does, without requiring the full router
 * or DB connections.
 */
function makeApp(allowedOrigins: string[]): express.Express {
  const app = express();
  app.use(express.json());

  const corsMw = createCorsAllowlistMiddleware({
    allowedOrigins,
    allowCredentials: true,
    maxAgeSeconds: 600,
  });

  app.use("/api/stats", corsMw, (_req, res) => {
    res.json({ data: [] });
  });

  app.use(testErrorHandler);
  return app;
}

describe("Stats CORS allowlist enforcement", () => {
  describe("deny-by-default (empty allowlist)", () => {
    it("denies all origins when STATS_CORS_ALLOWED_ORIGINS is empty", async () => {
      const app = makeApp([]);

      const res = await request(app)
        .get("/api/stats")
        .set("Origin", "https://trusted.example.com");

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("denies requests with no Origin header when allowlist is empty", async () => {
      const app = makeApp([]);

      const res = await request(app).get("/api/stats");

      expect(res.status).toBe(403);
    });
  });

  describe("origin validation", () => {
    let app: express.Express;

    beforeEach(() => {
      app = makeApp([
        "http://localhost:5173",
        "https://app.predictify.dev",
      ]);
    });

    it("allows requests from an allowed origin", async () => {
      const res = await request(app)
        .get("/api/stats")
        .set("Origin", "http://localhost:5173");

      expect(res.status).toBe(200);
    });

    it("sets Access-Control-Allow-Origin header on allowed requests", async () => {
      const res = await request(app)
        .get("/api/stats")
        .set("Origin", "http://localhost:5173");

      expect(res.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5173",
      );
    });

    it("sets Access-Control-Allow-Credentials on allowed requests", async () => {
      const res = await request(app)
        .get("/api/stats")
        .set("Origin", "http://localhost:5173");

      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("denies requests from an origin not in the allowlist", async () => {
      const res = await request(app)
        .get("/api/stats")
        .set("Origin", "https://evil.example.com");

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("denies requests with no Origin header", async () => {
      const res = await request(app).get("/api/stats");

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("includes correlationId in the error envelope", async () => {
      const res = await request(app)
        .get("/api/stats")
        .set("Origin", "https://evil.example.com");

      expect(res.body.error.correlationId).toBeDefined();
    });

    it("allows requests from the second configured origin", async () => {
      const res = await request(app)
        .get("/api/stats")
        .set("Origin", "https://app.predictify.dev");

      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(
        "https://app.predictify.dev",
      );
    });
  });

  describe("preflight handling", () => {
    let app: express.Express;

    beforeEach(() => {
      app = makeApp([
        "http://localhost:5173",
        "https://app.predictify.dev",
      ]);
    });

    it("responds with 204 for allowed OPTIONS preflight", async () => {
      const res = await request(app)
        .options("/api/stats")
        .set("Origin", "http://localhost:5173");

      expect(res.status).toBe(204);
    });

    it("sets Access-Control-Max-Age on preflight response", async () => {
      const res = await request(app)
        .options("/api/stats")
        .set("Origin", "http://localhost:5173");

      expect(res.headers["access-control-max-age"]).toBe("600");
    });

    it("sets Access-Control-Allow-Methods on preflight", async () => {
      const res = await request(app)
        .options("/api/stats")
        .set("Origin", "http://localhost:5173");

      expect(res.headers["access-control-allow-methods"]).toBeDefined();
    });

    it("sets Access-Control-Allow-Headers on preflight", async () => {
      const res = await request(app)
        .options("/api/stats")
        .set("Origin", "http://localhost:5173");

      expect(res.headers["access-control-allow-headers"]).toContain(
        "Content-Type",
      );
      expect(res.headers["access-control-allow-headers"]).toContain(
        "Authorization",
      );
    });

    it("denies preflight from disallowed origin", async () => {
      const res = await request(app)
        .options("/api/stats")
        .set("Origin", "https://evil.example.com");

      expect(res.status).toBe(403);
    });
  });
});
