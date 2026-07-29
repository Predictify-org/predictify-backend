/**
 * src/__tests__/routes/subscriptions.test.ts
 *
 * Integration tests for the subscriptions router.
 *
 * Coverage targets
 * ────────────────
 *   GET    /api/subscriptions          — list, ETag, 304, DB error
 *   POST   /api/subscriptions          — create (valid), validation errors (url, events), DB error
 *   GET    /api/subscriptions/:id      — fetch existing, 404, invalid UUID
 *   PATCH  /api/subscriptions/:id      — update (valid), validation errors, 404, empty body
 *   DELETE /api/subscriptions/:id      — delete existing, 404, invalid UUID
 *   Validator schemas                  — unit-level checks for createSubscriptionBodySchema,
 *                                        patchSubscriptionBodySchema, subscriptionIdParamSchema
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { subscriptionsRouter } from "../../routes/subscriptions";
import { db } from "../../db/client";
import { generateETag } from "../../middleware/etag";
import {
  createSubscriptionBodySchema,
  patchSubscriptionBodySchema,
  subscriptionIdParamSchema,
  eventTypeSchema,
  webhookUrlSchema,
} from "../../validators/subscriptions";

jest.mock("../../services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue("corr-id"),
}));

// Build a fluent db mock that supports: select/insert/update/delete chains
const mockReturning = jest.fn();
const mockWhere = jest.fn();
const mockFrom = jest.fn();
const mockSet = jest.fn(() => ({ where: mockWhere }));
const mockValues = jest.fn(() => ({ returning: mockReturning }));
const mockInsert = jest.fn(() => ({ values: mockValues }));
const mockUpdate = jest.fn(() => ({ set: mockSet }));
const mockDelete = jest.fn(() => ({ where: mockWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

jest.mock("../../db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const ANOTHER_UUID = "987fcdeb-51d3-12d3-a456-426614174999";

const mockSubscription = {
  id: VALID_UUID,
  url: "https://example.com/webhook",
  secret: "super-secret-hmac-key",
  events: ["market.created", "prediction.settled"],
  active: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

// Public-facing serialisation omits the secret field
const publicSubscription = (() => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret: _s, ...pub } = mockSubscription;
  return pub;
})();

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api/subscriptions", subscriptionsRouter);
  // Attach the real errorHandler so ZodErrors produce 400 responses
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { errorHandler } = require("../../middleware/errorHandler") as {
    errorHandler: (
      err: unknown,
      req: Request,
      res: Response,
      next: NextFunction,
    ) => void;
  };
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

jest.mock("../../services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue("corr-id"),
}));

describe("Subscriptions Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();

    // Reset mock chain defaults
    mockFrom.mockResolvedValue([]);
    mockWhere.mockResolvedValue([]);
    mockReturning.mockResolvedValue([]);
  });

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/subscriptions
  // ────────────────────────────────────────────────────────────────────────
  describe("GET /api/subscriptions", () => {
    it("returns 200 with data and a strong ETag", async () => {
      const subscriptions = [mockSubscription];
      mockFrom.mockResolvedValueOnce(subscriptions);

      const res = await request(app).get("/api/subscriptions");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(JSON.parse(JSON.stringify(subscriptions)));
      const expectedEtag = generateETag(subscriptions);
      expect(res.headers.etag).toBe(expectedEtag);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("returns 304 when If-None-Match matches the ETag", async () => {
      mockFrom.mockResolvedValue([mockSubscription]);
      const expectedEtag = generateETag([mockSubscription]);

      const res = await request(app)
        .get("/api/subscriptions")
        .set("If-None-Match", expectedEtag);

      expect(res.status).toBe(304);
      expect(res.body).toEqual({});
    });

    it("returns 200 when If-None-Match does not match", async () => {
      mockFrom.mockResolvedValueOnce([mockSubscription]);

      const res = await request(app)
        .get("/api/subscriptions")
        .set("If-None-Match", '"stale-etag-value"');

      expect(res.status).toBe(200);
    });

    it("returns 200 with empty array when no subscriptions exist", async () => {
      mockFrom.mockResolvedValueOnce([]);

      const res = await request(app).get("/api/subscriptions");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("propagates DB errors to error handler", async () => {
      mockFrom.mockRejectedValueOnce(new Error("DB connection lost"));

      const res = await request(app).get("/api/subscriptions");

      expect(res.status).toBe(500);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/subscriptions
  // ────────────────────────────────────────────────────────────────────────
  describe("POST /api/subscriptions", () => {
    const validBody = {
      url: "https://example.com/webhook",
      events: ["market.created", "prediction.settled"],
    };

    it("creates a subscription and returns 201 with secret", async () => {
      mockReturning.mockResolvedValueOnce([mockSubscription]);

      const res = await request(app)
        .post("/api/subscriptions")
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe(VALID_UUID);
      // Secret must be present exactly once at creation time
      expect(typeof res.body.data.secret).toBe("string");
      expect(res.body.data.secret.length).toBeGreaterThan(0);
      expect(res.body.data.url).toBe(validBody.url);
      expect(res.body.data.events).toEqual(
        expect.arrayContaining(validBody.events),
      );
    });

    it("deduplicates events in the request", async () => {
      const capturedValues: unknown[] = [];
      mockValues.mockImplementationOnce((vals: unknown) => {
        capturedValues.push(vals);
        return { returning: mockReturning };
      });
      mockReturning.mockResolvedValueOnce([mockSubscription]);

      await request(app)
        .post("/api/subscriptions")
        .send({ url: validBody.url, events: ["market.created", "market.created"] });

      // The values written to DB should have deduplicated events
      const written = capturedValues[0] as {
        events: string[];
      };
      expect(written.events).toHaveLength(1);
      expect(written.events[0]).toBe("market.created");
    });

    it("returns 400 when url is missing", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ events: ["market.created"] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 when url is not a valid URL", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: "not-a-url", events: ["market.created"] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 when url uses HTTP (non-localhost)", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: "http://example.com/hook", events: ["market.created"] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("accepts http://localhost URLs", async () => {
      mockReturning.mockResolvedValueOnce([{ ...mockSubscription, url: "http://localhost:3000/hook" }]);

      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: "http://localhost:3000/hook", events: ["market.created"] });

      expect(res.status).toBe(201);
    });

    it("returns 400 when events is missing", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: "https://example.com/hook" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 when events is an empty array", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: "https://example.com/hook", events: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 when events contains an invalid event type", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: "https://example.com/hook", events: ["not-valid-format"] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for unknown body fields (strict mode)", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ ...validBody, unknownField: "should-fail" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("propagates DB errors to error handler", async () => {
      mockValues.mockImplementationOnce(() => ({
        returning: jest.fn().mockRejectedValueOnce(new Error("insert failed")),
      }));

      const res = await request(app)
        .post("/api/subscriptions")
        .send(validBody);

      expect(res.status).toBe(500);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/subscriptions/:id
  // ────────────────────────────────────────────────────────────────────────
  describe("GET /api/subscriptions/:id", () => {
    it("returns 200 with subscription data (secret stripped)", async () => {
      mockWhere.mockResolvedValueOnce([mockSubscription]);

      const res = await request(app).get(`/api/subscriptions/${VALID_UUID}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(VALID_UUID);
      expect(res.body.data.secret).toBeUndefined();
    });

    it("returns 404 when subscription does not exist", async () => {
      mockWhere.mockResolvedValueOnce([]);

      const res = await request(app).get(`/api/subscriptions/${VALID_UUID}`);

      expect(res.status).toBe(404);
    });

    it("returns 400 for a non-UUID id", async () => {
      const res = await request(app).get("/api/subscriptions/not-a-uuid");

      expect(res.status).toBe(400);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // PATCH /api/subscriptions/:id
  // ────────────────────────────────────────────────────────────────────────
  describe("PATCH /api/subscriptions/:id", () => {
    const updatedSub = {
      ...mockSubscription,
      url: "https://new.example.com/hook",
      updatedAt: new Date(),
    };

    it("updates url and returns 200", async () => {
      // Existence check
      mockWhere
        .mockResolvedValueOnce([mockSubscription])
        // Update returning
        .mockResolvedValueOnce([updatedSub]);

      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ url: "https://new.example.com/hook" });

      expect(res.status).toBe(200);
      expect(res.body.data.url).toBe("https://new.example.com/hook");
      expect(res.body.data.secret).toBeUndefined();
    });

    it("updates active flag and returns 200", async () => {
      mockWhere
        .mockResolvedValueOnce([mockSubscription])
        .mockResolvedValueOnce([{ ...mockSubscription, active: false }]);

      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ active: false });

      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(false);
    });

    it("updates events array and returns 200", async () => {
      const newEvents = ["market.resolved"];
      mockWhere
        .mockResolvedValueOnce([mockSubscription])
        .mockResolvedValueOnce([{ ...mockSubscription, events: newEvents }]);

      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ events: newEvents });

      expect(res.status).toBe(200);
      expect(res.body.data.events).toEqual(newEvents);
    });

    it("returns 404 when subscription does not exist", async () => {
      mockWhere.mockResolvedValueOnce([]);

      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ active: false });

      expect(res.status).toBe(404);
    });

    it("returns 400 when body is empty (no fields provided)", async () => {
      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for invalid url in patch body", async () => {
      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ url: "ftp://bad-protocol.com" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for unknown fields (strict mode)", async () => {
      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ active: true, surprise: "field" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for non-UUID id", async () => {
      const res = await request(app)
        .patch("/api/subscriptions/bad-id")
        .send({ active: true });

      expect(res.status).toBe(400);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // DELETE /api/subscriptions/:id
  // ────────────────────────────────────────────────────────────────────────
  describe("DELETE /api/subscriptions/:id", () => {
    it("returns 204 when subscription is deleted", async () => {
      mockWhere.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app).delete(
        `/api/subscriptions/${VALID_UUID}`,
      );

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
    });

    it("returns 404 when subscription does not exist", async () => {
      mockWhere.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app).delete(
        `/api/subscriptions/${ANOTHER_UUID}`,
      );

      expect(res.status).toBe(404);
    });

    it("returns 400 for non-UUID id", async () => {
      const res = await request(app).delete("/api/subscriptions/not-a-uuid");

      expect(res.status).toBe(400);
    });
  });

  describe("Mutations", () => {
    it("POST /api/subscriptions creates and audits", async () => {
      const newRow = { id: "sub-2", url: "https://x", events: [], active: true };
      (db.insert as jest.Mock).mockReturnThis();
      (db.values as jest.Mock).mockReturnThis();
      (db.returning as jest.Mock).mockResolvedValueOnce([newRow]);

      const response = await request(app).post("/api/subscriptions").send({ url: newRow.url, events: newRow.events });

      expect(response.status).toBe(201);
      expect(response.body.data).toEqual(JSON.parse(JSON.stringify(newRow)));
      const { createAuditLog } = require("../../services/auditService");
      expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.subscription.create", afterState: newRow }));
    });

    it("PATCH /api/subscriptions/:id updates and audits", async () => {
      const existing = { id: "sub-3", url: "https://old", events: [], active: true };
      const updated = { ...existing, url: "https://new" };

      (db.from as jest.Mock).mockResolvedValueOnce([existing]);
      (db.update as jest.Mock).mockReturnThis();
      (db.set as jest.Mock).mockReturnThis();
      (db.returning as jest.Mock).mockResolvedValueOnce([updated]);

      const response = await request(app).patch(`/api/subscriptions/${existing.id}`).send({ url: updated.url });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual(JSON.parse(JSON.stringify(updated)));
      const { createAuditLog } = require("../../services/auditService");
      expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.subscription.update", beforeState: existing, afterState: updated }));
    });

    it("DELETE /api/subscriptions/:id deletes and audits", async () => {
      const existing = { id: "sub-4", url: "https://del", events: [], active: true };

      (db.from as jest.Mock).mockResolvedValueOnce([existing]);
      (db.delete as jest.Mock).mockResolvedValueOnce({ rowCount: 1 });

      const response = await request(app).delete(`/api/subscriptions/${existing.id}`);

      expect(response.status).toBe(204);
      const { createAuditLog } = require("../../services/auditService");
      expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.subscription.delete", beforeState: existing, afterState: null }));
    });
  });
});

// ============================================================================
// Validator unit tests
// ============================================================================

describe("createSubscriptionBodySchema", () => {
  const VALID = {
    url: "https://example.com/hook",
    events: ["market.created"],
  };

  it("accepts a valid body", () => {
    const r = createSubscriptionBodySchema.safeParse(VALID);
    expect(r.success).toBe(true);
  });

  it("deduplicates duplicate event types", () => {
    const r = createSubscriptionBodySchema.safeParse({
      ...VALID,
      events: ["market.created", "market.created", "prediction.settled"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.events).toHaveLength(2);
    }
  });

  it("rejects missing url", () => {
    const r = createSubscriptionBodySchema.safeParse({ events: ["market.created"] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("url"))).toBe(true);
    }
  });

  it("rejects missing events", () => {
    const r = createSubscriptionBodySchema.safeParse({ url: VALID.url });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("events"))).toBe(true);
    }
  });

  it("rejects empty events array", () => {
    const r = createSubscriptionBodySchema.safeParse({ ...VALID, events: [] });
    expect(r.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = createSubscriptionBodySchema.safeParse({ ...VALID, extra: "x" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects non-https url (non-localhost)", () => {
    const r = createSubscriptionBodySchema.safeParse({
      url: "http://example.com/hook",
      events: VALID.events,
    });
    expect(r.success).toBe(false);
  });

  it("accepts http://localhost", () => {
    const r = createSubscriptionBodySchema.safeParse({
      url: "http://localhost:9000/hook",
      events: VALID.events,
    });
    expect(r.success).toBe(true);
  });

  it("accepts up to 50 distinct event types", () => {
    const events = Array.from({ length: 50 }, (_, i) => `market.event${i}`);
    const r = createSubscriptionBodySchema.safeParse({ ...VALID, events });
    expect(r.success).toBe(true);
  });

  it("rejects more than 50 distinct event types", () => {
    const events = Array.from({ length: 51 }, (_, i) => `market.event${i}`);
    const r = createSubscriptionBodySchema.safeParse({ ...VALID, events });
    expect(r.success).toBe(false);
  });
});

describe("patchSubscriptionBodySchema", () => {
  it("accepts updating only url", () => {
    const r = patchSubscriptionBodySchema.safeParse({
      url: "https://new.example.com/hook",
    });
    expect(r.success).toBe(true);
  });

  it("accepts updating only active", () => {
    const r = patchSubscriptionBodySchema.safeParse({ active: false });
    expect(r.success).toBe(true);
  });

  it("accepts updating only events", () => {
    const r = patchSubscriptionBodySchema.safeParse({
      events: ["prediction.settled"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts updating all fields at once", () => {
    const r = patchSubscriptionBodySchema.safeParse({
      url: "https://example.com/hook",
      events: ["market.created"],
      active: true,
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty object (at least one field required)", () => {
    const r = patchSubscriptionBodySchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = patchSubscriptionBodySchema.safeParse({
      active: true,
      surprise: "field",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("rejects invalid url in patch", () => {
    const r = patchSubscriptionBodySchema.safeParse({ url: "not-a-url" });
    expect(r.success).toBe(false);
  });

  it("rejects non-boolean active value", () => {
    const r = patchSubscriptionBodySchema.safeParse({ active: "yes" });
    expect(r.success).toBe(false);
  });
});

describe("subscriptionIdParamSchema", () => {
  it("accepts a valid UUID", () => {
    const r = subscriptionIdParamSchema.safeParse({
      id: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    const r = subscriptionIdParamSchema.safeParse({ id: "not-a-uuid" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(["id"]);
    }
  });

  it("rejects missing id", () => {
    const r = subscriptionIdParamSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe("eventTypeSchema", () => {
  it.each([
    "market.created",
    "prediction.settled",
    "market_order.placed",
    "webhook-delivery.failed",
  ])("accepts valid event type: %s", (event) => {
    expect(eventTypeSchema.safeParse(event).success).toBe(true);
  });

  it.each([
    "no-dot",
    ".leading-dot",
    "trailing-dot.",
    "two..dots",
    "has space.here",
    "",
  ])("rejects invalid event type: %s", (event) => {
    expect(eventTypeSchema.safeParse(event).success).toBe(false);
  });
});

describe("webhookUrlSchema", () => {
  it("accepts https URLs", () => {
    expect(
      webhookUrlSchema.safeParse("https://example.com/webhook").success,
    ).toBe(true);
  });

  it("accepts http://localhost", () => {
    expect(
      webhookUrlSchema.safeParse("http://localhost:3000/hook").success,
    ).toBe(true);
  });

  it("rejects http non-localhost", () => {
    expect(
      webhookUrlSchema.safeParse("http://example.com/hook").success,
    ).toBe(false);
  });

  it("rejects ftp protocol", () => {
    expect(webhookUrlSchema.safeParse("ftp://example.com/hook").success).toBe(
      false,
    );
  });

  it("rejects plain strings", () => {
    expect(webhookUrlSchema.safeParse("not-a-url").success).toBe(false);
  });

  it("trims whitespace before validation", () => {
    expect(
      webhookUrlSchema.safeParse("  https://example.com/hook  ").success,
    ).toBe(true);
  });
});
