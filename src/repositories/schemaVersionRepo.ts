/**
 * schemaVersionRepo — CRUD + drift-detection for the schema_versions table.
 *
 * Responsibilities:
 *   - Record a migration as applied (with its SHA-256 checksum).
 *   - Look up a single version row.
 *   - List all recorded versions in chronological order.
 *   - Verify the on-disk checksum of a migration SQL file against the stored
 *     value and report any drift.
 *
 * Checksum algorithm: SHA-256 of the raw file/string content, hex-encoded,
 * lower-case.  This is the same algorithm used in most migration tooling and
 * produces a stable 64-character string.
 */

import { createHash } from "crypto";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { schemaVersions, type SchemaVersion, type NewSchemaVersion } from "../db/schema";

// ---------------------------------------------------------------------------
// Checksum helpers
// ---------------------------------------------------------------------------

/**
 * Compute the hex-encoded SHA-256 of arbitrary string content.
 * The result is always 64 lower-case hexadecimal characters.
 */
export function computeChecksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Validate that a string looks like a SHA-256 hex digest.
 * Accepts exactly 64 lower-case hex characters.
 */
export function isValidChecksum(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

// ---------------------------------------------------------------------------
// Repository operations
// ---------------------------------------------------------------------------

/**
 * Record a migration as applied.
 *
 * Computes the SHA-256 checksum of `sqlContent` (the raw SQL string) and
 * inserts a row into `schema_versions`.  If a row with the same `version`
 * already exists the call is a no-op (ON CONFLICT DO NOTHING), making
 * repeated calls idempotent.
 *
 * @param version   Migration tag, e.g. "0001_add_users".
 * @param sqlContent Raw SQL content of the migration file.
 * @param appliedBy Optional identity of the agent running the migration.
 * @returns The newly inserted (or existing) schema_version row.
 */
export async function recordMigration(
  version: string,
  sqlContent: string,
  appliedBy?: string,
): Promise<SchemaVersion> {
  if (!version || version.trim() === "") {
    throw new Error("version must be a non-empty string");
  }

  const checksum = computeChecksum(sqlContent);

  const [inserted] = await db
    .insert(schemaVersions)
    .values({
      version: version.trim(),
      checksum,
      appliedBy: appliedBy ?? null,
    } satisfies NewSchemaVersion)
    .onConflictDoNothing()
    .returning();

  // If the row already existed onConflictDoNothing returns nothing — fetch it.
  if (!inserted) {
    const existing = await getSchemaVersion(version.trim());
    if (!existing) {
      // Should never happen unless a concurrent DELETE raced us.
      throw new Error(`Failed to record or retrieve schema version '${version}'`);
    }
    return existing;
  }

  return inserted;
}

/**
 * Retrieve a single schema_version row by migration tag.
 * Returns `null` when the version has not been recorded.
 */
export async function getSchemaVersion(version: string): Promise<SchemaVersion | null> {
  const rows = await db
    .select()
    .from(schemaVersions)
    .where(eq(schemaVersions.version, version))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Return all recorded schema_version rows sorted oldest-first (by appliedAt).
 * Useful for auditing the full migration history in order.
 */
export async function listSchemaVersions(): Promise<SchemaVersion[]> {
  return db
    .select()
    .from(schemaVersions)
    .orderBy(asc(schemaVersions.appliedAt), asc(schemaVersions.version));
}

/**
 * Return the most recently applied schema_version row, or `null` if the table
 * is empty.
 */
export async function getLatestSchemaVersion(): Promise<SchemaVersion | null> {
  const rows = await db
    .select()
    .from(schemaVersions)
    .orderBy(desc(schemaVersions.appliedAt), desc(schemaVersions.version))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Delete a schema_version row (for rollback scenarios or test cleanup).
 * Returns `true` if a row was deleted, `false` if the version was not found.
 */
export async function deleteSchemaVersion(version: string): Promise<boolean> {
  const deleted = await db
    .delete(schemaVersions)
    .where(eq(schemaVersions.version, version))
    .returning({ version: schemaVersions.version });

  return deleted.length > 0;
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

export interface DriftCheckResult {
  version: string;
  /** Checksum stored in the database when the migration was applied. */
  storedChecksum: string;
  /** Checksum computed from the current file content at call time. */
  currentChecksum: string;
  /** `true` when stored and current checksums match — migration is clean. */
  ok: boolean;
}

/**
 * Compare the stored checksum for a migration against the current content of
 * its SQL file (provided as a string).
 *
 * @param version      Migration tag.
 * @param sqlContent   Current content of the migration SQL file.
 * @returns            A `DriftCheckResult`, or `null` if the version was never recorded.
 */
export async function checkDrift(
  version: string,
  sqlContent: string,
): Promise<DriftCheckResult | null> {
  const row = await getSchemaVersion(version);
  if (!row) {
    return null;
  }

  const currentChecksum = computeChecksum(sqlContent);

  return {
    version,
    storedChecksum: row.checksum,
    currentChecksum,
    ok: row.checksum === currentChecksum,
  };
}
