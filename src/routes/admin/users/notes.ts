/**
 * Admin user-notes router.
 *
 * Endpoints
 * ─────────
 * GET    /api/admin/users/:addr/notes        List all notes for a user (newest-first).
 * POST   /api/admin/users/:addr/notes        Create a new note for a user.
 * DELETE /api/admin/users/:addr/notes/:id    Delete a specific note by ID.
 *
 * Auth
 * ────
 * All routes require a valid admin JWT (role: "admin") in the Authorization
 * header, enforced by the shared `requireAdmin` middleware.
 *
 * Rate limiting
 * ─────────────
 * 60 requests / minute per admin token by default.  The ceiling is injectable
 * via `createAdminNotesRouter({ rateLimitPerMinute })` so tests can exercise
 * the 429 path cheaply without firing 60 real requests.
 *
 * Audit trail
 * ───────────
 * Every mutating operation (POST, DELETE) writes a row to `admin_audit_log`
 * so all note changes are traceable to a specific admin.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { requireAdmin } from "../../../middleware/requireAdmin";
import { getRequestId } from "../../../lib/requestContext";
import { logger } from "../../../config/logger";
import { db } from "../../../db/client";
import { adminUserNotes, adminAuditLog } from "../../../db/schema";
import type { DB } from "../../../db/client";

// ── Validation schemas ────────────────────────────────────────────────────────

/**
 * Stellar public key: starts with "G" followed by exactly 55 uppercase base32
 * characters.  Validated at the route boundary before anything touches the DB.
 */
const stellarAddressSchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

/**
 * Request body for POST (create note).
 * `note` is trimmed and capped at 2 000 characters.
 */
const createNoteBodySchema = z
  .object({
    note: z
      .string()
      .trim()
      .min(1, "note must not be empty")
      .max(2_000, "note must be at most 2000 characters"),
  })
  .strict();

/** UUID v4 pattern — used to validate the `:id` segment on DELETE. */
const uuidSchema = z.string().uuid("Invalid note ID");

// ── Router options ────────────────────────────────────────────────────────────

export interface AdminNotesRouterOptions {
  /** Override the DB instance (used in tests). Defaults to the real `db`. */
  dbClient?: DB;
  /** Requests per minute per admin token. Default: 60 */
  rateLimitPerMinute?: number;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createAdminNotesRouter(opts: AdminNotesRouterOptions = {}): Router {
  const client = opts.dbClient ?? db;
  const router = Router({ mergeParams: true });
  const limit = opts.rateLimitPerMinute ?? 60;

  // ── Rate limiter ────────────────────────────────────────────────────────────
  // Key on the raw Authorization header so each distinct admin token gets its
  // own bucket.  Falls back to IP for unauthenticated callers so they are
  // still throttled before reaching requireAdmin.
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit,
      keyGenerator: (req) =>
        (req.headers.authorization as string | undefined) ?? req.ip ?? "unknown",
      standardHeaders: "draft-6",
      legacyHeaders: false,
      message: { error: { code: "rate_limit_exceeded" } },
    }),
  );

  // ── Admin guard ─────────────────────────────────────────────────────────────
  router.use(requireAdmin);

  // ── GET /:addr/notes ────────────────────────────────────────────────────────
  /**
   * List all notes for a user, ordered newest-first.
   *
   * 200 { data: AdminUserNote[] }
   * 400 { error: { code: "validation_error", message: string, requestId: string } }
   */
  router.get("/:addr/notes", async (req, res, next) => {
    try {
      const reqId = getRequestId() ?? (req as { id?: string }).id ?? "unknown";

      const addrParsed = stellarAddressSchema.safeParse(req.params.addr);
      if (!addrParsed.success) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message: addrParsed.error.issues[0]?.message ?? "Invalid Stellar address",
            requestId: reqId,
          },
        });
        return;
      }

      const targetAddress = addrParsed.data;

      const notes = await client
        .select({
          id: adminUserNotes.id,
          targetAddress: adminUserNotes.targetAddress,
          adminAddress: adminUserNotes.adminAddress,
          note: adminUserNotes.note,
          createdAt: adminUserNotes.createdAt,
        })
        .from(adminUserNotes)
        .where(eq(adminUserNotes.targetAddress, targetAddress))
        .orderBy(desc(adminUserNotes.createdAt));

      logger.info(
        { reqId, targetAddress, actor: req.adminAddress, count: notes.length },
        "admin_user_notes_listed",
      );

      res.status(200).json({
        data: notes.map((n) => ({
          id: n.id,
          targetAddress: n.targetAddress,
          adminAddress: n.adminAddress,
          note: n.note,
          createdAt: n.createdAt.toISOString(),
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /:addr/notes ───────────────────────────────────────────────────────
  /**
   * Create a new note for the specified user.
   *
   * Body: { "note": "<string, 1–2000 chars>" }
   *
   * 201 { data: AdminUserNote }
   * 400 { error: { code: "validation_error", message: string, requestId: string } }
   */
  router.post("/:addr/notes", async (req, res, next) => {
    try {
      const reqId = getRequestId() ?? (req as { id?: string }).id ?? "unknown";

      const addrParsed = stellarAddressSchema.safeParse(req.params.addr);
      if (!addrParsed.success) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message: addrParsed.error.issues[0]?.message ?? "Invalid Stellar address",
            requestId: reqId,
          },
        });
        return;
      }

      const bodyParsed = createNoteBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message: bodyParsed.error.issues[0]?.message ?? "Invalid request body",
            requestId: reqId,
          },
        });
        return;
      }

      const targetAddress = addrParsed.data;
      const adminAddress = req.adminAddress!;
      const { note } = bodyParsed.data;

      // Insert the note and return the created row in one round-trip.
      const [created] = await client
        .insert(adminUserNotes)
        .values({ targetAddress, adminAddress, note })
        .returning();

      // Write the admin audit log entry for full traceability.
      await client.insert(adminAuditLog).values({
        adminAddress,
        action: "create_user_note",
        targetAddress,
      });

      logger.info(
        { reqId, noteId: created.id, targetAddress, actor: adminAddress },
        "admin_user_note_created",
      );

      res.status(201).json({
        data: {
          id: created.id,
          targetAddress: created.targetAddress,
          adminAddress: created.adminAddress,
          note: created.note,
          createdAt: created.createdAt.toISOString(),
        },
      });
    } catch (e) {
      next(e);
    }
  });

  // ── DELETE /:addr/notes/:id ─────────────────────────────────────────────────
  /**
   * Delete a specific note by ID.  The delete is scoped to both the note UUID
   * and the target address so an admin cannot remove notes that belong to a
   * different user by guessing IDs.
   *
   * 200 { data: { deleted: true } }
   * 400 { error: { code: "validation_error", message: string, requestId: string } }
   * 404 { error: { code: "not_found", requestId: string } }
   */
  router.delete("/:addr/notes/:id", async (req, res, next) => {
    try {
      const reqId = getRequestId() ?? (req as { id?: string }).id ?? "unknown";

      const addrParsed = stellarAddressSchema.safeParse(req.params.addr);
      if (!addrParsed.success) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message: addrParsed.error.issues[0]?.message ?? "Invalid Stellar address",
            requestId: reqId,
          },
        });
        return;
      }

      const idParsed = uuidSchema.safeParse(req.params.id);
      if (!idParsed.success) {
        res.status(400).json({
          error: {
            code: "validation_error",
            message: idParsed.error.issues[0]?.message ?? "Invalid note ID",
            requestId: reqId,
          },
        });
        return;
      }

      const targetAddress = addrParsed.data;
      const adminAddress = req.adminAddress!;
      const noteId = idParsed.data;

      // Scope the deletion to both the note ID and the target address.
      const deleted = await client
        .delete(adminUserNotes)
        .where(
          and(
            eq(adminUserNotes.id, noteId),
            eq(adminUserNotes.targetAddress, targetAddress),
          ),
        )
        .returning({ id: adminUserNotes.id });

      if (deleted.length === 0) {
        res.status(404).json({ error: { code: "not_found", requestId: reqId } });
        return;
      }

      // Write admin audit log entry for traceability.
      await client.insert(adminAuditLog).values({
        adminAddress,
        action: "delete_user_note",
        targetAddress,
      });

      logger.info(
        { reqId, noteId, targetAddress, actor: adminAddress },
        "admin_user_note_deleted",
      );

      res.status(200).json({ data: { deleted: true } });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// Default export wired into src/index.ts.
export const adminNotesRouter = createAdminNotesRouter();
