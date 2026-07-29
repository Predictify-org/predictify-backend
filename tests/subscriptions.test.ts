/**
 * tests/subscriptions.test.ts
 *
 * Integration + unit tests for the subscriptions router (issue #641).
 *
 * Coverage:
 *   GET    /api/subscriptions          — list, ETag/304, DB error
 *   POST   /api/subscriptions          — create (valid), validation errors, DB error
 *   GET    /api/subscriptions/:id      — fetch, 404, invalid UUID
 *   PATCH  /api/subscriptions/:id      — update (valid), validation errors, 404, empty body
 *   DELETE /api/subscriptions/:id      — delete, 404, invalid UUID
 *
 *   Validator unit tests:
 *     createSubscriptionBodySchema, patchSubscriptionBodySchema,
 *     subscriptionIdParamSchema, eventTypeSchema, webhookUrlSchema
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("../src/middleware/requireAdmin", () => ({
  requireAdmin: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
}));

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Build a fluent db mock that supports: select/insert/update/delete chains
const mockUpdateReturning = jest.fn();
const mockSelectWhere = jest.fn();
const mockUpdateWhere = jest.fn(() => ({ returning: mockUpdateReturning }));
const mockDeleteWhere = jest.fn();
const mockFrom = jest.fn();
const mockSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockReturning = jest.fn();
const mockValues = jest.fn(() => ({ returning: mockReturning }));
const mockInsert = jest.fn(() => ({ values: mockValues }));
const mockUpdate = jest.fn(() => ({ set: mockSet }));
const mockDelete = jest.fn(() => ({ where: mockDeleteWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

jest.mock("../src/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

// Mock auditService - but we need to make sure this doesn't interfere with the tests
jest.mock("../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue("corr-id"),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import request from "supertest";
import express from "express";
import { subscriptionsRouter } from "../src/routes/subscriptions";
import { errorHandler } from "../src/middleware/errorHandler";
import { generateETag } from "../src/middleware/etag";
import {
  createSubscriptionBodySchema,
  patchSubscriptionBodySchema,
  subscriptionIdParamSchema,
  eventTypeSchema,
  webhookUrlSchema,
} from "../src/validators/subscriptions";

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

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api/subscriptions", subscriptionsRouter);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Route integration tests
// ---------------------------------------------------------------------------

describe("Subscriptions Routes (issue #641)", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();

    // Wire the fluent chain so .from() returns the object that has .where()
    mockFrom.mockReturnValue({ where: mockSelectWhere });
    // Wire update().set().where() to return { returning: mockUpdateReturning }
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });

    // Defaults: empty/no-op results
    mockSelectWhere.mockResolvedValue([]);
    mockUpdateReturning.mockResolvedValue([]);
    mockDeleteWhere.mockResolvedValue({ rowCount: 0 });
    mockReturning.mockResolvedValue([]);
  });

  // ── GET / ─────────────────────────────────────────────────────────────────
  describe("GET /api/subscriptions", () => {
    it("returns 200 with data and a strong ETag", async () => {
      // GET / uses select().from() directly (no .where())
      mockFrom.mockResolvedValueOnce([mockSubscription]);

      const res = await request(app).get("/api/subscriptions");

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(generateETag([mockSubscription])).toBe(res.headers.etag);
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("returns 304 when If-None-Match matches ETag", async () => {
      mockFrom.mockResolvedValue([mockSubscription]);
      const etag = generateETag([mockSubscription]);

      const res = await request(app)
        .get("/api/subscriptions")
        .set("If-None-Match", etag);

      expect(res.status).toBe(304);
    });

    it("returns 200 when If-None-Match is stale", async () => {
      mockFrom.mockResolvedValueOnce([mockSubscription]);

      const res = await request(app)
        .get("/api/subscriptions")
        .set("If-None-Match", '"stale-etag"');

      expect(res.status).toBe(200);
    });

    it("returns empty array when no subscriptions exist", async () => {
      mockFrom.mockResolvedValueOnce([]);

      const res = await request(app).get("/api/subscriptions");

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("propagates DB errors (500)", async () => {
      mockFrom.mockRejectedValueOnce(new Error("DB unavailable"));

      const res = await request(app).get("/api/subscriptions");

      expect(res.status).toBe(500);
    });
  });

  // ── POST / ────────────────────────────────────────────────────────────────
  describe("POST /api/subscriptions", () => {
    const VALID_BODY = {
      url: "https://example.com/webhook",
      events: ["market.created"],
    };

    it("creates a subscription and returns 201 with the secret", async () => {
      mockReturning.mockResolvedValueOnce([mockSubscription]);

      const res = await request(app)
        .post("/api/subscriptions")
        .send(VALID_BODY);

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe(VALID_UUID);
      expect(typeof res.body.data.secret).toBe("string");
      expect(res.body.data.url).toBe("https://example.com/webhook");
    });

    it("does not expose secret in GET list response", async () => {
      mockFrom.mockResolvedValueOnce([mockSubscription]);

      const res = await request(app).get("/api/subscriptions");

      expect(res.body.data[0]?.secret).toBeUndefined();
    });

    it("deduplicates events before inserting", async () => {
      const capturedArgs: unknown[] = [];
      mockValues.mockImplementationOnce((vals: unknown) => {
        capturedArgs.push(vals);
        return { returning: mockReturning };
      });
      mockReturning.mockResolvedValueOnce([mockSubscription]);

      await request(app).post("/api/subscriptions").send({
        url: VALID_BODY.url,
        events: ["market.created", "market.created", "prediction.settled"],
      });

      const inserted = capturedArgs[0] as { events: string[] };
      expect(inserted.events).toHaveLength(2);
    });

    it("returns 400 when url is missing", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ events: ["market.created"] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for an invalid URL", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: "not-a-url", events: ["market.created"] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 when HTTP url is used for non-localhost", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: "http://example.com/hook", events: ["market.created"] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("accepts http://localhost URLs", async () => {
      mockReturning.mockResolvedValueOnce([
        { ...mockSubscription, url: "http://localhost:4000/hook" },
      ]);

      const res = await request(app).post("/api/subscriptions").send({
        url: "http://localhost:4000/hook",
        events: ["market.created"],
      });

      expect(res.status).toBe(201);
    });

    it("returns 400 when events is missing", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: VALID_BODY.url });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for empty events array", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: VALID_BODY.url, events: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for events with invalid format", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ url: VALID_BODY.url, events: ["no-dot-here"] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for unknown body fields (strict)", async () => {
      const res = await request(app)
        .post("/api/subscriptions")
        .send({ ...VALID_BODY, extraField: "bad" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("propagates DB errors (500)", async () => {
      mockValues.mockImplementationOnce(() => ({
        returning: jest.fn().mockRejectedValueOnce(new Error("insert failed")),
      }));

      const res = await request(app)
        .post("/api/subscriptions")
        .send(VALID_BODY);

      expect(res.status).toBe(500);
    });
  });

  // ── GET /:id ──────────────────────────────────────────────────────────────
  describe("GET /api/subscriptions/:id", () => {
    it("returns 200 with subscription data (secret stripped)", async () => {
      // GET /:id uses select().from().where()
      mockSelectWhere.mockResolvedValueOnce([mockSubscription]);

      const res = await request(app).get(`/api/subscriptions/${VALID_UUID}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(VALID_UUID);
      expect(res.body.data.secret).toBeUndefined();
    });

    it("returns 404 when subscription does not exist", async () => {
      mockSelectWhere.mockResolvedValueOnce([]);

      const res = await request(app).get(`/api/subscriptions/${ANOTHER_UUID}`);

      expect(res.status).toBe(404);
    });

    it("returns 400 for a non-UUID :id", async () => {
      const res = await request(app).get("/api/subscriptions/not-a-uuid");

      expect(res.status).toBe(400);
    });
  });

  // ── PATCH /:id ────────────────────────────────────────────────────────────
  describe("PATCH /api/subscriptions/:id", () => {
    it("updates url and returns 200 (secret stripped)", async () => {
      const updated = { ...mockSubscription, url: "https://new.example.com/hook" };
      // Existence check uses select().from().where()
      mockSelectWhere.mockResolvedValueOnce([mockSubscription]);
      // Update uses update().set().where().returning()
      mockUpdateReturning.mockResolvedValueOnce([updated]);

      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ url: "https://new.example.com/hook" });

      expect(res.status).toBe(200);
      expect(res.body.data.url).toBe("https://new.example.com/hook");
      expect(res.body.data.secret).toBeUndefined();
    });

    it("updates active flag", async () => {
      mockSelectWhere.mockResolvedValueOnce([mockSubscription]);
      mockUpdateReturning.mockResolvedValueOnce([{ ...mockSubscription, active: false }]);

      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ active: false });

      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(false);
    });

    it("updates events array", async () => {
      const newEvents = ["market.resolved"];
      mockSelectWhere.mockResolvedValueOnce([mockSubscription]);
      mockUpdateReturning.mockResolvedValueOnce([{ ...mockSubscription, events: newEvents }]);

      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ events: newEvents });

      expect(res.status).toBe(200);
      expect(res.body.data.events).toEqual(newEvents);
    });

    it("returns 404 when subscription does not exist", async () => {
      mockSelectWhere.mockResolvedValueOnce([]);

      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ active: false });

      expect(res.status).toBe(404);
    });

    it("returns 400 for empty body (at least one field required)", async () => {
      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for invalid url in patch body", async () => {
      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ url: "ftp://bad-scheme.com" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for unknown body fields (strict)", async () => {
      const res = await request(app)
        .patch(`/api/subscriptions/${VALID_UUID}`)
        .send({ active: true, unknownField: "x" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for non-UUID :id", async () => {
      const res = await request(app)
        .patch("/api/subscriptions/bad-id")
        .send({ active: true });

      expect(res.status).toBe(400);
    });
  });

  // ── DELETE /:id ───────────────────────────────────────────────────────────
  describe("DELETE /api/subscriptions/:id", () => {
    it("returns 204 on successful deletion", async () => {
      mockDeleteWhere.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request(app).delete(`/api/subscriptions/${VALID_UUID}`);

      expect(res.status).toBe(204);
    });

    it("returns 404 when subscription does not exist", async () => {
      mockDeleteWhere.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request(app).delete(`/api/subscriptions/${ANOTHER_UUID}`);

      expect(res.status).toBe(404);
    });

    it("returns 400 for non-UUID :id", async () => {
      const res = await request(app).delete("/api/subscriptions/not-a-uuid");

      expect(res.status).toBe(400);
    });
  });
});

// ============================================================================
// Validator unit tests
// ============================================================================

describe("createSubscriptionBodySchema", () => {
  const VALID = { url: "https://example.com/hook", events: ["market.created"] };

  it("accepts a valid body", () => {
    expect(createSubscriptionBodySchema.safeParse(VALID).success).toBe(true);
  });

  it("deduplicates duplicate event types", () => {
    const r = createSubscriptionBodySchema.safeParse({
      ...VALID,
      events: ["market.created", "market.created", "prediction.settled"],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.events).toHaveLength(2);
  });

  it("rejects missing url", () => {
    const r = createSubscriptionBodySchema.safeParse({ events: VALID.events });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some((i) => i.path.includes("url"))).toBe(true);
  });

  it("rejects missing events", () => {
    const r = createSubscriptionBodySchema.safeParse({ url: VALID.url });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some((i) => i.path.includes("events"))).toBe(true);
  });

  it("rejects empty events array", () => {
    expect(
      createSubscriptionBodySchema.safeParse({ ...VALID, events: [] }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = createSubscriptionBodySchema.safeParse({ ...VALID, extra: "x" });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(
        r.error.issues.some((i) => i.code === "unrecognized_keys"),
      ).toBe(true);
  });

  it("rejects http url for non-localhost", () => {
    expect(
      createSubscriptionBodySchema.safeParse({
        url: "http://example.com/hook",
        events: VALID.events,
      }).success,
    ).toBe(false);
  });

  it("accepts http://localhost", () => {
    expect(
      createSubscriptionBodySchema.safeParse({
        url: "http://localhost:9000/hook",
        events: VALID.events,
      }).success,
    ).toBe(true);
  });

  it("rejects more than 50 distinct event types", () => {
    const events = Array.from({ length: 51 }, (_, i) => `market.event${i}`);
    expect(
      createSubscriptionBodySchema.safeParse({ ...VALID, events }).success,
    ).toBe(false);
  });

  it("accepts exactly 50 distinct event types", () => {
    const events = Array.from({ length: 50 }, (_, i) => `market.event${i}`);
    expect(
      createSubscriptionBodySchema.safeParse({ ...VALID, events }).success,
    ).toBe(true);
  });
});

describe("patchSubscriptionBodySchema", () => {
  it("accepts updating only url", () => {
    expect(
      patchSubscriptionBodySchema.safeParse({ url: "https://new.example.com/hook" }).success,
    ).toBe(true);
  });

  it("accepts updating only active", () => {
    expect(patchSubscriptionBodySchema.safeParse({ active: false }).success).toBe(true);
  });

  it("accepts updating only events", () => {
    expect(
      patchSubscriptionBodySchema.safeParse({ events: ["prediction.settled"] }).success,
    ).toBe(true);
  });

  it("accepts updating all fields simultaneously", () => {
    expect(
      patchSubscriptionBodySchema.safeParse({
        url: "https://example.com/hook",
        events: ["market.created"],
        active: true,
      }).success,
    ).toBe(true);
  });

  it("rejects empty object (at least one field required)", () => {
    expect(patchSubscriptionBodySchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const r = patchSubscriptionBodySchema.safeParse({ active: true, surprise: "field" });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("rejects invalid url", () => {
    expect(patchSubscriptionBodySchema.safeParse({ url: "not-a-url" }).success).toBe(false);
  });

  it("rejects non-boolean active", () => {
    expect(patchSubscriptionBodySchema.safeParse({ active: "yes" }).success).toBe(false);
  });
});

describe("subscriptionIdParamSchema", () => {
  it("accepts a valid UUID", () => {
    expect(subscriptionIdParamSchema.safeParse({ id: VALID_UUID }).success).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    const r = subscriptionIdParamSchema.safeParse({ id: "not-a-uuid" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["id"]);
  });

  it("rejects missing id", () => {
    expect(subscriptionIdParamSchema.safeParse({}).success).toBe(false);
  });
});

describe("eventTypeSchema", () => {
  it.each([
    "market.created",
    "prediction.settled",
    "market_order.placed",
    "webhook-delivery.failed",
  ])("accepts valid event type: %s", (ev) => {
    expect(eventTypeSchema.safeParse(ev).success).toBe(true);
  });

  it.each(["no-dot", ".leading-dot", "trailing-dot.", "two..dots", "", "has space.here"])(
    "rejects invalid event type: %s",
    (ev) => {
      expect(eventTypeSchema.safeParse(ev).success).toBe(false);
    },
  );
});

describe("webhookUrlSchema", () => {
  it("accepts https URLs", () => {
    expect(webhookUrlSchema.safeParse("https://example.com/webhook").success).toBe(true);
  });

  it("accepts http://localhost", () => {
    expect(webhookUrlSchema.safeParse("http://localhost:3000/hook").success).toBe(true);
  });

  it("rejects http for non-localhost", () => {
    expect(webhookUrlSchema.safeParse("http://example.com/hook").success).toBe(false);
  });

  it("rejects ftp protocol", () => {
    expect(webhookUrlSchema.safeParse("ftp://example.com/hook").success).toBe(false);
  });

  it("rejects plain strings", () => {
    expect(webhookUrlSchema.safeParse("not-a-url").success).toBe(false);
  });

  it("trims surrounding whitespace before validation", () => {
    expect(webhookUrlSchema.safeParse("  https://example.com/hook  ").success).toBe(true);
  });
});
