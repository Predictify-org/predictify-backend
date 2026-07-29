import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { WebhookDispatcher, type HttpSender } from "../src/services/webhookDispatcher";
import { InMemoryWebhookStore } from "../src/services/webhookStore";
import { createWebhooksRouter } from "../src/routes/webhooks";
import { createAdminWebhooksRouter } from "../src/routes/adminWebhooks";
import { errorHandler } from "../src/middleware/errorHandler";
import { requestContextStorage } from "../src/lib/requestContext";
import {
  listWebhooksQuerySchema,
  dlqQuerySchema,
  dlqReplayParamsSchema,
} from "../src/validators/webhooks";

const JWT_SECRET = "test-jwt-secret-that-is-at-least-32-chars!";
const SIGNING_SECRET = "test-webhook-signing-secret";

function token(role?: string) {
  return jwt.sign({ sub: "user_1", ...(role ? { role } : {}) }, JWT_SECRET, {
    issuer: "predictify",
    audience: "predictify-app",
    expiresIn: "5m",
  });
}

const adminAuth = { Authorization: `Bearer ${token("admin")}` };
const userAuth = { Authorization: `Bearer ${token()}` };

function buildHarness(send: HttpSender = async () => ({ status: 200 })) {
  const store = new InMemoryWebhookStore();
  const dispatcher = new WebhookDispatcher({
    store,
    send,
    signingSecret: SIGNING_SECRET,
    backoffMs: () => 0,
  });
  const app = express();
  app.use(express.json());
  app.use(
    (
      req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) => {
      const requestId = uuidv4();
      (req as { id?: string }).id = requestId;
      requestContextStorage.run({ requestId }, next);
    },
  );
  app.use("/api/webhooks", createWebhooksRouter({ store }));
  app.use(
    "/api/admin/webhooks",
    createAdminWebhooksRouter({ store, dispatcher }),
  );
  app.use(errorHandler);
  return { app, store, dispatcher };
}

async function seedDeliveries(dispatcher: WebhookDispatcher, n: number) {
  for (let i = 0; i < n; i++) {
    await dispatcher.enqueue({
      eventId: `evt_${i}`,
      eventType: "market.resolved",
      targetUrl: "https://example.test/hook",
      payload: Buffer.from(`body-${i}`),
      maxAttempts: 3,
    });
  }
}

// ---------------------------------------------------------------------------
// Schema unit tests
// ---------------------------------------------------------------------------

describe("listWebhooksQuerySchema", () => {
  it("accepts empty query", () => {
    const result = listWebhooksQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid cursor and limit", () => {
    const result = listWebhooksQuerySchema.safeParse({
      cursor: "abc123",
      limit: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cursor).toBe("abc123");
      expect(result.data.limit).toBe(10);
    }
  });

  it("accepts string limit that coerces to number", () => {
    const result = listWebhooksQuerySchema.safeParse({ limit: "25" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });

  it("rejects empty cursor string", () => {
    const result = listWebhooksQuerySchema.safeParse({ cursor: "" });
    expect(result.success).toBe(false);
  });

  it("rejects limit of zero", () => {
    const result = listWebhooksQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative limit", () => {
    const result = listWebhooksQuerySchema.safeParse({ limit: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer limit", () => {
    const result = listWebhooksQuerySchema.safeParse({ limit: 3.5 });
    expect(result.success).toBe(false);
  });

  it("rejects limit exceeding max of 100", () => {
    const result = listWebhooksQuerySchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown query parameters", () => {
    const result = listWebhooksQuerySchema.safeParse({
      limit: 10,
      unknown: "value",
    });
    expect(result.success).toBe(false);
  });
});

describe("dlqQuerySchema", () => {
  it("accepts empty query", () => {
    const result = dlqQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid cursor and limit", () => {
    const result = dlqQuerySchema.safeParse({
      cursor: "abc123",
      limit: 50,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown query parameters", () => {
    const result = dlqQuerySchema.safeParse({ foo: "bar" });
    expect(result.success).toBe(false);
  });

  it("rejects limit of zero", () => {
    const result = dlqQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects limit exceeding 100", () => {
    const result = dlqQuerySchema.safeParse({ limit: 150 });
    expect(result.success).toBe(false);
  });
});

describe("dlqReplayParamsSchema", () => {
  it("accepts valid UUID", () => {
    const result = dlqReplayParamsSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid UUID format", () => {
    const result = dlqReplayParamsSchema.safeParse({ id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects empty string", () => {
    const result = dlqReplayParamsSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects UUID-like string with wrong length", () => {
    const result = dlqReplayParamsSchema.safeParse({
      id: "550e8400-e29b-41d4-a716",
    });
    expect(result.success).toBe(false);
  });

  it("rejects string with non-hex characters", () => {
    const result = dlqReplayParamsSchema.safeParse({
      id: "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/webhooks — integration validation tests
// ---------------------------------------------------------------------------

describe("GET /api/webhooks validation", () => {
  it("returns 403 without auth", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks");
    expect(res.status).toBe(403);
  });

  it("returns 403 for non-admin token", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks").set(userAuth);
    expect(res.status).toBe(403);
  });

  it("returns 200 for admin with no query params", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks").set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("nextCursor");
  });

  it("returns 400 for non-numeric limit", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks?limit=abc").set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "validation_error",
      message: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it("returns 400 for limit exceeding max", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks?limit=200").set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for negative limit", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks?limit=-1").set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for empty cursor", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks?cursor=").set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for unknown query parameters", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks?unknown=param").set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 200 for valid limit", async () => {
    const { app, dispatcher } = buildHarness();
    await seedDeliveries(dispatcher, 5);
    const res = await request(app).get("/api/webhooks?limit=3").set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it("returns 200 for valid cursor and limit", async () => {
    const { app, dispatcher } = buildHarness();
    await seedDeliveries(dispatcher, 5);

    const p1 = await request(app).get("/api/webhooks?limit=2").set(adminAuth);
    expect(p1.status).toBe(200);
    expect(p1.body.nextCursor).toBeTruthy();

    const p2 = await request(app)
      .get(`/api/webhooks?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set(adminAuth);
    expect(p2.status).toBe(200);
    expect(p2.body.data).toHaveLength(2);
  });

  it("includes requestId in validation error response", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks?limit=abc").set(adminAuth);
    expect(res.status).toBe(400);
    expect(typeof res.body.error.requestId).toBe("string");
    expect(res.body.error.requestId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/webhooks/dlq — integration validation tests
// ---------------------------------------------------------------------------

describe("GET /api/admin/webhooks/dlq validation", () => {
  it("returns 403 without auth", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/admin/webhooks/dlq");
    expect(res.status).toBe(403);
  });

  it("returns 200 for admin with no query params", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/admin/webhooks/dlq").set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("nextCursor");
  });

  it("returns 400 for non-numeric limit", async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .get("/api/admin/webhooks/dlq?limit=abc")
      .set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "validation_error",
      message: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it("returns 400 for limit exceeding max", async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .get("/api/admin/webhooks/dlq?limit=200")
      .set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for unknown query parameters", async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .get("/api/admin/webhooks/dlq?bad=param")
      .set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/webhooks/dlq/:id/replay — integration validation tests
// ---------------------------------------------------------------------------

describe("POST /api/admin/webhooks/dlq/:id/replay validation", () => {
  it("returns 403 without auth", async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .post("/api/admin/webhooks/dlq/550e8400-e29b-41d4-a716-446655440000/replay")
      .send();
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid UUID format", async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .post("/api/admin/webhooks/dlq/not-a-uuid/replay")
      .set(adminAuth)
      .send();
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent DLQ row", async () => {
    const { app } = buildHarness();
    const res = await request(app)
      .post(
        "/api/admin/webhooks/dlq/550e8400-e29b-41d4-a716-446655440000/replay",
      )
      .set(adminAuth)
      .send();
    expect(res.status).toBe(404);
  });
});
