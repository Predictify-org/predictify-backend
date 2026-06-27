process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";

import request from "supertest";
import { createApp } from "../src/index";

const app = createApp();

describe("CSP header scoping", () => {
  describe("GET /docs", () => {
    it("returns a Content-Security-Policy that allows 'unsafe-inline' scripts", async () => {
      const res = await request(app).get("/docs/").redirects(5);
      const csp = res.headers["content-security-policy"];
      expect(csp).toBeDefined();
      expect(csp).toContain("'unsafe-inline'");
    });

    it("loads Swagger UI HTML successfully", async () => {
      const res = await request(app).get("/docs/").redirects(5);
      expect(res.status).toBe(200);
      expect(res.text).toContain("swagger");
    });
  });

  describe("GET /health (global CSP)", () => {
    it("returns a strict CSP that does NOT allow 'unsafe-inline' scripts", async () => {
      const res = await request(app).get("/health");
      const csp = res.headers["content-security-policy"];
      expect(csp).toBeDefined();
      // Global helmet default CSP should not contain 'unsafe-inline' for scripts
      expect(csp).not.toContain("'unsafe-inline'");
    });
  });

  describe("/docs vs /api CSP differ", () => {
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
