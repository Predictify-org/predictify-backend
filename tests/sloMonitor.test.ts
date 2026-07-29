process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "abcdefghijklmnopqrstuvwxyz123456789012";
process.env.SOROBAN_RPC_URL = "https://testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "test-contract-id";

import { sloMonitor } from "../src/services/sloMonitor";
import { sloConfigMap } from "../src/config/slo";
import { sloViolationsTotal } from "../src/metrics/registry";
import { Request, Response } from "express";

function mockRequest(method: string, path: string): Partial<Request> {
  return {
    method,
    path,
    baseUrl: "",
  };
}

function mockResponse(statusCode: number): Partial<Response> {
  return {
    statusCode,
  };
}

async function getViolationCount(labels: { method: string; route: string; type: string }): Promise<number> {
  const metrics = await sloViolationsTotal.get();
  const metric = metrics.values.find(
    (v) =>
      v.labels.method === labels.method &&
      v.labels.route === labels.route &&
      v.labels.type === labels.type
  );
  return metric?.value ?? 0;
}

describe("SLOMonitor unit tests", () => {
  beforeEach(() => {
    sloMonitor.clear();
    sloViolationsTotal.reset();
  });

  afterAll(() => {
    // Clean up temporary config overrides
    delete sloConfigMap["/test/latency"];
    delete sloConfigMap["/test/error-rate"];
  });

  describe("Latency SLO checks", () => {
    it("does not increment latency violation counter when latency is within limits", async () => {
      sloConfigMap["/test/latency"] = { latencySec: 0.5 };
      const req = mockRequest("GET", "/test/latency") as Request;
      const res = mockResponse(200) as Response;

      sloMonitor.record(req, res, 0.4, "/test/latency");

      const count = await getViolationCount({ method: "GET", route: "/test/latency", type: "latency" });
      expect(count).toBe(0);
    });

    it("increments latency violation counter when latency exceeds limits", async () => {
      sloConfigMap["/test/latency"] = { latencySec: 0.5 };
      const req = mockRequest("GET", "/test/latency") as Request;
      const res = mockResponse(200) as Response;

      sloMonitor.record(req, res, 0.6, "/test/latency");

      const count = await getViolationCount({ method: "GET", route: "/test/latency", type: "latency" });
      expect(count).toBe(1);
    });
  });

  describe("Error rate SLO checks", () => {
    it("does not increment error rate violation counter when error rate is within limits", async () => {
      sloConfigMap["/test/error-rate"] = { errorRate: 0.5, windowSec: 10 };
      const req = mockRequest("POST", "/test/error-rate") as Request;
      const resOk = mockResponse(200) as Response;
      const resErr = mockResponse(500) as Response;

      // 1 OK, 1 Error -> 50% error rate.
      // Under limit if it's <= 0.5
      sloMonitor.record(req, resOk, 0.1, "/test/error-rate");
      sloMonitor.record(req, resErr, 0.1, "/test/error-rate");

      const count = await getViolationCount({ method: "POST", route: "/test/error-rate", type: "error" });
      expect(count).toBe(0);
    });

    it("increments error rate violation counter when error rate exceeds limits", async () => {
      sloConfigMap["/test/error-rate"] = { errorRate: 0.4, windowSec: 10 };
      const req = mockRequest("POST", "/test/error-rate") as Request;
      const resOk = mockResponse(200) as Response;
      const resErr = mockResponse(500) as Response;

      // 2 OK, 2 Errors -> 50% error rate, which is > 40%
      // 1. OK (0/1 = 0%) - count = 0
      // 2. OK (0/2 = 0%) - count = 0
      // 3. Err (1/3 = 33.3%) - count = 0
      // 4. Err (2/4 = 50.0%) - count = 1
      sloMonitor.record(req, resOk, 0.1, "/test/error-rate");
      sloMonitor.record(req, resOk, 0.1, "/test/error-rate");
      sloMonitor.record(req, resErr, 0.1, "/test/error-rate");
      sloMonitor.record(req, resErr, 0.1, "/test/error-rate");

      const count = await getViolationCount({ method: "POST", route: "/test/error-rate", type: "error" });
      expect(count).toBe(1);
    });

    it("evaluates sliding window: evicts samples outside windowSec", async () => {
      sloConfigMap["/test/error-rate"] = { errorRate: 0.1, windowSec: 2 }; // 2 second window
      const req = mockRequest("GET", "/test/error-rate") as Request;
      const resErr = mockResponse(500) as Response;

      const now = Date.now();
      const mockDateNow = jest.spyOn(Date, "now");

      // First sample at t=0 (error)
      mockDateNow.mockReturnValue(now);
      sloMonitor.record(req, resErr, 0.1, "/test/error-rate");

      // Second sample at t=3000ms (error) -> t=0 sample is evicted since t=3000 is > 2000ms window
      // Since it's evicted, we have 1 request in active window, which is 1 error -> 100% error rate
      mockDateNow.mockReturnValue(now + 3000);
      sloMonitor.record(req, resErr, 0.1, "/test/error-rate");

      mockDateNow.mockRestore();

      // Since both records were errors, it should have triggered a violation on both.
      const count = await getViolationCount({ method: "GET", route: "/test/error-rate", type: "error" });
      expect(count).toBe(2);
    });
  });

  describe("Wildcard config fallback", () => {
    it("falls back to * default configuration when route is not explicitly configured", async () => {
      // * is configured in src/config/slo.ts with latencySec = 1
      const req = mockRequest("GET", "/some/unconfigured/route") as Request;
      const res = mockResponse(200) as Response;

      // Over default latencySec of 1s
      sloMonitor.record(req, res, 1.5, "/some/unconfigured/route");

      const count = await getViolationCount({ method: "GET", route: "/some/unconfigured/route", type: "latency" });
      expect(count).toBe(1);
    });
  });
});
