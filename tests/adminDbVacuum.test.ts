/**
 * adminDbVacuum.test.ts
 *
 * Tests for POST /api/admin/db/vacuum.
 *
 * All external I/O is replaced by in-memory stubs — no real DB required.
 * The route is tested via supertest (integration) and the executeVacuum
 * helper is tested directly (unit).
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { errorHandler } from "../src/middleware/errorHandler";
import {
  createAdminDbVacuumRouter,
  executeVacuum,
} from "../src/routes/admin/db/vacuum";

// ── Prevent real DB connections ────────────────────────────────────────────

jest.mock("../src/db/client", () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
  },
}));

// ── JWT helpers ────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET!;
const ISSUER = process.env.JWT_ISSUER ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";
const ADMIN_ADDR =
  "GADMIN0000000000000000000000000000000000000000000000000000";
const USER_ADDR =
  "GUSER0000000000000000000000000000000000000000000000000000";

function sign(payload: object): string {
  return jwt.sign(payload, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: "1h",
  });
}

const adminToken = sign({ sub: ADMIN_ADDR, role: "admin" });
const userToken = sign({ sub: USER_ADDR, role: "user" });

// ── App factory ────────────────────────────────────────────────────────────

const MOUNT = "/api/admin/db";

function makeApp(rateLimitPerMinute = 30): express.Express {
  const app = express();
  app.use(express.json());
  app.use(MOUNT, createAdminDbVacuumRouter({ rateLimitPerMinute }));
  app.use(errorHandler);
  return app;
}

// ── Mock pool factory ──────────────────────────────────────────────────────

function makeMockPool(
  failTables: string[] = [],
): { query: jest.Mock } {
  return {
    query: jest.fn().mockImplementation(async (sql: string) => {
      for (const t of failTables) {
        if (sql.includes(t)) {
          throw new Error(`VACUUM failed for ${t}`);
        }
      }
      return { rows: [] };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service unit tests — executeVacuum
// ─────────────────────────────────────────────────────────────────────────────

describe("executeVacuum — service unit tests", () => {
  it("vacuums a single table successfully", async () => {
    const pool = makeMockPool() as never;
    const result = await executeVacuum(
      pool,
      ["fraud_flags"],
      { analyze: false },
      "req-1",
    );

    expect(result.tables).toEqual(["fraud_flags"]);
    expect(result.vacuumResults).toHaveLength(1);
    expect(result.vacuumResults[0]).toEqual({
      table: "fraud_flags",
      status: "success",
    });
    expect(result.vacuumingTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.analyzingTimeMs).toBe(0);
  });

  it("vacuums multiple tables with analyze", async () => {
    const pool = makeMockPool() as never;
    const result = await executeVacuum(
      pool,
      ["fraud_flags", "idempotency_records"],
      { analyze: true },
      "req-2",
    );

    expect(result.tables).toEqual(["fraud_flags", "idempotency_records"]);
    expect(result.vacuumResults).toHaveLength(2);
    expect(result.vacuumResults.every((r) => r.status === "success")).toBe(
      true,
    );
    expect(result.analyzingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("reports failed status for tables that error", async () => {
    const pool = makeMockPool(["fraud_flags"]) as never;
    const result = await executeVacuum(
      pool,
      ["fraud_flags", "idempotency_records"],
      { analyze: false },
      "req-3",
    );

    expect(result.vacuumResults).toHaveLength(2);
    expect(result.vacuumResults[0].status).toBe("failed");
    expect(result.vacuumResults[0].message).toContain("VACUUM failed");
    expect(result.vacuumResults[1].status).toBe("success");
  });

  it("returns timing values as numbers", async () => {
    const pool = makeMockPool() as never;
    const result = await executeVacuum(
      pool,
      ["fraud_flags"],
      { analyze: true },
      "req-4",
    );

    expect(typeof result.vacuumingTimeMs).toBe("number");
    expect(typeof result.analyzingTimeMs).toBe("number");
  });

  it("handles empty table list gracefully", async () => {
    const pool = makeMockPool() as never;
    const result = await executeVacuum(pool, [], { analyze: false }, "req-5");

    expect(result.tables).toEqual([]);
    expect(result.vacuumResults).toHaveLength(0);
    expect(result.vacuumingTimeMs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP integration tests — POST /api/admin/db/vacuum
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/db — HTTP", () => {
  it("returns 403 with no Authorization header", async () => {
    const res = await request(makeApp()).post(MOUNT).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns 403 for a non-admin JWT", async () => {
    const res = await request(makeApp())
      .post(MOUNT)
      .set("Authorization", `Bearer ${userToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 403 for a JWT signed with wrong secret", async () => {
    const badToken = jwt.sign(
      { sub: ADMIN_ADDR, role: "admin" },
      "wrong-secret-at-least-32-characters-long",
      { issuer: ISSUER, audience: AUDIENCE },
    );
    const res = await request(makeApp())
      .post(MOUNT)
      .set("Authorization", `Bearer ${badToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("returns 200 with default tables when body is empty", async () => {
    const res = await request(makeApp())
      .post(MOUNT)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.tables).toBeDefined();
    expect(res.body.data.vacuumResults).toBeDefined();
    expect(Array.isArray(res.body.data.vacuumResults)).toBe(true);
  });

  it("returns 200 for valid explicit tables", async () => {
    const res = await request(makeApp())
      .post(MOUNT)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        tables: ["fraud_flags", "idempotency_records"],
        analyze: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.tables).toEqual([
      "fraud_flags",
      "idempotency_records",
    ]);
    expect(res.body.data.vacuumResults).toHaveLength(2);
    expect(
      res.body.data.vacuumResults.every(
        (r: { status: string }) => r.status === "success",
      ),
    ).toBe(true);
  });

  it("returns 400 for invalid table name", async () => {
    const res = await request(makeApp())
      .post(MOUNT)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ tables: ["nonexistent_table"] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.message).toContain("Invalid table name");
  });

  it("returns 400 for empty table name", async () => {
    const res = await request(makeApp())
      .post(MOUNT)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ tables: [""] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when more than 10 tables specified", async () => {
    const manyTables = [
      "users",
      "markets",
      "predictions",
      "fraud_flags",
      "claims",
      "disputes",
      "webhook_deliveries",
      "contract_events",
      "indexer_events",
      "audit_logs",
      "feature_flags",
    ];
    const res = await request(makeApp())
      .post(MOUNT)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ tables: manyTables });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.message).toContain("10");
  });

  it("returns 400 for unknown body fields (strict mode)", async () => {
    const res = await request(makeApp())
      .post(MOUNT)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ tables: ["users"], extraField: true });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 429 when rate limit is breached", async () => {
    const app = makeApp(1);
    const agent = request.agent(app);

    await agent
      .post(MOUNT)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ tables: ["users"] });

    const res = await agent
      .post(MOUNT)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ tables: ["users"] });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limit_exceeded");
  });
});
