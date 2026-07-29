import { describe, it, expect } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createCorsAllowlistMiddleware } from "../src/middleware/cors";

/**
 * Lightweight error handler for CORS tests.
 * Avoids importing the broken errorHandler.ts.
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

function buildApp(allowedOrigins: string[]) {
  const app = express();
  app.use(express.json());
  const corsMw = createCorsAllowlistMiddleware({ allowedOrigins });
  app.use("/test", corsMw, (_req, res) => {
    res.json({ success: true });
  });
  app.use(testErrorHandler);
  return app;
}

describe("createCorsAllowlistMiddleware", () => {
  describe("origin validation", () => {
    it("allows requests from an allowed origin", async () => {
      const app = buildApp(["https://trusted.example.com"]);
      const res = await request(app)
        .post("/test")
        .set("Origin", "https://trusted.example.com")
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("sets Access-Control-Allow-Origin header", async () => {
      const app = buildApp(["https://trusted.example.com"]);
      const res = await request(app)
        .post("/test")
        .set("Origin", "https://trusted.example.com")
        .send({});
      expect(res.headers["access-control-allow-origin"]).toBe(
        "https://trusted.example.com",
      );
    });

    it("denies requests from an origin not in the allowlist", async () => {
      const app = buildApp(["https://trusted.example.com"]);
      const res = await request(app)
        .post("/test")
        .set("Origin", "https://evil.example.com")
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("denies requests with no Origin header", async () => {
      const app = buildApp(["https://trusted.example.com"]);
      const res = await request(app).post("/test").send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("denies all origins when allowlist is empty", async () => {
      const app = buildApp([]);
      const res = await request(app)
        .post("/test")
        .set("Origin", "https://trusted.example.com")
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe("preflight handling", () => {
    it("responds with 204 for allowed OPTIONS preflight", async () => {
      const app = buildApp(["https://trusted.example.com"]);
      const res = await request(app)
        .options("/test")
        .set("Origin", "https://trusted.example.com");
      expect(res.status).toBe(204);
    });

    it("sets Access-Control-Max-Age on preflight response", async () => {
      const app = buildApp(["https://trusted.example.com"]);
      const res = await request(app)
        .options("/test")
        .set("Origin", "https://trusted.example.com");
      expect(res.headers["access-control-max-age"]).toBe("600");
    });

    it("sets Access-Control-Allow-Methods on preflight", async () => {
      const app = buildApp(["https://trusted.example.com"]);
      const res = await request(app)
        .options("/test")
        .set("Origin", "https://trusted.example.com");
      expect(res.headers["access-control-allow-methods"]).toBeDefined();
    });

    it("denies preflight from disallowed origin", async () => {
      const app = buildApp(["https://trusted.example.com"]);
      const res = await request(app)
        .options("/test")
        .set("Origin", "https://evil.example.com");
      expect(res.status).toBe(403);
    });
  });

  describe("credentials support", () => {
    it("sets Access-Control-Allow-Credentials when enabled", async () => {
      const app = buildApp(["https://trusted.example.com"]);
      const res = await request(app)
        .post("/test")
        .set("Origin", "https://trusted.example.com")
        .send({});
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });
  });
});
