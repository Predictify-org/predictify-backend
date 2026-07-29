/**
 * Tests for src/repositories/schemaVersionRepo.ts
 *
 * All DB interactions are mocked so no real database is needed.
 * Coverage targets: branches 90%+, functions 100%, lines 90%+.
 */

// ── DB mock must be declared before repo import ──────────────────────────────

jest.mock("../src/db/client", () => {
  const chain: Record<string, jest.Mock> = {};
  const methods = [
    "select",
    "from",
    "where",
    "orderBy",
    "limit",
    "insert",
    "values",
    "onConflictDoNothing",
    "returning",
    "delete",
  ];
  methods.forEach((m) => {
    chain[m] = jest.fn().mockReturnThis();
  });
  return { db: chain };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { db } from "../src/db/client";
import {
  computeChecksum,
  isValidChecksum,
  recordMigration,
  getSchemaVersion,
  listSchemaVersions,
  getLatestSchemaVersion,
  deleteSchemaVersion,
  checkDrift,
} from "../src/repositories/schemaVersionRepo";

const mockDb = db as unknown as Record<string, jest.Mock>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const SAMPLE_SQL = "CREATE TABLE users (id uuid PRIMARY KEY);";
const SAMPLE_VERSION = "0001_add_users";
const SAMPLE_CHECKSUM = computeChecksum(SAMPLE_SQL);

const mockRow = {
  version: SAMPLE_VERSION,
  checksum: SAMPLE_CHECKSUM,
  appliedAt: new Date("2026-01-01T00:00:00Z"),
  appliedBy: "ci",
};

beforeEach(() => {
  jest.clearAllMocks();
  // Reset chain so each test starts fresh
  Object.values(mockDb).forEach((fn) => {
    fn.mockReturnThis();
  });
});

// ── computeChecksum ──────────────────────────────────────────────────────────

describe("computeChecksum", () => {
  it("returns a 64-character lowercase hex string", () => {
    const result = computeChecksum("hello world");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input produces same output", () => {
    expect(computeChecksum(SAMPLE_SQL)).toBe(computeChecksum(SAMPLE_SQL));
  });

  it("produces different checksums for different inputs", () => {
    expect(computeChecksum("foo")).not.toBe(computeChecksum("bar"));
  });

  it("handles empty string input", () => {
    const result = computeChecksum("");
    expect(result).toHaveLength(64);
  });

  it("is sensitive to whitespace differences", () => {
    expect(computeChecksum("a b")).not.toBe(computeChecksum("ab"));
  });
});

// ── isValidChecksum ──────────────────────────────────────────────────────────

describe("isValidChecksum", () => {
  it("returns true for a valid 64-char lowercase hex string", () => {
    expect(isValidChecksum(SAMPLE_CHECKSUM)).toBe(true);
  });

  it("returns false for a string with uppercase letters", () => {
    expect(isValidChecksum(SAMPLE_CHECKSUM.toUpperCase())).toBe(false);
  });

  it("returns false for a string shorter than 64 chars", () => {
    expect(isValidChecksum(SAMPLE_CHECKSUM.slice(0, 63))).toBe(false);
  });

  it("returns false for a string longer than 64 chars", () => {
    expect(isValidChecksum(SAMPLE_CHECKSUM + "a")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isValidChecksum("")).toBe(false);
  });

  it("returns false for non-hex characters", () => {
    const notHex = "z".repeat(64);
    expect(isValidChecksum(notHex)).toBe(false);
  });
});

// ── recordMigration ──────────────────────────────────────────────────────────

describe("recordMigration", () => {
  it("inserts a row and returns the inserted record", async () => {
    mockDb.returning.mockResolvedValueOnce([mockRow]);

    const result = await recordMigration(SAMPLE_VERSION, SAMPLE_SQL, "ci");

    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({
        version: SAMPLE_VERSION,
        checksum: SAMPLE_CHECKSUM,
        appliedBy: "ci",
      }),
    );
    expect(result).toEqual(mockRow);
  });

  it("trims whitespace from the version string", async () => {
    mockDb.returning.mockResolvedValueOnce([mockRow]);

    await recordMigration("  0001_add_users  ", SAMPLE_SQL);

    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ version: SAMPLE_VERSION }),
    );
  });

  it("falls back to getSchemaVersion when onConflictDoNothing returns nothing", async () => {
    // Simulate an existing record: insert returns [], then select returns the existing row.
    mockDb.returning.mockResolvedValueOnce([]);
    mockDb.limit.mockResolvedValueOnce([mockRow]);

    const result = await recordMigration(SAMPLE_VERSION, SAMPLE_SQL);

    expect(result).toEqual(mockRow);
  });

  it("throws when the existing record cannot be found after conflict", async () => {
    mockDb.returning.mockResolvedValueOnce([]);
    mockDb.limit.mockResolvedValueOnce([]); // Row disappeared

    await expect(recordMigration(SAMPLE_VERSION, SAMPLE_SQL)).rejects.toThrow(
      `Failed to record or retrieve schema version '${SAMPLE_VERSION}'`,
    );
  });

  it("stores null as appliedBy when not provided", async () => {
    mockDb.returning.mockResolvedValueOnce([{ ...mockRow, appliedBy: null }]);

    await recordMigration(SAMPLE_VERSION, SAMPLE_SQL);

    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ appliedBy: null }),
    );
  });

  it("throws when version is an empty string", async () => {
    await expect(recordMigration("", SAMPLE_SQL)).rejects.toThrow(
      "version must be a non-empty string",
    );
  });

  it("throws when version is only whitespace", async () => {
    await expect(recordMigration("   ", SAMPLE_SQL)).rejects.toThrow(
      "version must be a non-empty string",
    );
  });
});

// ── getSchemaVersion ─────────────────────────────────────────────────────────

describe("getSchemaVersion", () => {
  it("returns the row when found", async () => {
    mockDb.limit.mockResolvedValueOnce([mockRow]);

    const result = await getSchemaVersion(SAMPLE_VERSION);

    expect(result).toEqual(mockRow);
    expect(mockDb.where).toHaveBeenCalled();
    expect(mockDb.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when not found", async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await getSchemaVersion("nonexistent");

    expect(result).toBeNull();
  });
});

// ── listSchemaVersions ────────────────────────────────────────────────────────

describe("listSchemaVersions", () => {
  it("returns all rows in order", async () => {
    const rows = [mockRow, { ...mockRow, version: "0002_add_markets" }];
    // listSchemaVersions does not call .limit() — the chain terminates at .orderBy()
    mockDb.orderBy.mockResolvedValueOnce(rows);

    const result = await listSchemaVersions();

    expect(result).toHaveLength(2);
    expect(result[0].version).toBe(SAMPLE_VERSION);
  });

  it("returns an empty array when no versions are recorded", async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    const result = await listSchemaVersions();

    expect(result).toEqual([]);
  });
});

// ── getLatestSchemaVersion ───────────────────────────────────────────────────

describe("getLatestSchemaVersion", () => {
  it("returns the most recent row", async () => {
    mockDb.limit.mockResolvedValueOnce([mockRow]);

    const result = await getLatestSchemaVersion();

    expect(result).toEqual(mockRow);
    expect(mockDb.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when no versions exist", async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await getLatestSchemaVersion();

    expect(result).toBeNull();
  });
});

// ── deleteSchemaVersion ──────────────────────────────────────────────────────

describe("deleteSchemaVersion", () => {
  it("returns true when a row is deleted", async () => {
    mockDb.returning.mockResolvedValueOnce([{ version: SAMPLE_VERSION }]);

    const result = await deleteSchemaVersion(SAMPLE_VERSION);

    expect(result).toBe(true);
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it("returns false when the row does not exist", async () => {
    mockDb.returning.mockResolvedValueOnce([]);

    const result = await deleteSchemaVersion("nonexistent");

    expect(result).toBe(false);
  });
});

// ── checkDrift ───────────────────────────────────────────────────────────────

describe("checkDrift", () => {
  it("returns ok: true when checksums match", async () => {
    mockDb.limit.mockResolvedValueOnce([mockRow]);

    const result = await checkDrift(SAMPLE_VERSION, SAMPLE_SQL);

    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(result!.storedChecksum).toBe(SAMPLE_CHECKSUM);
    expect(result!.currentChecksum).toBe(SAMPLE_CHECKSUM);
  });

  it("returns ok: false when the file content has changed", async () => {
    mockDb.limit.mockResolvedValueOnce([mockRow]);

    const modifiedSql = SAMPLE_SQL + "\n-- added a comment";
    const result = await checkDrift(SAMPLE_VERSION, modifiedSql);

    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.storedChecksum).toBe(SAMPLE_CHECKSUM);
    expect(result!.currentChecksum).toBe(computeChecksum(modifiedSql));
    expect(result!.storedChecksum).not.toBe(result!.currentChecksum);
  });

  it("returns null when the version has not been recorded", async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await checkDrift("not_recorded", SAMPLE_SQL);

    expect(result).toBeNull();
  });

  it("includes the version tag in the result", async () => {
    mockDb.limit.mockResolvedValueOnce([mockRow]);

    const result = await checkDrift(SAMPLE_VERSION, SAMPLE_SQL);

    expect(result!.version).toBe(SAMPLE_VERSION);
  });
});
