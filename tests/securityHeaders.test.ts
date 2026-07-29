process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";

import express from "express";
import request from "supertest";
import {
  securityHeaders,
  API_SECURITY_HEADERS,
} from "../src/middleware/securityHeaders";

function makeApp() {
  const app = express();
  app.use("/probe", securityHeaders, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("securityHeaders middleware", () => {
  const app = makeApp();

  it("sets Content-Security-Policy, X-Content-Type-Options, and Referrer-Policy", async () => {
    const res = await request(app).get("/probe");

    for (const [header, value] of Object.entries(API_SECURITY_HEADERS)) {
      expect(res.headers[header.toLowerCase()]).toBe(value);
    }
  });

  it("uses a deny-all CSP appropriate for a JSON-only endpoint", async () => {
    const res = await request(app).get("/probe");
    const csp = res.headers["content-security-policy"];

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("does not block the request — the handler still runs", async () => {
    const res = await request(app).get("/probe");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
