process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";

import express from "express";
import request from "supertest";
import { metricsHistogramMiddleware } from "../src/middleware/metricsHistogram";
import { endpointRequestsTotal, endpointRequestDuration } from "../src/metrics/registry";
import { register } from "../src/metrics/registry";

function makeApp(): express.Express {
  const app = express();
  app.use(metricsHistogramMiddleware);
  app.get("/test", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/test/:id", (req, res) => res.status(200).json({ id: req.params.id }));
  app.post("/test", (_req, res) => res.status(201).json({ ok: true }));
  app.get("/error", (_req, res) => res.status(500).json({ error: "fail" }));
  return app;
}

function counterValue(labels: Record<string, string>): number {
  const key = Object.keys(labels)
    .sort()
    .map((k) => `${k}:${labels[k]}`)
    .join(",") + ",";
  const entry = endpointRequestsTotal.hashMap[key] as { value: number } | undefined;
  return entry?.value ?? 0;
}

describe("metricsHistogramMiddleware per-endpoint metrics", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  describe("GET /test", () => {
    it("increments counter with method, route, and status labels", async () => {
      const before = counterValue({ method: "GET", route: "/test", status: "200" });

      await request(app).get("/test");

      const after = counterValue({ method: "GET", route: "/test", status: "200" });
      expect(after).toBe(before + 1);
    });

    it("observes duration in histogram", async () => {
      await request(app).get("/test");

      const metrics = await endpointRequestDuration.get();
      const metric = metrics.values.find(
        (v) => v.labels.route === "/test" && v.labels.method === "GET",
      );
      expect(metric).toBeDefined();
      expect(metric!.labels.status).toBe("200");
    });
  });

  describe("POST /test", () => {
    it("increments counter with method=POST", async () => {
      const before = counterValue({ method: "POST", route: "/test", status: "201" });

      await request(app).post("/test");

      const after = counterValue({ method: "POST", route: "/test", status: "201" });
      expect(after).toBe(before + 1);
    });
  });

  describe("GET /test/:id", () => {
    it("normalizes UUID in route", async () => {
      const before = counterValue({ method: "GET", route: "/test/:id", status: "200" });

      await request(app).get("/test/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

      const after = counterValue({ method: "GET", route: "/test/:id", status: "200" });
      expect(after).toBe(before + 1);
    });

    it("normalizes numeric ID in route", async () => {
      const before = counterValue({ method: "GET", route: "/test/:id", status: "200" });

      await request(app).get("/test/12345");

      const after = counterValue({ method: "GET", route: "/test/:id", status: "200" });
      expect(after).toBe(before + 1);
    });
  });

  describe("GET /error", () => {
    it("records status=500", async () => {
      const before = counterValue({ method: "GET", route: "/error", status: "500" });

      await request(app).get("/error");

      const after = counterValue({ method: "GET", route: "/error", status: "500" });
      expect(after).toBe(before + 1);
    });
  });

  describe("Prometheus output", () => {
    it("exposes endpoint_requests_total in /metrics", async () => {
      await request(app).get("/test");

      const res = await request(createAppWithMetrics()).get("/api/metrics");
      expect(res.text).toContain("endpoint_requests_total");
    });

    it("exposes endpoint_request_duration_seconds in /metrics", async () => {
      await request(app).get("/test");

      const res = await request(createAppWithMetrics()).get("/api/metrics");
      expect(res.text).toContain("endpoint_request_duration_seconds");
    });
  });

  describe("label structure", () => {
    it("includes method, route, and status labels on histogram", async () => {
      await request(app).get("/test");

      const metrics = await endpointRequestDuration.get();
      const metric = metrics.values.find((v) => v.labels.route === "/test");
      expect(metric).toBeDefined();
      expect(metric!.labels).toHaveProperty("method", "GET");
      expect(metric!.labels).toHaveProperty("status", "200");
    });

    it("includes method, route, and status labels on counter", async () => {
      await request(app).get("/test");

      const metrics = await endpointRequestsTotal.get();
      const metric = metrics.values.find((v) => v.labels.route === "/test");
      expect(metric).toBeDefined();
      expect(metric!.labels).toHaveProperty("method", "GET");
      expect(metric!.labels).toHaveProperty("status", "200");
    });
  });
});

function createAppWithMetrics(): express.Express {
  const app = express();
  app.get("/api/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  });
  return app;
}
