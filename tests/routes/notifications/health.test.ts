import express from "express";
import request from "supertest";
import {
  createNotificationsHealthRouter,
  NotificationsHealthDependencyStatus,
} from "../../../src/routes/notifications/health";

function buildApp(
  probeDatabase: () => Promise<NotificationsHealthDependencyStatus>,
): express.Express {
  const app = express();
  app.use(
    "/api/notifications/health",
    createNotificationsHealthRouter({ probeDatabase }),
  );
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : "unknown" });
    },
  );
  return app;
}

describe("GET /api/notifications/health", () => {
  it("returns 200 with status ok when the database probe succeeds", async () => {
    const app = buildApp(async () => ({ status: "ok", latencyMs: 5 }));

    const res = await request(app).get("/api/notifications/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.dependencies.database).toEqual({ status: "ok", latencyMs: 5 });
    expect(typeof res.body.correlationId).toBe("string");
    expect(res.body.correlationId.length).toBeGreaterThan(0);
    expect(typeof res.body.checkedAt).toBe("string");
  });

  it("returns 503 with status down when the database probe fails", async () => {
    const app = buildApp(async () => ({
      status: "down",
      latencyMs: 12,
      error: "connection refused",
    }));

    const res = await request(app).get("/api/notifications/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("down");
    expect(res.body.dependencies.database).toEqual({
      status: "down",
      latencyMs: 12,
      error: "connection refused",
    });
  });

  it("echoes an incoming x-correlation-id header", async () => {
    const app = buildApp(async () => ({ status: "ok", latencyMs: 1 }));

    const res = await request(app)
      .get("/api/notifications/health")
      .set("x-correlation-id", "test-correlation-123");

    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe("test-correlation-123");
  });

  it("passes probe errors to the error handler instead of crashing", async () => {
    const app = buildApp(async () => {
      throw new Error("probe exploded");
    });

    const res = await request(app).get("/api/notifications/health");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("probe exploded");
  });
});
