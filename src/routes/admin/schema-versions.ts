/**
 * Admin schema-versions router.
 *
 *   GET    /api/admin/schema-versions            — list all recorded migrations
 *   GET    /api/admin/schema-versions/latest     — most recently applied migration
 *   GET    /api/admin/schema-versions/:version   — single migration record
 *   POST   /api/admin/schema-versions            — record a migration as applied
 *   POST   /api/admin/schema-versions/:version/drift-check
 *                                                — compare stored vs current checksum
 *   DELETE /api/admin/schema-versions/:version   — remove a recorded migration
 *
 * All routes require a valid admin JWT (role: "admin").
 * Input is validated at the boundary with zod.
 * Failures return the standard error envelope:
 *   { error: { code, message, requestId } }
 */

import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../../middleware/requireAdmin";
import { getRequestId } from "../../lib/requestContext";
import { logger } from "../../config/logger";
import {
  recordMigration,
  getSchemaVersion,
  listSchemaVersions,
  getLatestSchemaVersion,
  deleteSchemaVersion,
  checkDrift,
} from "../../repositories/schemaVersionRepo";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

/**
 * Migration version tag: alphanumeric characters plus underscores and hyphens.
 * Matches the naming convention used by Drizzle Kit (e.g. "0001_add_users").
 */
const versionParamSchema = z
  .string()
  .min(1, "version must not be empty")
  .max(128, "version must be at most 128 characters")
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "version must be alphanumeric with underscores or hyphens",
  );

const recordBodySchema = z
  .object({
    /** Migration tag — the file name without the .sql extension. */
    version: versionParamSchema,
    /**
     * Raw SQL content of the migration file.  The route computes the
     * SHA-256 checksum server-side so callers never need to hash it
     * themselves.
     */
    sqlContent: z.string().min(1, "sqlContent must not be empty"),
    /** Optional identity of the agent applying the migration (CI job, user, etc.). */
    appliedBy: z.string().max(255).optional(),
  })
  .strict();

const driftCheckBodySchema = z
  .object({
    /** Current SQL content to compare against the stored checksum. */
    sqlContent: z.string().min(1, "sqlContent must not be empty"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Res = import("express").Response;

function validationError(res: Res, message: string): void {
  res.status(400).json({
    error: { code: "validation_error", message, requestId: getRequestId() },
  });
}

function notFound(res: Res, version: string): void {
  res.status(404).json({
    error: {
      code: "not_found",
      message: `Schema version '${version}' not found`,
      requestId: getRequestId(),
    },
  });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAdminSchemaVersionsRouter(): Router {
  const router = Router();

  router.use(requireAdmin);

  // ── GET /api/admin/schema-versions ────────────────────────────────────────
  /**
   * List all recorded schema_version rows, oldest-first.
   *
   * Response: { data: SchemaVersion[] }
   */
  router.get("/", async (_req, res, next) => {
    try {
      const versions = await listSchemaVersions();
      res.json({ data: versions });
    } catch (e) {
      next(e);
    }
  });

  // ── GET /api/admin/schema-versions/latest ─────────────────────────────────
  /**
   * Return the most recently applied migration, or 404 when no migrations have
   * been recorded yet.
   *
   * Response: { data: SchemaVersion }
   */
  router.get("/latest", async (_req, res, next) => {
    try {
      const latest = await getLatestSchemaVersion();
      if (!latest) {
        return res.status(404).json({
          error: {
            code: "not_found",
            message: "No schema versions have been recorded yet",
            requestId: getRequestId(),
          },
        });
      }
      return res.json({ data: latest });
    } catch (e) {
      return next(e);
    }
  });

  // ── GET /api/admin/schema-versions/:version ───────────────────────────────
  /**
   * Fetch a single schema_version row by migration tag.
   *
   * Response: { data: SchemaVersion }
   */
  router.get("/:version", async (req, res, next) => {
    const parsed = versionParamSchema.safeParse(req.params.version);
    if (!parsed.success) {
      return validationError(res, parsed.error.issues[0]?.message ?? "invalid version");
    }
    try {
      const row = await getSchemaVersion(parsed.data);
      if (!row) {
        return notFound(res, parsed.data);
      }
      return res.json({ data: row });
    } catch (e) {
      return next(e);
    }
  });

  // ── POST /api/admin/schema-versions ──────────────────────────────────────
  /**
   * Record a migration as applied.  The server computes the SHA-256 checksum
   * from `sqlContent`; clients do not need to hash it themselves.
   *
   * If the version was already recorded the call is idempotent and returns the
   * existing row with HTTP 200 (rather than 201).
   *
   * Request body: { version, sqlContent, appliedBy? }
   * Response:     { data: SchemaVersion }
   */
  router.post("/", async (req, res, next) => {
    const parsed = recordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return validationError(res, parsed.error.issues[0]?.message ?? "invalid body");
    }

    const { version, sqlContent, appliedBy } = parsed.data;

    try {
      const existing = await getSchemaVersion(version);
      const row = await recordMigration(version, sqlContent, appliedBy);

      logger.info(
        {
          reqId: getRequestId(),
          version,
          checksum: row.checksum,
          actor: req.adminAddress,
        },
        "schema_version_recorded",
      );

      // 201 when newly created, 200 when already existed (idempotent).
      const status = existing ? 200 : 201;
      return res.status(status).json({ data: row });
    } catch (e) {
      return next(e);
    }
  });

  // ── POST /api/admin/schema-versions/:version/drift-check ─────────────────
  /**
   * Compare the stored checksum for a migration against the current SQL content
   * provided in the request body.
   *
   * Response:
   *   { data: { version, storedChecksum, currentChecksum, ok } }
   *     ok = true  → migration file is unchanged since it was applied.
   *     ok = false → migration file has been modified (drift detected).
   */
  router.post("/:version/drift-check", async (req, res, next) => {
    const parsed = versionParamSchema.safeParse(req.params.version);
    if (!parsed.success) {
      return validationError(res, parsed.error.issues[0]?.message ?? "invalid version");
    }

    const bodyParsed = driftCheckBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return validationError(
        res,
        bodyParsed.error.issues[0]?.message ?? "invalid body",
      );
    }

    try {
      const result = await checkDrift(parsed.data, bodyParsed.data.sqlContent);
      if (!result) {
        return notFound(res, parsed.data);
      }

      if (!result.ok) {
        logger.warn(
          {
            reqId: getRequestId(),
            version: parsed.data,
            storedChecksum: result.storedChecksum,
            currentChecksum: result.currentChecksum,
            actor: req.adminAddress,
          },
          "schema_version_drift_detected",
        );
      }

      return res.json({ data: result });
    } catch (e) {
      return next(e);
    }
  });

  // ── DELETE /api/admin/schema-versions/:version ────────────────────────────
  /**
   * Remove a recorded schema_version row.
   *
   * Use with caution: this does not roll back the migration itself — it only
   * removes the tracking record.
   *
   * Response: 204 No Content
   */
  router.delete("/:version", async (req, res, next) => {
    const parsed = versionParamSchema.safeParse(req.params.version);
    if (!parsed.success) {
      return validationError(res, parsed.error.issues[0]?.message ?? "invalid version");
    }

    try {
      const deleted = await deleteSchemaVersion(parsed.data);
      if (!deleted) {
        return notFound(res, parsed.data);
      }

      logger.info(
        {
          reqId: getRequestId(),
          version: parsed.data,
          actor: req.adminAddress,
        },
        "schema_version_deleted",
      );

      return res.status(204).send();
    } catch (e) {
      return next(e);
    }
  });

  return router;
}

export const adminSchemaVersionsRouter = createAdminSchemaVersionsRouter();
