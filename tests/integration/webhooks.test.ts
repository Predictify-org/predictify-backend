import request from "supertest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/index";
import { db, closeDb } from "../../src/db";
import { users, webhookSubscriptions } from "../../src/db/schema";

const JWT_SECRET = process.env.JWT_SECRET || "test-integration-jwt-secret-at-least-32-chars!!";

function makeToken(stellarAddress: string) {
  return jwt.sign(
    { sub: stellarAddress },
    JWT_SECRET,
    { issuer: "predictify", audience: "predictify-app", expiresIn: "5m" }
  );
}

describe("Webhook Subscriptions Integration Tests", () => {
  let app: ReturnType<typeof createApp>;
  const stellarAddress = "GTESTUSER0000000000000000000000000000000000000000000000001";
  let token: string;

  beforeAll(async () => {
    app = createApp();

    // Ensure we clean up any pre-existing test data
    await db.delete(webhookSubscriptions);
    await db.delete(users).where(eq(users.stellarAddress, stellarAddress));

    // Seed test user
    await db.insert(users).values({
      stellarAddress,
    });

    token = makeToken(stellarAddress);
  });

  afterAll(async () => {
    // Clean up test data
    await db.delete(webhookSubscriptions);
    await db.delete(users).where(eq(users.stellarAddress, stellarAddress));
    await closeDb();
  });

  describe("POST /api/webhooks/subscriptions", () => {
    it("returns 401 if request is unauthenticated", async () => {
      const res = await request(app)
        .post("/api/webhooks/subscriptions")
        .send({
          url: "https://example.com/webhook",
          events: ["*"],
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthenticated");
    });

    it("returns 400 for invalid body schema", async () => {
      const res = await request(app)
        .post("/api/webhooks/subscriptions")
        .set("Authorization", `Bearer ${token}`)
        .send({
          url: "not-a-url",
          events: [],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("VALIDATION_ERROR");
    });

    it("returns 400 if events contains invalid event type", async () => {
      const res = await request(app)
        .post("/api/webhooks/subscriptions")
        .set("Authorization", `Bearer ${token}`)
        .send({
          url: "https://example.com/webhook",
          events: ["invalid.event.type"],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("VALIDATION_ERROR");
    });

    it("returns 400 if url does not use HTTPS", async () => {
      const res = await request(app)
        .post("/api/webhooks/subscriptions")
        .set("Authorization", `Bearer ${token}`)
        .send({
          url: "http://example.com/webhook",
          events: ["market.resolved"],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("BadRequest");
    });

    it("successfully creates a subscription with a wildcard", async () => {
      const res = await request(app)
        .post("/api/webhooks/subscriptions")
        .set("Authorization", `Bearer ${token}`)
        .send({
          url: "https://example.com/webhook-wildcard",
          events: ["*"],
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.url).toBe("https://example.com/webhook-wildcard");
      expect(res.body.data.events).toEqual(["*"]);
      expect(res.body.data.secret).toHaveLength(64); // 64-char hex secret
      expect(res.body.data.active).toBe(true);
    });

    it("successfully creates a subscription with specific events", async () => {
      const res = await request(app)
        .post("/api/webhooks/subscriptions")
        .set("Authorization", `Bearer ${token}`)
        .send({
          url: "https://example.com/webhook-specific",
          events: ["market.resolved", "dispute.opened"],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.events).toEqual(["market.resolved", "dispute.opened"]);
    });
  });

  describe("DELETE /api/webhooks/subscriptions/:id", () => {
    it("returns 401 if request is unauthenticated", async () => {
      const res = await request(app)
        .delete("/api/webhooks/subscriptions/00000000-0000-0000-0000-000000000000");

      expect(res.status).toBe(401);
    });

    it("returns 400 for a malformed subscription ID", async () => {
      const res = await request(app)
        .delete("/api/webhooks/subscriptions/invalid-id")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("BadRequest");
    });

    it("returns 404 for a non-existent subscription ID", async () => {
      const res = await request(app)
        .delete("/api/webhooks/subscriptions/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error.type).toBe("NotFound");
    });

    it("successfully deactivates/deletes an active subscription", async () => {
      // 1. Create a subscription first
      const createRes = await request(app)
        .post("/api/webhooks/subscriptions")
        .set("Authorization", `Bearer ${token}`)
        .send({
          url: "https://example.com/webhook-to-delete",
          events: ["*"],
        });
      const subId = createRes.body.data.id;

      // 2. Delete it
      const deleteRes = await request(app)
        .delete(`/api/webhooks/subscriptions/${subId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(deleteRes.status).toBe(204);

      // 3. Subsequent delete should return 404 since it's deactivated
      const secondDeleteRes = await request(app)
        .delete(`/api/webhooks/subscriptions/${subId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(secondDeleteRes.status).toBe(404);

      // 4. Verify in DB that it is inactive
      const [dbSub] = await db
        .select()
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, subId))
        .limit(1);
      expect(dbSub.active).toBe(false);
    });
  });
});
