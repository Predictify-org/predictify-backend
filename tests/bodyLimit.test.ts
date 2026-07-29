import request from "supertest";
import express from "express";
import { createBodySizeLimitMiddleware, DEFAULT_BODY_LIMIT, WEBHOOK_BODY_LIMIT } from "../src/middleware/bodySize";
import { errorHandler } from "../src/middleware/errorHandler";

function buildApp(path: string, limit?: string) {
  const app = express();
  app.use(path, createBodySizeLimitMiddleware(limit ? { limit } : undefined));
  app.post(path, (req, res) => {
    res.status(200).json({ ok: true, size: JSON.stringify(req.body).length });
  });
  app.use(errorHandler);
  return app;
}

describe("body size limit middleware", () => {
  it("uses 256kb as the default body limit", async () => {
    const app = buildApp("/default");
    const withinLimit = "a".repeat(240 * 1024);

    const res = await request(app)
      .post("/default")
      .send({ payload: withinLimit });

    expect(res.status).toBe(200);
    expect(DEFAULT_BODY_LIMIT).toBe("256kb");
  });

  it("returns a standardized 413 envelope when the default limit is exceeded", async () => {
    const app = buildApp("/default");
    const tooLarge = "a".repeat(270 * 1024);

    const res = await request(app)
      .post("/default")
      .send({ payload: tooLarge });

    expect(res.status).toBe(413);
    expect(res.body.error.type).toBe("request_failed");
    expect(res.body.error.message).toBe("Request body too large");
    expect(res.body.error.correlationId).toEqual(expect.any(String));
    expect(res.body.error.details.limit).toBeGreaterThanOrEqual(256 * 1024);
  });

  it("allows a per-route override up to 1mb for webhook-style routes", async () => {
    const app = buildApp("/webhook", WEBHOOK_BODY_LIMIT);
    const allowed = "a".repeat(900 * 1024);

    const res = await request(app)
      .post("/webhook")
      .send({ payload: allowed });

    expect(res.status).toBe(200);
    expect(WEBHOOK_BODY_LIMIT).toBe("1mb");
  });

  it("still returns 413 when the webhook override is exceeded", async () => {
    const app = buildApp("/webhook", WEBHOOK_BODY_LIMIT);
    const tooLarge = "a".repeat(1100 * 1024);

    const res = await request(app)
      .post("/webhook")
      .send({ payload: tooLarge });

    expect(res.status).toBe(413);
    expect(res.body.error.type).toBe("request_failed");
    expect(res.body.error.message).toBe("Request body too large");
    expect(res.body.error.details.limit).toBeGreaterThanOrEqual(1024 * 1000);
  });
});
