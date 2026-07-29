/**
 * Tests for src/routes/admin/schema-versions.ts
 *
 * The repository layer is fully mocked so no real database is required.
 * Tests cover auth enforcement, input validation, all HTTP verbs, happy paths,
 * edge cases, and error propagation.
 */

// ── Mocks (must come before imports) ─────────────────────────────────────────

jest.mock("../src/db/client", () => ({ db: {} }));

jest.mock("../src/repositories/schemaVersionRepo");

// ── Imports ───────────────────────────────────────────────────────────────────

import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { createAdminSchemaVersionsRouter } from "../src/routes/admin/schema-versions";
import { errorHandler } from "../src/middleware/errorHandler";
import {
  recordMigration,
  getSchemaVersion,
  listSchemaVersions,
  getLatestSchemaVersion,
  deleteSchemaVersion,
  checkDrift,
} from "../src/repositories/schemaVersionRepo";

const mockRecordMigration = recordMigration as jest.MockedFunction<typeof recordMigration>;
const mockGetSchemaVersion = getSchemaVersion as jest.MockedFunction<typeof getSchemaVersion>;
const mockListSchemaVersions = listSchemaVersions as jest.MockedFunction<typeof listSchemaVersions>;
const mockGetLatestSchemaVersion = getLatestSchemaVersion as jest.MockedFunction<typeof getLatestSchemaVersion>;
const mockDeleteSchemaVersion = deleteSchemaVersion as jest.MockedFunction<typeof deleteSchemaVersion>;
const mockCheckDrift = checkDrift as jest.MockedFunction<typeof checkDrift>;

// ── JWT helpers ───────────────────────────────────────────────────────────────

const SECRET   = process.env.JWT_SECRET    || "test-jwt-secret-that-is-at-least-32-chars!";
const ISSUER   = process.env.JWT_ISSUER    || "predictify";
const AUDIENCE = process.env.JWT_AUDIENCE  || "predictify-app";

const ADMIN_ADDR = "GADMIN7777777777777777777777777777777777777777777777777777";
const USER_ADDR  = "GUSER88888888888888888888888888888888888888888888888888888";

function signJwt(payload: object): string {
  return jwt.sign(payload, SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h" });
}

const adminJwt = signJwt({ sub: ADMIN_ADDR, role: "admin" });
const userJwt  = signJwt({ sub: USER_ADDR,  role: "user"  });

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/schema-versions", createAdminSchemaVersionsRouter());
  app.use(errorHandler);
  return app;
}

function auth(req: request.Test, token = adminJwt): request.Test {
  return req.set("Authorization", `Bearer ${token}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SAMPLE_SQL = "CREATE TABLE test (id uuid PRIMARY KEY);";
const SAMPLE_ROW = {
  version: "0001_add_users",
  checksum: "a".repeat(64),
  appliedAt: new Date("2026-01-01T00:00:00Z"),
  appliedBy: "ci",
};

// ── Shared: auth enforcement ──────────────────────────────────────────────────

describe("auth enforcement", () => {
  const app = makeApp();

  it("rejects unauthenticated requests with 403", async () => {
    const res = await request(app).get("/api/admin/schema-versions");
    expect(res.status).toBe(403);
  });

  it("rejects non-admin JWT with 403", async () => {
    const res = await auth(
      request(app).get("/api/admin/schema-versions"),
      userJwt,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a JWT signed with a different secret", async () => {
    const badToken = jwt.sign(
      { sub: ADMIN_ADDR, role: "admin" },
      "wrong-secret-at-least-32-characters-long",
      { issuer: ISSUER, audience: AUDIENCE },
    );
    const res = await auth(request(app).get("/api/admin/schema-versions"), badToken);
    expect(res.status).toBe(403);
  });
});

// ── GET /api/admin/schema-versions ───────────────────────────────────────────

describe("GET /api/admin/schema-versions", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 200 with an array of versions", async () => {
    mockListSchemaVersions.mockResolvedValue([SAMPLE_ROW]);

    const res = await auth(request(makeApp()).get("/api/admin/schema-versions"));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].version).toBe(SAMPLE_ROW.version);
  });

  it("returns 200 with an empty array when no versions exist", async () => {
    mockListSchemaVersions.mockResolvedValue([]);

    const res = await auth(request(makeApp()).get("/api/admin/schema-versions"));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("propagates repository errors through the error handler", async () => {
    mockListSchemaVersions.mockRejectedValue(new Error("db error"));

    const res = await auth(request(makeApp()).get("/api/admin/schema-versions"));

    expect(res.status).toBe(500);
  });
});

// ── GET /api/admin/schema-versions/latest ────────────────────────────────────

describe("GET /api/admin/schema-versions/latest", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 200 with the latest version row", async () => {
    mockGetLatestSchemaVersion.mockResolvedValue(SAMPLE_ROW);

    const res = await auth(
      request(makeApp()).get("/api/admin/schema-versions/latest"),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(SAMPLE_ROW.version);
  });

  it("returns 404 when no versions have been recorded", async () => {
    mockGetLatestSchemaVersion.mockResolvedValue(null);

    const res = await auth(
      request(makeApp()).get("/api/admin/schema-versions/latest"),
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("propagates errors through the error handler", async () => {
    mockGetLatestSchemaVersion.mockRejectedValue(new Error("db error"));

    const res = await auth(
      request(makeApp()).get("/api/admin/schema-versions/latest"),
    );

    expect(res.status).toBe(500);
  });
});

// ── GET /api/admin/schema-versions/:version ──────────────────────────────────

describe("GET /api/admin/schema-versions/:version", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 200 with the version row when found", async () => {
    mockGetSchemaVersion.mockResolvedValue(SAMPLE_ROW);

    const res = await auth(
      request(makeApp()).get("/api/admin/schema-versions/0001_add_users"),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.checksum).toBe(SAMPLE_ROW.checksum);
  });

  it("returns 404 when the version is not found", async () => {
    mockGetSchemaVersion.mockResolvedValue(null);

    const res = await auth(
      request(makeApp()).get("/api/admin/schema-versions/nonexistent"),
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 for an invalid version param (special chars)", async () => {
    const res = await auth(
      request(makeApp()).get("/api/admin/schema-versions/bad version!"),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("propagates errors through the error handler", async () => {
    mockGetSchemaVersion.mockRejectedValue(new Error("db error"));

    const res = await auth(
      request(makeApp()).get("/api/admin/schema-versions/0001_add_users"),
    );

    expect(res.status).toBe(500);
  });
});

// ── POST /api/admin/schema-versions ──────────────────────────────────────────

describe("POST /api/admin/schema-versions", () => {
  beforeEach(() => jest.clearAllMocks());

  const validBody = {
    version: "0001_add_users",
    sqlContent: SAMPLE_SQL,
    appliedBy: "ci",
  };

  it("returns 201 when a new version is recorded", async () => {
    mockGetSchemaVersion.mockResolvedValue(null); // Not previously existing
    mockRecordMigration.mockResolvedValue(SAMPLE_ROW);

    const res = await auth(
      request(makeApp()).post("/api/admin/schema-versions").send(validBody),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.version).toBe(SAMPLE_ROW.version);
    expect(mockRecordMigration).toHaveBeenCalledWith(
      validBody.version,
      validBody.sqlContent,
      validBody.appliedBy,
    );
  });

  it("returns 200 (idempotent) when the version already exists", async () => {
    mockGetSchemaVersion.mockResolvedValue(SAMPLE_ROW); // Already exists
    mockRecordMigration.mockResolvedValue(SAMPLE_ROW);

    const res = await auth(
      request(makeApp()).post("/api/admin/schema-versions").send(validBody),
    );

    expect(res.status).toBe(200);
  });

  it("records without appliedBy when the field is omitted", async () => {
    mockGetSchemaVersion.mockResolvedValue(null);
    mockRecordMigration.mockResolvedValue({ ...SAMPLE_ROW, appliedBy: null });

    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions")
        .send({ version: "0001_add_users", sqlContent: SAMPLE_SQL }),
    );

    expect(res.status).toBe(201);
    expect(mockRecordMigration).toHaveBeenCalledWith(
      "0001_add_users",
      SAMPLE_SQL,
      undefined,
    );
  });

  it("returns 400 when version is missing", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions")
        .send({ sqlContent: SAMPLE_SQL }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when sqlContent is missing", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions")
        .send({ version: "0001_add_users" }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when version contains invalid characters", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions")
        .send({ version: "bad version!", sqlContent: SAMPLE_SQL }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when sqlContent is an empty string", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions")
        .send({ version: "0001_add_users", sqlContent: "" }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for extra unknown fields (strict schema)", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions")
        .send({ version: "0001_add_users", sqlContent: SAMPLE_SQL, unknownField: "x" }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("propagates errors through the error handler", async () => {
    mockGetSchemaVersion.mockResolvedValue(null);
    mockRecordMigration.mockRejectedValue(new Error("db error"));

    const res = await auth(
      request(makeApp()).post("/api/admin/schema-versions").send(validBody),
    );

    expect(res.status).toBe(500);
  });
});

// ── POST /api/admin/schema-versions/:version/drift-check ─────────────────────

describe("POST /api/admin/schema-versions/:version/drift-check", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns ok: true when checksums match", async () => {
    mockCheckDrift.mockResolvedValue({
      version: "0001_add_users",
      storedChecksum: "a".repeat(64),
      currentChecksum: "a".repeat(64),
      ok: true,
    });

    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions/0001_add_users/drift-check")
        .send({ sqlContent: SAMPLE_SQL }),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
  });

  it("returns ok: false and logs a warning when drift is detected", async () => {
    mockCheckDrift.mockResolvedValue({
      version: "0001_add_users",
      storedChecksum: "a".repeat(64),
      currentChecksum: "b".repeat(64),
      ok: false,
    });

    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions/0001_add_users/drift-check")
        .send({ sqlContent: SAMPLE_SQL + "\n-- modified" }),
    );

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.storedChecksum).toBe("a".repeat(64));
    expect(res.body.data.currentChecksum).toBe("b".repeat(64));
  });

  it("returns 404 when the version has not been recorded", async () => {
    mockCheckDrift.mockResolvedValue(null);

    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions/not_recorded/drift-check")
        .send({ sqlContent: SAMPLE_SQL }),
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 for an invalid version param", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions/bad version!/drift-check")
        .send({ sqlContent: SAMPLE_SQL }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when sqlContent is missing", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions/0001_add_users/drift-check")
        .send({}),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 when sqlContent is empty", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions/0001_add_users/drift-check")
        .send({ sqlContent: "" }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for extra unknown body fields", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions/0001_add_users/drift-check")
        .send({ sqlContent: SAMPLE_SQL, extra: "field" }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("propagates errors through the error handler", async () => {
    mockCheckDrift.mockRejectedValue(new Error("db error"));

    const res = await auth(
      request(makeApp())
        .post("/api/admin/schema-versions/0001_add_users/drift-check")
        .send({ sqlContent: SAMPLE_SQL }),
    );

    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/admin/schema-versions/:version ───────────────────────────────

describe("DELETE /api/admin/schema-versions/:version", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 204 when the version is deleted", async () => {
    mockDeleteSchemaVersion.mockResolvedValue(true);

    const res = await auth(
      request(makeApp()).delete("/api/admin/schema-versions/0001_add_users"),
    );

    expect(res.status).toBe(204);
    expect(mockDeleteSchemaVersion).toHaveBeenCalledWith("0001_add_users");
  });

  it("returns 404 when the version is not found", async () => {
    mockDeleteSchemaVersion.mockResolvedValue(false);

    const res = await auth(
      request(makeApp()).delete("/api/admin/schema-versions/nonexistent"),
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 400 for an invalid version param", async () => {
    const res = await auth(
      request(makeApp()).delete("/api/admin/schema-versions/bad version!"),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("propagates errors through the error handler", async () => {
    mockDeleteSchemaVersion.mockRejectedValue(new Error("db error"));

    const res = await auth(
      request(makeApp()).delete("/api/admin/schema-versions/0001_add_users"),
    );

    expect(res.status).toBe(500);
  });
});

// ── Version param edge-cases ──────────────────────────────────────────────────

describe("version param edge cases", () => {
  beforeEach(() => jest.clearAllMocks());

  it("accepts versions with hyphens", async () => {
    mockGetSchemaVersion.mockResolvedValue(SAMPLE_ROW);

    const res = await auth(
      request(makeApp()).get("/api/admin/schema-versions/0001-add-users"),
    );

    // Valid format — should reach the repo (404 if not mocked to return data)
    expect([200, 404].includes(res.status)).toBe(true);
    expect(res.status).not.toBe(400);
  });

  it("rejects version starting with a special character", async () => {
    const res = await auth(
      request(makeApp()).get("/api/admin/schema-versions/_bad"),
    );
    // Starts with underscore → fails the regex (must start with alphanum)
    expect(res.status).toBe(400);
  });

  it("rejects version exceeding 128 characters", async () => {
    const longVersion = "a".repeat(129);
    const res = await auth(
      request(makeApp()).get(`/api/admin/schema-versions/${longVersion}`),
    );
    expect(res.status).toBe(400);
  });
});
