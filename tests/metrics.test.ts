process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";

import request from "supertest";
import { createApp } from "../src/index";

const METRICS_PATH = "/api/metrics";

describe("GET /api/metrics", () => {
  afterEach(() => {
    delete process.env.METRICS_AUTH_TOKEN;
  });

  it("returns 200 when METRICS_AUTH_TOKEN is not set", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const res = await request(createApp()).get(METRICS_PATH);
    expect(res.status).toBe(200);
  });

  it("returns 401 when METRICS_AUTH_TOKEN is set but not provided", async () => {
    process.env.METRICS_AUTH_TOKEN = "secret123";
    const res = await request(createApp()).get(METRICS_PATH);
    expect(res.status).toBe(401);
  });

  it("returns 200 when correct Bearer token is provided", async () => {
    process.env.METRICS_AUTH_TOKEN = "secret123";
    const res = await request(createApp())
      .get(METRICS_PATH)
      .set("Authorization", "Bearer secret123");
    expect(res.status).toBe(200);
  });

  it("returns 401 when wrong token is provided", async () => {
    process.env.METRICS_AUTH_TOKEN = "secret123";
    const res = await request(createApp())
      .get(METRICS_PATH)
      .set("Authorization", "Bearer wrongtoken");
    expect(res.status).toBe(401);
  });

  it("returns the Prometheus text content type", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const res = await request(createApp()).get(METRICS_PATH);
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("contains all custom metric names in the body", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const res = await request(createApp()).get(METRICS_PATH);
    expect(res.text).toContain("http_request_duration_seconds");
    expect(res.text).toContain("indexer_polls_total");
    expect(res.text).toContain("webhook_deliveries_total");
    expect(res.text).toContain("auth_verifications_total");
  });

  it("contains default Node.js metrics", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const res = await request(createApp()).get(METRICS_PATH);
    expect(res.text).toContain("process_cpu_user_seconds_total");
  });

  it("records http_request_duration_seconds after a request to /health", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const app = createApp();
    await request(app).get("/health");
    const res = await request(app).get(METRICS_PATH);
    expect(res.text).toContain("http_request_duration_seconds_count");
  });

  it("records indexer_polls_total after increment", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const { indexerPollsTotal } = await import("../src/metrics/registry");
    indexerPollsTotal.inc();
    const res = await request(createApp()).get(METRICS_PATH);
    const match = res.text.match(/^indexer_polls_total\s+(\d+)/m);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });

  it("records webhook_deliveries_total with status label", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const { webhookDeliveriesTotal } = await import("../src/metrics/registry");
    webhookDeliveriesTotal.inc({ status: "success" });
    webhookDeliveriesTotal.inc({ status: "failed" });
    const res = await request(createApp()).get(METRICS_PATH);
    expect(res.text).toContain('webhook_deliveries_total{status="success"}');
    expect(res.text).toContain('webhook_deliveries_total{status="failed"}');
  });

  it("records auth_verifications_total with outcome label", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const { authVerificationsTotal } = await import("../src/metrics/registry");
    authVerificationsTotal.inc({ outcome: "success" });
    authVerificationsTotal.inc({ outcome: "failure" });
    const res = await request(createApp()).get(METRICS_PATH);
    expect(res.text).toContain('auth_verifications_total{outcome="success"}');
    expect(res.text).toContain('auth_verifications_total{outcome="failure"}');
  });

  it("returns 401 with wrong Bearer scheme", async () => {
    process.env.METRICS_AUTH_TOKEN = "secret123";
    const res = await request(createApp())
      .get(METRICS_PATH)
      .set("Authorization", "Basic secret123");
    expect(res.status).toBe(401);
  });

  it("returns 404 for /metrics (without /api prefix)", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const res = await request(createApp()).get("/metrics");
    expect(res.status).toBe(404);
  });

  it("returns JSON error body on 401", async () => {
    process.env.METRICS_AUTH_TOKEN = "secret123";
    const res = await request(createApp()).get(METRICS_PATH);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: {
        code: "unauthorized",
      },
    });
  });
});
