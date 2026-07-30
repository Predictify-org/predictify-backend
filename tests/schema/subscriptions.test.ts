/**
 * tests/schema/subscriptions.test.ts
 *
 * Snapshot-based response-shape stability tests for /api/subscriptions.
 * These complement the behavioral assertions in tests/subscriptions.test.ts
 * by pinning the exact JSON shape returned to clients, so an accidental
 * field rename/addition/removal shows up as a snapshot diff in review
 * rather than silently shipping.
 */

jest.mock("../../src/middleware/requireAdmin", () => ({
  requireAdmin: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
}));

jest.mock("../../src/config/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../src/services/auditService", () => ({
  createAuditLog: jest.fn().mockResolvedValue("corr-id"),
  sanitizeState: jest.fn((state: unknown) => state),
}));

const mockSelectWhere = jest.fn();
const mockFrom = jest.fn(() => ({ where: mockSelectWhere }));
const mockReturning = jest.fn();
const mockValues = jest.fn(() => ({ returning: mockReturning }));
const mockInsert = jest.fn(() => ({ values: mockValues }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

jest.mock("../../src/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}));

import request from "supertest";
import express from "express";
import { subscriptionsRouter } from "../../src/routes/subscriptions";
import { errorHandler } from "../../src/middleware/errorHandler";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

const mockSubscription = {
  id: VALID_UUID,
  url: "https://example.com/webhook",
  secret: "super-secret-hmac-key",
  events: ["market.created", "prediction.settled"],
  active: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api/subscriptions", subscriptionsRouter);
  app.use(errorHandler);
  return app;
}

describe("/api/subscriptions response schema stability", () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
    mockFrom.mockReturnValue({ where: mockSelectWhere });
  });

  it("GET / — matches the stable list shape (secret stripped)", async () => {
    mockFrom.mockResolvedValueOnce([mockSubscription]);

    const res = await request(app).get("/api/subscriptions");

    expect(res.status).toBe(200);
    expect(res.body).toMatchSnapshot();
  });

  it("GET / — matches the stable empty-list shape", async () => {
    mockFrom.mockResolvedValueOnce([]);

    const res = await request(app).get("/api/subscriptions");

    expect(res.status).toBe(200);
    expect(res.body).toMatchSnapshot();
  });

  it("POST / — matches the stable creation shape (secret included once)", async () => {
    mockReturning.mockResolvedValueOnce([mockSubscription]);

    const res = await request(app)
      .post("/api/subscriptions")
      .send({ url: "https://example.com/webhook", events: ["market.created"] });

    expect(res.status).toBe(201);
    // `secret` in the real handler is a freshly generated uuidv4() per request,
    // not the stored row's secret, so it varies run-to-run; pin its shape
    // (a string) rather than its value.
    expect(res.body).toMatchSnapshot({
      data: { secret: expect.any(String) },
    });
  });

  it("POST / — matches the stable validation-error shape", async () => {
    const res = await request(app)
      .post("/api/subscriptions")
      .send({ events: ["market.created"] });

    expect(res.status).toBe(400);
    // correlationId is a fresh randomUUID() per request outside of
    // requestContextStorage, so it varies run-to-run; pin its shape only.
    expect(res.body).toMatchSnapshot({
      error: { correlationId: expect.any(String) },
    });
  });

  it("GET /:id — matches the stable single-resource shape", async () => {
    mockSelectWhere.mockResolvedValueOnce([mockSubscription]);

    const res = await request(app).get(`/api/subscriptions/${VALID_UUID}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchSnapshot();
  });

  it("GET /:id — matches the stable not-found error shape", async () => {
    mockSelectWhere.mockResolvedValueOnce([]);

    const res = await request(app).get(`/api/subscriptions/${VALID_UUID}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchSnapshot({
      error: { correlationId: expect.any(String) },
    });
  });
});
