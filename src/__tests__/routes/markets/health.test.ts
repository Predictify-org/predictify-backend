import request from "supertest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createMarketsHealthRouter } from "../../../../src/routes/markets/health";

const MOCK_HEALTH = {
  postgres: { status: "ok" as const, latencyMs: 10 },
  sorobanRpc: { status: "ok" as const, latencyMs: 10 },
  horizon: { status: "ok" as const, latencyMs: 10 },
  webhookQueue: { status: "ok" as const, latencyMs: 10 },
};

describe("Markets Health Router (v7)", () => {
  it("returns 200 OK when all dependencies are healthy", async () => {
    const app = express();
    app.use("/api/markets/health", createMarketsHealthRouter({
      probeFn: async () => MOCK_HEALTH,
    }));

    const res = await request(app).get("/api/markets/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.version).toBe("v7");
    expect(res.body.dependencies).toEqual(MOCK_HEALTH);
  });

  it("returns 207 Multi-Status when some dependencies are degraded", async () => {
    const app = express();
    app.use("/api/markets/health", createMarketsHealthRouter({
      probeFn: async () => ({
        ...MOCK_HEALTH,
        horizon: { status: "degraded", latencyMs: 100 },
      }),
    }));

    const res = await request(app).get("/api/markets/health");

    expect(res.status).toBe(207);
    expect(res.body.status).toBe("degraded");
  });

  it("returns 503 Unavailable when a dependency is down", async () => {
    const app = express();
    app.use("/api/markets/health", createMarketsHealthRouter({
      probeFn: async () => ({
        ...MOCK_HEALTH,
        postgres: { status: "down", latencyMs: 10, error: "timeout" },
      }),
    }));

    const res = await request(app).get("/api/markets/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("down");
  });

  it("propagates errors thrown by probeFn", async () => {
    const app = express();
    app.use("/api/markets/health", createMarketsHealthRouter({
      probeFn: async () => {
        throw new Error("Probe failed miserably");
      },
    }));

    // Add a basic error handler to catch it
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const res = await request(app).get("/api/markets/health");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Probe failed miserably");
  });
});
