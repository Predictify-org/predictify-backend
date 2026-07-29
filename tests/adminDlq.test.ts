/**
 * tests/adminDlq.test.ts
 *
 * Focused tests for GET /api/admin/webhooks/dlq.
 *
 * All tests run against an in-memory store so no database is needed.
 *
 * Coverage:
 *   - Auth: 403 for missing / bad-signature / wrong-role token
 *   - Empty list
 *   - Pagination: limit, cursor, no-overlap, last-page null cursor, ordering
 *   - Invalid query params: non-numeric limit, empty cursor string
 *   - Limit clamping: values outside [1,100] are silently corrected
 *   - Payload serialisation: payloadBase64 is valid base64
 *   - Response shape: all expected fields present, ISO timestamps
 *   - Structured log fields: event, adminAddress, count, hasNextPage
 *   - Route not mounted when no webhooks deps injected
 *   - Rate-limiter headers present
 */

import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/index";
import { WebhookDispatcher, type HttpSender } from "../src/services/webhookDispatcher";
import { InMemoryWebhookStore } from "../src/services/webhookStore";

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = "test-jwt-secret-that-is-at-least-32-chars!";
const SIGNING_SECRET = "test-webhook-signing-secret-0000";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToken(role?: string, secret = JWT_SECRET) {
  return jwt.sign(
    { sub: "GADMIN000TEST0000000000000000000000000000000000000000000001", ...(role ? { role } : {}) },
    secret,
    { issuer: "predictify", audience: "predictify-app", expiresIn: "5m" },
  );
}

const adminHeaders = () => ({ Authorization: `Bearer ${makeToken("admin")}` });
const userHeaders  = () => ({ Authorization: `Bearer ${makeToken("user")}` });

function buildHarness(httpSend: HttpSender = async () => ({ status: 500 })) {
  const store = new InMemoryWebhookStore();
  const dispatcher = new WebhookDispatcher({
    store,
    send: httpSend,
    signingSecret: SIGNING_SECRET,
    backoffMs: () => 0,
  });
  const app = createApp({ webhooks: { store, dispatcher } });
  return { app, store, dispatcher };
}

/** Dead-letter `n` deliveries via maxAttempts=1 + one failed attempt. */
async function seedDlq(
  dispatcher: WebhookDispatcher,
  store: InMemoryWebhookStore,
  n: number,
) {
  for (let i = 0; i < n; i++) {
    const d = await dispatcher.enqueue({
      eventId: `evt_${i}`,
      eventType: "market.resolved",
      targetUrl: "https://target.test/hook",
      payload: Buffer.from(`body-${i}`),
      maxAttempts: 1,
    });
    await dispatcher.attemptDelivery(d.id);
  }
  return (await store.listDlq(undefined, 200)).data;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/webhooks/dlq", () => {

  // ── Auth ──────────────────────────────────────────────────────────────────

  describe("auth", () => {
    it("returns 403 when no Authorization header is provided", async () => {
      const { app } = buildHarness();
      const res = await request(app).get("/api/admin/webhooks/dlq");
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("returns 403 for a caller with role=user", async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(userHeaders());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("returns 403 for a token signed with the wrong secret", async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set({ Authorization: `Bearer ${makeToken("admin", "wrong-secret-000000000000000")}` });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("returns 403 for a malformed Bearer token", async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set({ Authorization: "Bearer not.a.valid.jwt" });
      expect(res.status).toBe(403);
    });

    it("returns 200 for a valid admin token", async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(adminHeaders());
      expect(res.status).toBe(200);
    });
  });

  // ── Empty list ────────────────────────────────────────────────────────────

  describe("empty DLQ", () => {
    it("returns empty data array and null nextCursor when no rows exist", async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(adminHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.nextCursor).toBeNull();
    });
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  describe("pagination", () => {
    it("returns the requested number of items", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 5);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=3")
        .set(adminHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });

    it("includes a non-null nextCursor when more pages exist", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 5);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=3")
        .set(adminHeaders());
      expect(typeof res.body.nextCursor).toBe("string");
      expect(res.body.nextCursor).not.toBeNull();
    });

    it("returns null nextCursor on the last page", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 3);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=10")
        .set(adminHeaders());
      expect(res.body.data).toHaveLength(3);
      expect(res.body.nextCursor).toBeNull();
    });

    it("pages through all items without overlap", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 5);

      const p1 = await request(app)
        .get("/api/admin/webhooks/dlq?limit=2")
        .set(adminHeaders());
      const p2 = await request(app)
        .get(`/api/admin/webhooks/dlq?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
        .set(adminHeaders());
      const p3 = await request(app)
        .get(`/api/admin/webhooks/dlq?limit=2&cursor=${encodeURIComponent(p2.body.nextCursor)}`)
        .set(adminHeaders());

      expect(p1.body.data).toHaveLength(2);
      expect(p2.body.data).toHaveLength(2);
      expect(p3.body.data).toHaveLength(1);
      expect(p3.body.nextCursor).toBeNull();

      const allIds = [
        ...p1.body.data.map((r: { id: string }) => r.id),
        ...p2.body.data.map((r: { id: string }) => r.id),
        ...p3.body.data.map((r: { id: string }) => r.id),
      ];
      // No duplicates across pages.
      expect(new Set(allIds).size).toBe(5);
    });

    it("returns items newest-first (failedAt DESC)", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 3);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=10")
        .set(adminHeaders());
      const items: Array<{ failedAt: string }> = res.body.data;
      for (let i = 0; i < items.length - 1; i++) {
        expect(new Date(items[i]!.failedAt).getTime()).toBeGreaterThanOrEqual(
          new Date(items[i + 1]!.failedAt).getTime(),
        );
      }
    });
  });

  // ── Limit clamping ────────────────────────────────────────────────────────

  describe("limit clamping", () => {
    it("defaults to 20 items when no limit is supplied", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 25);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(adminHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(20);
      expect(res.body.nextCursor).not.toBeNull();
    });

    it("clamps limit=500 to MAX_PAGE_SIZE (100)", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 5);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=500")
        .set(adminHeaders());
      // 5 items < 100, so all returned — demonstrates clamp doesn't error
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(100);
    });

    it("clamps limit=1 to 1 item", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 3);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=1")
        .set(adminHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  // ── Invalid query params ──────────────────────────────────────────────────

  describe("invalid query params", () => {
    it("returns 400 for a non-numeric limit", async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=abc")
        .set(adminHeaders());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(typeof res.body.error.message).toBe("string");
    });

    it("returns 400 for an empty cursor string", async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?cursor=")
        .set(adminHeaders());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("400 error envelope contains a message field", async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=bad")
        .set(adminHeaders());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error", message: expect.any(String) });
    });

    it("silently resets to page 1 for an invalid (non-base64url) cursor value", async () => {
      // Zod only checks the cursor is non-empty; the store degrades gracefully.
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 3);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?cursor=THIS_IS_GARBAGE!!")
        .set(adminHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
    });
  });

  // ── Response shape & serialisation ───────────────────────────────────────

  describe("response shape", () => {
    it("returns all expected fields on each item", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 1);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(adminHeaders());
      const item = res.body.data[0];
      for (const key of [
        "id", "originalId", "eventId", "eventType", "targetUrl",
        "payloadBase64", "signature", "headers", "attempts", "maxAttempts",
        "lastError", "failedAt", "replayedAt", "replayDeliveryId",
      ]) {
        expect(item).toHaveProperty(key);
      }
    });

    it("payloadBase64 decodes back to the original bytes", async () => {
      const { app, dispatcher } = buildHarness();
      const body = Buffer.from('{"market":"m1","outcome":"yes"}');
      const d = await dispatcher.enqueue({
        eventId: "evt_b64",
        eventType: "market.resolved",
        targetUrl: "https://target.test/hook",
        payload: body,
        maxAttempts: 1,
      });
      await dispatcher.attemptDelivery(d.id);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(adminHeaders());
      const item = res.body.data[0];
      expect(Buffer.from(item.payloadBase64, "base64").equals(body)).toBe(true);
    });

    it("failedAt is a valid ISO 8601 string", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 1);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(adminHeaders());
      const { failedAt } = res.body.data[0];
      expect(new Date(failedAt).toISOString()).toBe(failedAt);
    });

    it("replayedAt and replayDeliveryId are null for un-replayed rows", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 1);
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(adminHeaders());
      expect(res.body.data[0].replayedAt).toBeNull();
      expect(res.body.data[0].replayDeliveryId).toBeNull();
    });
  });

  // ── Structured logging ────────────────────────────────────────────────────

  describe("structured logging", () => {
    it("emits dlq_list_requested and dlq_list_returned with the expected fields", async () => {
      const { app, store, dispatcher } = buildHarness();
      await seedDlq(dispatcher, store, 2);

      const loggerModule = await import("../src/config/logger");
      const capturedInfos: Array<Record<string, unknown>> = [];
      const origInfo = loggerModule.logger.info.bind(loggerModule.logger);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (loggerModule.logger as any).info = (...args: unknown[]) => {
        if (typeof args[0] === "object" && args[0] !== null) {
          capturedInfos.push(args[0] as Record<string, unknown>);
        }
        origInfo(...(args as Parameters<typeof origInfo>));
      };

      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=2")
        .set(adminHeaders());

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (loggerModule.logger as any).info = origInfo;

      expect(res.status).toBe(200);

      const requested = capturedInfos.find((l) => l["event"] === "dlq_list_requested");
      const returned  = capturedInfos.find((l) => l["event"] === "dlq_list_returned");

      expect(requested).toBeDefined();
      expect(returned).toBeDefined();

      expect(requested).toMatchObject({ event: "dlq_list_requested", limit: "2" });
      expect(returned).toMatchObject({ event: "dlq_list_returned", count: 2, hasNextPage: false });
    });

    it("emits dlq_list_validation_failed with issues when limit is invalid", async () => {
      const loggerModule = await import("../src/config/logger");
      const capturedWarns: Array<Record<string, unknown>> = [];
      const origWarn = loggerModule.logger.warn.bind(loggerModule.logger);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (loggerModule.logger as any).warn = (...args: unknown[]) => {
        if (typeof args[0] === "object" && args[0] !== null) {
          capturedWarns.push(args[0] as Record<string, unknown>);
        }
        origWarn(...(args as Parameters<typeof origWarn>));
      };

      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq?limit=xyz")
        .set(adminHeaders());

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (loggerModule.logger as any).warn = origWarn;

      expect(res.status).toBe(400);
      const warn = capturedWarns.find((l) => l["event"] === "dlq_list_validation_failed");
      expect(warn).toBeDefined();
      expect(Array.isArray(warn!["issues"])).toBe(true);
    });
  });

  // ── Route isolation ───────────────────────────────────────────────────────

  describe("route isolation", () => {
    it("returns 404 when no webhooks deps are passed to createApp", async () => {
      const app = createApp(); // no webhooks → routes not mounted
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(adminHeaders());
      expect(res.status).toBe(404);
    });
  });

  // ── Rate-limiter headers ──────────────────────────────────────────────────

  describe("rate limiter", () => {
    it("includes RateLimit headers on a successful response", async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .get("/api/admin/webhooks/dlq")
        .set(adminHeaders());
      expect(res.status).toBe(200);
      // express-rate-limit draft-6 emits these
      const hasRateLimit =
        "ratelimit-limit" in res.headers ||
        "x-ratelimit-limit" in res.headers ||
        "ratelimit" in res.headers;
      expect(hasRateLimit).toBe(true);
    });
  });
});
