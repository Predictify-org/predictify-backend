import express from "express";
import request from "supertest";
import { auditRouter } from "../../routes/audit";

// Mock the logger to prevent test output noise
jest.mock("../../config/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe("auditRouter", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    // By default the auditRouter reads from env.AUDIT_CORS_ALLOWED_ORIGINS.
    // In test env that is "http://localhost:5173,https://admin.predictify.dev",
    // so use a matching origin in requests below.
    app.use("/api/audit", auditRouter);
  });

  describe("GET /api/audit", () => {
    const allowedOrigin = "http://localhost:5173";

    it("returns a list of audit events", async () => {
      const response = await request(app)
        .get("/api/audit")
        .set("Origin", allowedOrigin);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], next_cursor: null });
    });

    it("accepts a valid limit query parameter", async () => {
      const response = await request(app)
        .get("/api/audit?limit=5")
        .set("Origin", allowedOrigin);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], next_cursor: null });

    it("keeps the envelope stable when a cursor is provided", async () => {
      const response = await request(app)
        .get("/api/audit?limit=5&cursor=opaque-cursor")
        .set("Origin", allowedOrigin);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], next_cursor: null });
    });
    });

    it("returns 400 if limit is not a number", async () => {
      const response = await request(app)
        .get("/api/audit?limit=abc")
        .set("Origin", allowedOrigin);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: "invalid_input",
          message: "Limit must be between 1 and 100",
        },
      });
    });

    it("returns 400 if limit is less than 1", async () => {
      const response = await request(app)
        .get("/api/audit?limit=0")
        .set("Origin", allowedOrigin);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: "invalid_input",
          message: "Limit must be between 1 and 100",
        },
      });
    });

    it("returns 400 if limit is greater than 100", async () => {
      const response = await request(app)
        .get("/api/audit?limit=101")
        .set("Origin", allowedOrigin);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: "invalid_input",
          message: "Limit must be between 1 and 100",
        },
      });
    });
  });

  describe("CORS enforcement", () => {
    const allowedOrigin = "http://localhost:5173";

    it("sets Access-Control-Allow-Origin on allowed requests", async () => {
      const res = await request(app)
        .get("/api/audit")
        .set("Origin", allowedOrigin);

      expect(res.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    });

    it("sets Access-Control-Allow-Credentials on allowed requests", async () => {
      const res = await request(app)
        .get("/api/audit")
        .set("Origin", allowedOrigin);

      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("denies requests from a disallowed origin", async () => {
      const res = await request(app)
        .get("/api/audit")
        .set("Origin", "https://evil.example.com");

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("denies requests with no Origin header", async () => {
      const res = await request(app).get("/api/audit");

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    });

    it("responds with 204 for allowed OPTIONS preflight", async () => {
      const res = await request(app)
        .options("/api/audit")
        .set("Origin", allowedOrigin);

      expect(res.status).toBe(204);
    });

    it("denies OPTIONS preflight from a disallowed origin", async () => {
      const res = await request(app)
        .options("/api/audit")
        .set("Origin", "https://evil.example.com");

      expect(res.status).toBe(403);
    });

    it("sets Access-Control-Max-Age on preflight response", async () => {
      const res = await request(app)
        .options("/api/audit")
        .set("Origin", allowedOrigin);

      expect(res.headers["access-control-max-age"]).toBe("600");
    });
  });
});
