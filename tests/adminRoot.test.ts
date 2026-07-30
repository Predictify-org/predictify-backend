import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { logger } from "../src/config/logger";
import { errorHandler } from "../src/middleware/errorHandler";
import { correlationMiddleware } from "../src/middleware/correlation";
import {
  createAdminRouter,
  defaultAdminRouteItems,
  type AdminRouteItem,
} from "../src/routes/admin";

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-at-least-32-bytes-long-000000";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt = signJwt({ sub: USER_ADDRESS, role: "user" });

function makeApp(items?: readonly AdminRouteItem[]): express.Express {
  const app = express();
  app.use(express.json());
  app.use(correlationMiddleware);
  app.use("/api/admin", createAdminRouter({ items, rateLimitPerMinute: 60 }));
  app.use(errorHandler);
  return app;
}

describe("GET /api/admin", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 403 with no Authorization header", async () => {
    const res = await request(makeApp()).get("/api/admin");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 403 with a non-admin JWT", async () => {
    const res = await request(makeApp())
      .get("/api/admin")
      .set("Authorization", `Bearer ${userJwt}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns the paginated admin envelope", async () => {
    const res = await request(makeApp())
      .get("/api/admin")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body).toHaveProperty("next_cursor");
    expect(res.body.total).toBe(defaultAdminRouteItems.length);
    expect(res.body.items[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        method: expect.any(String),
        path: expect.any(String),
        summary: expect.any(String),
      }),
    );
  });

  it("returns 422 for an invalid limit", async () => {
    const res = await request(makeApp())
      .get("/api/admin?limit=abc")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("x-correlation-id", "corr-invalid-limit");

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.message).toContain("limit must be a positive integer");
    expect(res.body.error.correlationId).toBe("corr-invalid-limit");
  });

  it("returns 422 for unknown query parameters", async () => {
    const res = await request(makeApp())
      .get("/api/admin?unexpected=true")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("paginates with next_cursor and total", async () => {
    const items: readonly AdminRouteItem[] = [
      { id: "GET /api/admin/a", method: "GET", path: "/api/admin/a", summary: "A" },
      { id: "GET /api/admin/b", method: "GET", path: "/api/admin/b", summary: "B" },
      { id: "GET /api/admin/c", method: "GET", path: "/api/admin/c", summary: "C" },
    ];

    const first = await request(makeApp(items))
      .get("/api/admin?limit=2")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(first.status).toBe(200);
    expect(first.body.items.map((item: AdminRouteItem) => item.id)).toEqual([
      "GET /api/admin/c",
      "GET /api/admin/b",
    ]);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    expect(first.body.total).toBe(3);

    const second = await request(makeApp(items))
      .get(`/api/admin?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(second.status).toBe(200);
    expect(second.body.items.map((item: AdminRouteItem) => item.id)).toEqual([
      "GET /api/admin/a",
    ]);
    expect(second.body.next_cursor).toBeNull();
    expect(second.body.total).toBe(3);
  });

  it("logs correlation-aware structured events", async () => {
    const infoSpy = jest.spyOn(logger, "info").mockImplementation();

    const res = await request(makeApp())
      .get("/api/admin")
      .set("Authorization", `Bearer ${adminJwt}`)
      .set("x-correlation-id", "corr-admin-root");

    expect(res.status).toBe(200);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "admin_index_requested",
        correlationId: "corr-admin-root",
        adminAddress: ADMIN_ADDRESS,
      }),
      "admin_index_requested",
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "admin_index_returned",
        correlationId: "corr-admin-root",
        adminAddress: ADMIN_ADDRESS,
        total: defaultAdminRouteItems.length,
      }),
      "admin_index_returned",
    );
  });
});
