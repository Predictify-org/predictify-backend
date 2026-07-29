jest.mock("../src/middleware/cors", () => ({
  notificationsCors: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../src/middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: "user-123", stellarAddress: "GTEST" };
    req.id = "req-test-123";
    next();
  },
}));

jest.mock("../src/middleware/idempotency", () => ({
  idempotency: jest.fn((req: any, _res: any, next: any) => next()),
}));

jest.mock("../src/services/notificationPrefs", () => ({
  getNotificationPreferences: jest.fn(),
  patchNotificationPreferences: jest.fn(),
  notificationCategories: ["market_resolved", "claim_ready", "dispute_opened"],
  notificationChannels: ["email", "webhook"],
}));

import express from "express";
import request from "supertest";
import { notificationsRouter } from "../src/routes/notifications";
import { errorHandler } from "../src/middleware/errorHandler";
import {
  getNotificationPreferences,
  patchNotificationPreferences,
} from "../src/services/notificationPrefs";
import { idempotency } from "../src/middleware/idempotency";

const mockGetNotificationPreferences =
  getNotificationPreferences as jest.MockedFunction<typeof getNotificationPreferences>;
const mockPatchNotificationPreferences =
  patchNotificationPreferences as jest.MockedFunction<typeof patchNotificationPreferences>;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
  app.use(errorHandler);
  return app;
}

describe("notifications preferences routes", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("GET /api/notifications/preferences returns the authenticated user's preferences", async () => {
    mockGetNotificationPreferences.mockResolvedValueOnce([
      { category: "market_resolved", channel: "email", enabled: false },
      { category: "market_resolved", channel: "webhook", enabled: true },
    ] as any);

    const res = await request(app).get("/api/notifications/preferences");

    expect(res.status).toBe(200);
    expect(mockGetNotificationPreferences).toHaveBeenCalledWith("user-123");
    expect(res.body).toEqual({
      data: {
        preferences: [
          { category: "market_resolved", channel: "email", enabled: false },
          { category: "market_resolved", channel: "webhook", enabled: true },
        ],
      },
    });
  });

  it("PATCH /api/notifications/preferences validates the request body with zod", async () => {
    const res = await request(app)
      .patch("/api/notifications/preferences")
      .send({ preferences: [{ category: "nope", channel: "email", enabled: true }] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_error");
    expect(mockPatchNotificationPreferences).not.toHaveBeenCalled();
  });

  it("PATCH /api/notifications/preferences upserts preferences and returns the full matrix", async () => {
    mockPatchNotificationPreferences.mockResolvedValueOnce([
      { category: "market_resolved", channel: "email", enabled: false },
      { category: "market_resolved", channel: "webhook", enabled: true },
      { category: "claim_ready", channel: "email", enabled: true },
      { category: "claim_ready", channel: "webhook", enabled: false },
      { category: "dispute_opened", channel: "email", enabled: true },
      { category: "dispute_opened", channel: "webhook", enabled: true },
    ] as any);

    const payload = {
      preferences: [
        { category: "market_resolved", channel: "email", enabled: false },
        { category: "claim_ready", channel: "webhook", enabled: false },
      ],
    };

    const res = await request(app)
      .patch("/api/notifications/preferences")
      .send(payload);

    expect(res.status).toBe(200);
    expect(mockPatchNotificationPreferences).toHaveBeenCalledWith(
      "user-123",
      payload.preferences,
    );
    expect(res.body.data.preferences).toHaveLength(6);
    expect(idempotency).toHaveBeenCalled();
  });
});
