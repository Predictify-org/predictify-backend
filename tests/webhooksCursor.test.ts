import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/index";
import { WebhookDispatcher, type HttpSender } from "../src/services/webhookDispatcher";
import { InMemoryWebhookStore } from "../src/services/webhookStore";

const JWT_SECRET = "test-jwt-secret-at-least-32-bytes-long-000000";
const SIGNING_SECRET = "test-webhook-signing-secret";

function token(role?: string) {
  return jwt.sign({ sub: "user_1", ...(role ? { role } : {}) }, JWT_SECRET, {
    issuer: "predictify",
    audience: "predictify-app",
    expiresIn: "5m",
  });
}

const adminAuth = { Authorization: `Bearer ${token("admin")}` };

function buildHarness(send: HttpSender = async () => ({ status: 200 })) {
  const store = new InMemoryWebhookStore();
  const dispatcher = new WebhookDispatcher({
    store,
    send,
    signingSecret: SIGNING_SECRET,
    backoffMs: () => 0,
  });
  const app = createApp({ webhooks: { store, dispatcher } });
  return { app, dispatcher };
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

describe("GET /api/webhooks", () => {
  it("paginates live webhook deliveries without overlap", async () => {
    const { app, dispatcher } = buildHarness();
    await seedDeliveries(dispatcher, 5);

    const p1 = await request(app).get("/api/webhooks?limit=2").set(adminAuth);
    expect(p1.status).toBe(200);
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.nextCursor).toEqual(expect.any(String));

    const p2 = await request(app)
      .get(`/api/webhooks?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set(adminAuth);
    expect(p2.status).toBe(200);
    expect(p2.body.data).toHaveLength(2);

    const ids = [...p1.body.data, ...p2.body.data].map((row: { id: string }) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("orders by createdAt DESC with id as a stable tie-breaker", async () => {
    const { app, dispatcher } = buildHarness();
    await seedDeliveries(dispatcher, 4);

    const res = await request(app).get("/api/webhooks?limit=4").set(adminAuth);
    expect(res.status).toBe(200);

    const rows: Array<{ createdAt: string; id: string }> = res.body.data;
    for (let i = 0; i < rows.length - 1; i++) {
      const current = rows[i]!;
      const next = rows[i + 1]!;
      expect(`${current.createdAt}:${current.id}` >= `${next.createdAt}:${next.id}`).toBe(true);
    }
  });

  it("returns a validation envelope for invalid query params", async () => {
    const { app } = buildHarness();
    const res = await request(app).get("/api/webhooks?limit=abc").set(adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "validation_error",
      message: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it("serializes payload bytes as base64", async () => {
    const { app, dispatcher } = buildHarness();
    await dispatcher.enqueue({
      eventId: "evt_payload",
      eventType: "market.resolved",
      targetUrl: "https://example.test/hook",
      payload: Buffer.from("signed-body"),
    });

    const res = await request(app).get("/api/webhooks").set(adminAuth);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.data[0].payloadBase64, "base64").toString("utf8")).toBe(
      "signed-body",
    );
  });
});
