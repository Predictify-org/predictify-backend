import request from "supertest";
import express from "express";
import { alertsRouter } from "./alerts";
import { errorHandler } from "../middleware/errorHandler";

jest.mock("../middleware/requireAuth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as { user?: { id: string } }).user = { id: "user-123" };
    next();
  },
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/alerts", alertsRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /api/alerts", () => {
  it("returns 200 with default query", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/alerts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ alerts: [], unreadCount: 0 });
  });

  it("accepts valid filter query params", async () => {
    const app = buildApp();
    const res = await request(app).get(
      "/api/alerts?unreadOnly=true&severity=warning&limit=10",
    );
    expect(res.status).toBe(200);
  });

  it("returns 400 with validation_error code for bad severity", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/alerts?severity=urgent");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.correlationId).toBeDefined();
  });

  it("returns 400 for out-of-range limit", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/alerts?limit=999");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for an unknown query parameter", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/alerts?foo=bar");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("PATCH /api/alerts/read", () => {
  it("marks all as read with empty body", async () => {
    const app = buildApp();
    const res = await request(app).patch("/api/alerts/read").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("marks specific alertIds as read", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/alerts/read")
      .send({ alertIds: ["11111111-1111-1111-1111-111111111111"] });
    expect(res.status).toBe(200);
  });

  it("returns 400 for non-UUID alertIds", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/alerts/read")
      .send({ alertIds: ["bad-id"] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for an unknown body field", async () => {
    const app = buildApp();
    const res = await request(app).patch("/api/alerts/read").send({ extra: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});
