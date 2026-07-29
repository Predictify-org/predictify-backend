import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminDbExplainRouter } from "../src/routes/admin/db/explain";
import { errorHandler } from "../src/middleware/errorHandler";

const mockQuery = jest.fn();

// Mock the db/client module
jest.mock("../src/db/client", () => ({
  getPool: () => ({
    query: mockQuery,
  }),
}));

const SECRET = process.env.JWT_SECRET || "test-jwt-secret-that-is-at-least-32-chars!!";
const ISSUER = process.env.JWT_ISSUER || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE || "predictify-app";

const ADMIN_ADDRESS = "GADMIN7777777777777777777777777777777777777777777777777777";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt = signJwt({ sub: ADMIN_ADDRESS, role: "user" });

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/db/explain", createAdminDbExplainRouter());
  app.use(errorHandler);
  return app;
}

function auth(req: request.Test): request.Test {
  return req.set("Authorization", `Bearer ${adminJwt}`);
}

describe("admin db-explain endpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(makeApp())
      .post("/api/admin/db/explain")
      .send({ queryId: "list_audit_logs", params: [10] })
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
  });

  it("rejects non-allowlisted queryId with 400", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/db/explain")
        .send({ queryId: "some_unallowed_query", params: [] })
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.message).toContain("queryId");
  });

  it("rejects invalid params schema with 400", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/db/explain")
        .send({ queryId: "list_audit_logs", params: ["not-a-number"] })
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.message).toContain("invalid query parameters");
  });

  it("returns EXPLAIN ANALYZE plan on success", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { "QUERY PLAN": "Limit  (cost=0.00..0.15 rows=1 width=16) (actual time=0.015..0.016 rows=1 loops=1)" },
        { "QUERY PLAN": "  ->  Seq Scan on audit_logs  (cost=0.00..15.40 rows=540 width=16) (actual time=0.014..0.014 rows=1 loops=1)" }
      ]
    });

    const res = await auth(
      request(makeApp())
        .post("/api/admin/db/explain")
        .send({ queryId: "list_audit_logs", params: [10] })
    );

    expect(res.status).toBe(200);
    expect(res.body.data.queryId).toBe("list_audit_logs");
    expect(res.body.data.explainPlan).toBeInstanceOf(Array);
    expect(res.body.data.explainPlan[0]).toContain("Limit");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("EXPLAIN ANALYZE"),
      [10]
    );
  });
});
