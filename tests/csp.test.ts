process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";

import express from "express";
import request from "supertest";
import {
  createDocsCspMiddleware,
  createGlobalCspMiddleware,
} from "../src/middleware/csp";
import { createDocsRouter } from "../src/routes/docs";
import { healthRouter } from "../src/routes/health";

function makeApp() {
  const app = express();
  app.use("/docs", createDocsCspMiddleware(), createDocsRouter());
  app.use(createGlobalCspMiddleware());
  app.use("/health", healthRouter);
  return app;
}

describe("CSP header scoping", () => {
  const app = makeApp();

  describe("GET /docs", () => {
    it("returns a Content-Security-Policy that allows Swagger UI inline assets", async () => {
      const res = await request(app).get("/docs/").redirects(5);
      const csp = res.headers["content-security-policy"];
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src");
      expect(csp).toContain("style-src");
      expect(csp).toContain("'unsafe-inline'");
    });

    it("allows the Swagger CDN on the docs route only", async () => {
      const res = await request(app).get("/docs/").redirects(5);
      const csp = res.headers["content-security-policy"];
      expect(csp).toContain("https://cdn.jsdelivr.net");
    });

    it("loads Swagger UI HTML successfully", async () => {
      const res = await request(app).get("/docs/").redirects(5);
      expect(res.status).toBe(200);
      expect(res.text).toContain("swagger");
    });
  });

  describe("GET /health (global CSP)", () => {
    it("returns a strict CSP that does NOT allow inline or Swagger CDN scripts", async () => {
      const res = await request(app).get("/health");
      const csp = res.headers["content-security-policy"];
      expect(csp).toBeDefined();
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).not.toContain("https://cdn.jsdelivr.net");
    });
  });

  describe("/docs vs /health CSP differ", () => {
    it("has different CSP header values for /docs and /health", async () => {
      const [docsRes, healthRes] = await Promise.all([
        request(app).get("/docs/").redirects(5),
        request(app).get("/health"),
      ]);

      const docsCsp = docsRes.headers["content-security-policy"];
      const healthCsp = healthRes.headers["content-security-policy"];

      expect(docsCsp).toBeDefined();
      expect(healthCsp).toBeDefined();
      expect(docsCsp).not.toEqual(healthCsp);
    });
  });
});
