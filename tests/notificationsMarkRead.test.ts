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

jest.mock("../src/services/notificationService", () => ({
  markNotificationsAsRead: jest.fn(),
}));

import express from "express";
import request from "supertest";
import { notificationsRouter } from "../src/routes/notifications";
import { errorHandler } from "../src/middleware/errorHandler";
import { markNotificationsAsRead } from "../src/services/notificationService";
import { idempotency } from "../src/middleware/idempotency";

const mockMarkNotificationsAsRead = markNotificationsAsRead as jest.MockedFunction<
  typeof markNotificationsAsRead
>;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
  app.use(errorHandler);
  return app;
}

describe("notifications mark-read endpoint", () => {
  let app: express.Express;

  beforeAll(() => {
    app = makeApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/notifications/mark-read", () => {
    it("marks specific notification IDs as read for the authenticated user", async () => {
      mockMarkNotificationsAsRead.mockResolvedValueOnce({ updatedCount: 2 });

      const res = await request(app)
        .post("/api/notifications/mark-read")
        .send({ notificationIds: ["550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440001"] });

      expect(res.status).toBe(200);
      expect(res.body.data.updatedCount).toBe(2);
      expect(mockMarkNotificationsAsRead).toHaveBeenCalledWith({
        userId: "user-123",
        notificationIds: ["550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440001"],
        markAllAsRead: undefined,
      });
      expect(idempotency).toHaveBeenCalled();
    });

    it("marks all unread notifications as read when markAllAsRead is true", async () => {
      mockMarkNotificationsAsRead.mockResolvedValueOnce({ updatedCount: 3 });

      const res = await request(app)
        .post("/api/notifications/mark-read")
        .send({ markAllAsRead: true });

      expect(res.status).toBe(200);
      expect(res.body.data.updatedCount).toBe(3);
      expect(mockMarkNotificationsAsRead).toHaveBeenCalledWith({
        userId: "user-123",
        notificationIds: undefined,
        markAllAsRead: true,
      });
    });

    it("returns 400 when notificationIds is empty array and markAllAsRead is false", async () => {
      const res = await request(app)
        .post("/api/notifications/mark-read")
        .send({ notificationIds: [] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 when neither notificationIds nor markAllAsRead is provided", async () => {
      const res = await request(app)
        .post("/api/notifications/mark-read")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 400 for invalid UUID in notificationIds", async () => {
      const res = await request(app)
        .post("/api/notifications/mark-read")
        .send({ notificationIds: ["not-a-uuid"] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });
  });
});