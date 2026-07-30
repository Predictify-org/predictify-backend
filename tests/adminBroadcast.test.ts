process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-that-is-at-least-32-chars!!";
process.env.JWT_ISSUER = process.env.JWT_ISSUER || "predictify";
process.env.JWT_AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { db } from "../src/db/client";
import { errorHandler } from "../src/middleware/errorHandler";
import { correlationMiddleware } from "../src/middleware/correlation";
import { createAdminBroadcastRouter } from "../src/routes/admin/notifications/broadcast";
import { broadcastNotification } from "../src/services/notificationService";

jest.mock("../src/db/client", () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
}));

const SECRET = process.env.JWT_SECRET!;
const ISSUER = process.env.JWT_ISSUER!;
const AUDIENCE = process.env.JWT_AUDIENCE!;

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDRESS, role: "user" });

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(correlationMiddleware);
  app.use("/api/admin/notifications/broadcast", createAdminBroadcastRouter({ rateLimitPerMinute: 60 }));
  app.use(errorHandler);
  return app;
}

describe("Admin Notifications Broadcast", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Service: broadcastNotification", () => {
    it("returns zero counts when no users exist in DB", async () => {
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockResolvedValue([]),
      });

      const result = await broadcastNotification({
        title: "Test Title",
        body: "Test Body",
      });

      expect(result).toEqual({ recipientCount: 0, notificationCount: 0 });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("inserts notification rows in batches for existing users", async () => {
      const mockUsers = [
        { id: "user-uuid-1" },
        { id: "user-uuid-2" },
        { id: "user-uuid-3" },
      ];

      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockResolvedValue(mockUsers),
      });

      const mockValues = jest.fn().mockResolvedValue({});
      (db.insert as jest.Mock).mockReturnValue({
        values: mockValues,
      });

      const result = await broadcastNotification({
        title: "System Update",
        body: "We updated the system.",
        type: "announcement",
        data: { feature: "dark_mode" },
      });

      expect(result).toEqual({ recipientCount: 3, notificationCount: 3 });
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(mockValues).toHaveBeenCalledWith([
        {
          userId: "user-uuid-1",
          type: "announcement",
          title: "System Update",
          body: "We updated the system.",
          data: { feature: "dark_mode" },
        },
        {
          userId: "user-uuid-2",
          type: "announcement",
          title: "System Update",
          body: "We updated the system.",
          data: { feature: "dark_mode" },
        },
        {
          userId: "user-uuid-3",
          type: "announcement",
          title: "System Update",
          body: "We updated the system.",
          data: { feature: "dark_mode" },
        },
      ]);
    });

    it("handles batching when user count exceeds batch size (500)", async () => {
      const mockUsers = Array.from({ length: 650 }, (_, i) => ({ id: `user-uuid-${i}` }));

      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockResolvedValue(mockUsers),
      });

      const mockValues = jest.fn().mockResolvedValue({});
      (db.insert as jest.Mock).mockReturnValue({
        values: mockValues,
      });

      const result = await broadcastNotification({
        title: "Large Batch",
        body: "Broadcasting to many users",
      });

      expect(result).toEqual({ recipientCount: 650, notificationCount: 650 });
      expect(db.insert).toHaveBeenCalledTimes(2);
    });
  });

  describe("Route: POST /api/admin/notifications/broadcast", () => {
    it("returns 403 when Authorization header is missing", async () => {
      const res = await request(makeApp())
        .post("/api/admin/notifications/broadcast")
        .send({ title: "Title", body: "Body" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "forbidden" } });
    });

    it("returns 403 when called with a non-admin token", async () => {
      const res = await request(makeApp())
        .post("/api/admin/notifications/broadcast")
        .set("Authorization", `Bearer ${userJwt}`)
        .send({ title: "Title", body: "Body" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: "forbidden" } });
    });

    it("returns 422 when title is missing", async () => {
      const res = await request(makeApp())
        .post("/api/admin/notifications/broadcast")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ body: "Only body provided" });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 422 when title is an empty string", async () => {
      const res = await request(makeApp())
        .post("/api/admin/notifications/broadcast")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ title: "   ", body: "Valid body" });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.message).toContain("title must not be empty");
    });

    it("returns 422 when body is missing", async () => {
      const res = await request(makeApp())
        .post("/api/admin/notifications/broadcast")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ title: "Valid Title" });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("returns 422 when body exceeds 2000 characters", async () => {
      const longBody = "a".repeat(2001);
      const res = await request(makeApp())
        .post("/api/admin/notifications/broadcast")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ title: "Title", body: longBody });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.message).toContain("body must be at most 2000 characters");
    });

    it("returns 422 when unknown fields are supplied", async () => {
      const res = await request(makeApp())
        .post("/api/admin/notifications/broadcast")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ title: "Title", body: "Body", invalidProp: 123 });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_error");
    });

    it("successfully broadcasts notification and returns 201 Created", async () => {
      const mockUsers = [{ id: "user-1" }, { id: "user-2" }];

      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockResolvedValue(mockUsers),
      });

      (db.insert as jest.Mock).mockReturnValue({
        values: jest.fn().mockResolvedValue({}),
      });

      const res = await request(makeApp())
        .post("/api/admin/notifications/broadcast")
        .set("Authorization", `Bearer ${adminJwt}`)
        .set("x-correlation-id", "test-corr-id-123")
        .send({
          title: "Platform Upgrade",
          body: "We upgraded the database engine.",
          type: "system_update",
          data: { version: "2.1.0" },
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        data: {
          recipientCount: 2,
          notificationCount: 2,
        },
      });
    });
  });
});
