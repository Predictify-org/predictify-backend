/**
 * Tests for /api/admin/users/:addr/notes
 *
 *   GET    /api/admin/users/:addr/notes        — list notes
 *   POST   /api/admin/users/:addr/notes        — create note
 *   DELETE /api/admin/users/:addr/notes/:id    — delete note
 *
 * Strategy
 * ────────
 * - Inject a mock DB client (opts.dbClient) so no real database is required.
 * - Sign real JWTs with the test JWT_SECRET so requireAdmin exercises its full
 *   verification path.
 * - Mount createAdminNotesRouter() on a minimal Express app so tests are
 *   isolated from the full application.
 * - Rate-limit ceiling is set to 2 on the 429 test so we only need 3 requests.
 */

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminNotesRouter } from "../src/routes/admin/users/notes";
import { errorHandler } from "../src/middleware/errorHandler";

// ── Prevent a real DB connection being opened at import time ──────────────────
jest.mock("../src/db/client", () => ({ db: {} }));

// ── Constants ─────────────────────────────────────────────────────────────────

const SECRET   = process.env.JWT_SECRET!;
const ISSUER   = process.env.JWT_ISSUER  ?? "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE ?? "predictify-app";

// A valid Stellar public key (G + 55 uppercase base-32 chars).
const ADMIN_ADDRESS  = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDRESS   = "GUSER88888888888888888888888888888888888888888888888888888";
const TARGET_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const NOTE_ID_1 = "11111111-1111-1111-1111-111111111111";
const NOTE_ID_2 = "22222222-2222-2222-2222-222222222222";

// ── JWT helpers ───────────────────────────────────────────────────────────────

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDRESS, role: "admin" });
const userJwt  = signJwt({ sub: USER_ADDRESS,  role: "user"  });

// ── DB mock factory ───────────────────────────────────────────────────────────

/**
 * Returns a lightweight DB mock that satisfies the chain calls made by the
 * notes router:  client.select(...).from(...).where(...).orderBy(...)
 *                client.insert(...).values(...).returning()
 *                client.delete(...).where(...).returning(...)
 */
function makeMockDb(overrides: {
  selectRows?: object[];
  insertReturns?: object;
  deleteReturns?: object[];
} = {}) {
  const insertValues = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue(
      overrides.insertReturns
        ? [overrides.insertReturns]
        : [{
            id: NOTE_ID_1,
            targetAddress: TARGET_ADDRESS,
            adminAddress: ADMIN_ADDRESS,
            note: "test note",
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
          }],
    ),
  });

  const auditInsertValues = jest.fn().mockResolvedValue({});

  // The router calls insert() twice (note insert, then audit insert).
  // We track call count to distinguish them.
  let insertCallCount = 0;
  const insertFn = jest.fn().mockImplementation(() => {
    insertCallCount++;
    if (insertCallCount === 1) {
      return { values: insertValues };
    }
    // Second call is the audit log — no .returning()
    return { values: auditInsertValues };
  });

  const deleteFn = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue(
        overrides.deleteReturns ?? [{ id: NOTE_ID_1 }],
      ),
    }),
  });

  const rows = overrides.selectRows ?? [
    {
      id: NOTE_ID_1,
      targetAddress: TARGET_ADDRESS,
      adminAddress: ADMIN_ADDRESS,
      note: "first note",
      createdAt: new Date("2024-01-02T00:00:00.000Z"),
    },
    {
      id: NOTE_ID_2,
      targetAddress: TARGET_ADDRESS,
      adminAddress: ADMIN_ADDRESS,
      note: "second note",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
  ];

  const selectFn = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockResolvedValue(rows),
      }),
    }),
  });

  return {
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    // Expose internals for assertions
    _insertValues: insertValues,
    _auditInsertValues: auditInsertValues,
  };
}

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(
  dbClient: ReturnType<typeof makeMockDb>,
  rateLimitPerMinute = 100,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin/users",
    createAdminNotesRouter({ dbClient: dbClient as never, rateLimitPerMinute }),
  );
  app.use(errorHandler);
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════════
// requireAdmin guard — shared across all three endpoints
// ═══════════════════════════════════════════════════════════════════════════════

describe("requireAdmin guard", () => {
  const db = makeMockDb();
  const app = makeApp(db);

  it("returns 403 with no Authorization header (GET)", async () => {
    const res = await request(app).get(`/api/admin/users/${TARGET_ADDRESS}/notes`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });

  it("returns 403 with a non-admin JWT on GET", async () => {
    const res = await request(app)
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with a JWT signed by the wrong secret on GET", async () => {
    const bad = jwt.sign(
      { sub: ADMIN_ADDRESS, role: "admin" },
      "wrong-secret-at-least-32-characters-long",
      { issuer: ISSUER, audience: AUDIENCE },
    );
    const res = await request(app)
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${bad}`);
    expect(res.status).toBe(403);
  });

  it("returns 403 with an expired JWT on POST", async () => {
    const expired = jwt.sign(
      { sub: ADMIN_ADDRESS, role: "admin" },
      SECRET,
      { issuer: ISSUER, audience: AUDIENCE, expiresIn: -1 },
    );
    const res = await request(app)
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${expired}`)
      .send({ note: "hello" });
    expect(res.status).toBe(403);
  });

  it("returns 403 with no Authorization header (DELETE)", async () => {
    const res = await request(app)
      .delete(`/api/admin/users/${TARGET_ADDRESS}/notes/${NOTE_ID_1}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden" } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/admin/users/:addr/notes
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/admin/users/:addr/notes", () => {
  it("returns 200 with an array of notes", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  it("returns notes with all expected fields", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`);

    const note = res.body.data[0];
    expect(note).toHaveProperty("id");
    expect(note).toHaveProperty("targetAddress");
    expect(note).toHaveProperty("adminAddress");
    expect(note).toHaveProperty("note");
    expect(note).toHaveProperty("createdAt");
  });

  it("returns createdAt as an ISO-8601 string", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(typeof res.body.data[0].createdAt).toBe("string");
    expect(() => new Date(res.body.data[0].createdAt)).not.toThrow();
  });

  it("returns an empty array when the user has no notes", async () => {
    const db = makeMockDb({ selectRows: [] });
    const res = await request(makeApp(db))
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("returns 400 for an invalid Stellar address", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .get("/api/admin/users/not-an-address/notes")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("propagates DB errors as 500 via errorHandler", async () => {
    const db = makeMockDb();
    (db.select as jest.Mock).mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockRejectedValue(new Error("db down")),
        }),
      }),
    });

    const res = await request(makeApp(db))
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/admin/users/:addr/notes
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/admin/users/:addr/notes", () => {
  it("returns 201 with the created note", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ note: "suspicious activity noted" });

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty("id");
    expect(res.body.data).toHaveProperty("note");
    expect(res.body.data).toHaveProperty("createdAt");
  });

  it("persists the note with the correct targetAddress and adminAddress", async () => {
    const db = makeMockDb();
    await request(makeApp(db))
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ note: "test note" });

    expect(db._insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        targetAddress: TARGET_ADDRESS,
        adminAddress: ADMIN_ADDRESS,
        note: "test note",
      }),
    );
  });

  it("writes an audit log row on success", async () => {
    const db = makeMockDb();
    await request(makeApp(db))
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ note: "audit this" });

    expect(db._auditInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        adminAddress: ADMIN_ADDRESS,
        action: "create_user_note",
        targetAddress: TARGET_ADDRESS,
      }),
    );
  });

  it("returns 400 for an invalid Stellar address", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .post("/api/admin/users/bad-addr/notes")
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ note: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when note is missing", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when note is an empty string", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ note: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when note exceeds 2000 characters", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ note: "x".repeat(2_001) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("accepts a note of exactly 2000 characters", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ note: "x".repeat(2_000) });

    expect(res.status).toBe(201);
  });

  it("rejects unknown body fields (strict schema)", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ note: "ok", evil: "field" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("propagates DB insert errors as 500", async () => {
    const db = makeMockDb();
    (db.insert as jest.Mock).mockReturnValueOnce({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockRejectedValue(new Error("constraint violation")),
      }),
    });

    const res = await request(makeApp(db))
      .post(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`)
      .send({ note: "note" });

    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/admin/users/:addr/notes/:id
// ═══════════════════════════════════════════════════════════════════════════════

describe("DELETE /api/admin/users/:addr/notes/:id", () => {
  it("returns 200 with { deleted: true } on success", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .delete(`/api/admin/users/${TARGET_ADDRESS}/notes/${NOTE_ID_1}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });
  });

  it("writes an audit log row on success", async () => {
    const db = makeMockDb();

    // For DELETE, there is exactly ONE insert call — the audit log.
    // Override insert so we can spy on the values passed to it.
    const auditValues = jest.fn().mockResolvedValue({});
    (db.insert as jest.Mock).mockReturnValueOnce({ values: auditValues });

    await request(makeApp(db))
      .delete(`/api/admin/users/${TARGET_ADDRESS}/notes/${NOTE_ID_1}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        adminAddress: ADMIN_ADDRESS,
        action: "delete_user_note",
        targetAddress: TARGET_ADDRESS,
      }),
    );
  });

  it("returns 404 when the note does not exist for that address", async () => {
    const db = makeMockDb({ deleteReturns: [] });
    const res = await request(makeApp(db))
      .delete(`/api/admin/users/${TARGET_ADDRESS}/notes/${NOTE_ID_1}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("does not write audit log when note is not found", async () => {
    const db = makeMockDb({ deleteReturns: [] });
    await request(makeApp(db))
      .delete(`/api/admin/users/${TARGET_ADDRESS}/notes/${NOTE_ID_1}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(db._auditInsertValues).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid Stellar address", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .delete(`/api/admin/users/bad-address/notes/${NOTE_ID_1}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for an invalid note UUID", async () => {
    const db = makeMockDb();
    const res = await request(makeApp(db))
      .delete(`/api/admin/users/${TARGET_ADDRESS}/notes/not-a-uuid`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("propagates DB delete errors as 500", async () => {
    const db = makeMockDb();
    (db.delete as jest.Mock).mockReturnValueOnce({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockRejectedValue(new Error("db error")),
      }),
    });

    const res = await request(makeApp(db))
      .delete(`/api/admin/users/${TARGET_ADDRESS}/notes/${NOTE_ID_1}`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rate limiting
// ═══════════════════════════════════════════════════════════════════════════════

describe("rate limiting", () => {
  it("returns 429 after the per-admin limit is exceeded", async () => {
    const db = makeMockDb({ selectRows: [] });
    const app = makeApp(db, 2); // limit = 2

    await request(app)
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`);
    await request(app)
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`);

    const res = await request(app)
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: { code: "rate_limit_exceeded" } });
  });

  it("includes RateLimit headers on successful responses", async () => {
    const db = makeMockDb({ selectRows: [] });
    const res = await request(makeApp(db))
      .get(`/api/admin/users/${TARGET_ADDRESS}/notes`)
      .set("Authorization", `Bearer ${adminJwt}`);

    // draft-6 standard headers
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });
});
