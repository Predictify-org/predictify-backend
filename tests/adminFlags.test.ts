import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminFlagsRouter } from "../src/routes/admin/flags";
import * as featureFlagsService from "../src/services/featureFlags";

// Simple error handler for tests
const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: { code: err.code || "internal_error", message: err.message } });
};

jest.mock("../src/services/featureFlags");

const mockGetAllFlags = featureFlagsService.getAllFlags as jest.MockedFunction<typeof featureFlagsService.getAllFlags>;
const mockGetFlag = featureFlagsService.getFlag as jest.MockedFunction<typeof featureFlagsService.getFlag>;
const mockCreateFlag = featureFlagsService.createFlag as jest.MockedFunction<typeof featureFlagsService.createFlag>;
const mockUpdateFlag = featureFlagsService.updateFlag as jest.MockedFunction<typeof featureFlagsService.updateFlag>;
const mockDeleteFlag = featureFlagsService.deleteFlag as jest.MockedFunction<typeof featureFlagsService.deleteFlag>;

// ── JWT Helpers ──────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-32-bytes-long-000000";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS  = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt  = signJwt({ sub: USER_ADDRESS,  role: "user" });

function makeApp(rateLimitPerMinute = 60): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/flags", createAdminFlagsRouter({ rateLimitPerMinute }));
  app.use(errorHandler);
  return app;
}

describe("Admin Flags Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("auth", () => {
    it("returns 403 with no Authorization header", async () => {
      const res = await request(makeApp()).get("/api/admin/flags");
      expect(res.status).toBe(403);
    });

    it("returns 403 with a non-admin JWT", async () => {
      const res = await request(makeApp())
        .get("/api/admin/flags")
        .set("Authorization", `Bearer ${userJwt}`);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/admin/flags", () => {
    it("returns all flags", async () => {
      mockGetAllFlags.mockReturnValue([{ id: "f1", enabled: true, variant: null, description: null }]);
      const res = await request(makeApp())
        .get("/api/admin/flags")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe("GET /api/admin/flags/:key", () => {
    it("returns a flag if it exists", async () => {
      mockGetFlag.mockReturnValue({ enabled: true });
      const res = await request(makeApp())
        .get("/api/admin/flags/f1")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
    });

    it("returns 404 if flag does not exist", async () => {
      mockGetFlag.mockReturnValue(undefined);
      const res = await request(makeApp())
        .get("/api/admin/flags/f2")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/admin/flags", () => {
    it("creates a new flag", async () => {
      mockGetFlag.mockReturnValue(undefined);
      mockCreateFlag.mockResolvedValue({ id: "f1", enabled: true });
      const res = await request(makeApp())
        .post("/api/admin/flags")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ key: "f1", enabled: true });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("f1");
    });

    it("returns 400 for invalid payload", async () => {
      const res = await request(makeApp())
        .post("/api/admin/flags")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ enabled: true }); // missing key
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    });
  });

  describe("PATCH /api/admin/flags/:key", () => {
    it("updates a flag", async () => {
      mockUpdateFlag.mockResolvedValue({ id: "f1", enabled: false });
      const res = await request(makeApp())
        .patch("/api/admin/flags/f1")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
    });

    it("returns 404 if flag not found", async () => {
      mockUpdateFlag.mockResolvedValue(undefined);
      const res = await request(makeApp())
        .patch("/api/admin/flags/missing")
        .set("Authorization", `Bearer ${adminJwt}`)
        .send({ enabled: false });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/admin/flags/:key", () => {
    it("deletes a flag", async () => {
      mockDeleteFlag.mockResolvedValue(true);
      const res = await request(makeApp())
        .delete("/api/admin/flags/f1")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(204);
    });

    it("returns 404 if flag not found", async () => {
      mockDeleteFlag.mockResolvedValue(false);
      const res = await request(makeApp())
        .delete("/api/admin/flags/missing")
        .set("Authorization", `Bearer ${adminJwt}`);
      expect(res.status).toBe(404);
    });
  });
});
