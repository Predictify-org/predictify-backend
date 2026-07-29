/**
 * /api/exports/predictions
 *
 * Streams a user's prediction history as CSV or JSON.
 *
 * Supported methods:
 *   GET    /api/exports/predictions
 *   POST   /api/exports/predictions   (body-based params; idempotency-safe)
 *   PATCH  /api/exports/predictions   (partial param update; idempotency-safe)
 *
 * POST and PATCH accept the same parameters as GET (format, startDate, endDate)
 * via the request body. They exist so callers can attach an Idempotency-Key
 * header and safely retry an export request without triggering a duplicate
 * stream — matching the Stripe-style safe-retries contract:
 *
 *   POST /api/exports/predictions
 *   Idempotency-Key: <uuid>
 *   Content-Type: application/json
 *   { "format": "csv", "startDate": "2026-01-01T00:00:00Z" }
 *
 * Idempotency:
 *   This route uses a streaming (chunked Transfer-Encoding) response, so the
 *   global `idempotency` middleware (which intercepts `res.json`) cannot
 *   capture and replay the response. Instead it uses the helpers exported from
 *   `src/middleware/idempotency.ts`:
 *
 *     checkExportsIdempotency  — lookup / validate key before streaming
 *     persistExportsIdempotency — store the completed buffer after res.end()
 *
 *   The fingerprint is derived from the user ID + request parameters (not the
 *   raw body), making it stable across equivalent retries regardless of body
 *   whitespace or key ordering.
 *
 *   Behaviour:
 *     - No key  → pass through (idempotency is optional).
 *     - Invalid key  → 400 request_failed.
 *     - Key hit, same fingerprint → 200 replay from store, Idempotent-Replayed: true.
 *     - Key hit, diff fingerprint → 409 conflict.
 *     - Key miss → stream, then persist buffer.
 *
 * Auth: Bearer JWT (requireAuth).
 */

import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { logger } from "../../config/logger";
import { getRequestId } from "../../lib/requestContext";
import { AuthenticatedRequest } from "../../middleware/auth";
import {
  getPredictionsStream,
  formatPredictionAsCsv,
} from "../../services/exportService";
import {
  checkExportsIdempotency,
  persistExportsIdempotency,
} from "../../middleware/idempotency";

export const exportsPredictionsRouter = Router();

exportsPredictionsRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const exportQuerySchema = z
  .object({
    format: z.enum(["csv", "json"], {
      errorMap: () => ({ message: "Format must be either csv or json" }),
    }),
    startDate: z
      .string()
      .optional()
      .refine((val) => {
        if (!val) return true;
        return !isNaN(Date.parse(val));
      }, "Invalid startDate")
      .transform((val) => (val ? new Date(val) : undefined)),
    endDate: z
      .string()
      .optional()
      .refine((val) => {
        if (!val) return true;
        return !isNaN(Date.parse(val));
      }, "Invalid endDate")
      .transform((val) => (val ? new Date(val) : undefined)),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return data.startDate <= data.endDate;
      }
      return true;
    },
    {
      message: "startDate must be before or equal to endDate",
      path: ["startDate"],
    },
  );

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Core export handler shared by GET, POST, and PATCH.
 *
 * Parameters are accepted from both query-string (GET) and body (POST/PATCH).
 * Body params take precedence so POST/PATCH callers can include them as JSON.
 */
async function handleExport(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const reqId =
    getRequestId() ??
    (typeof (req as { id?: unknown }).id === "string"
      ? (req as { id?: string }).id
      : undefined) ??
    crypto.randomUUID();

  const userId = (req as AuthenticatedRequest).user!.id;

  try {
    // Parse and validate request parameters (query-string for GET; body for POST/PATCH).
    const queryData = {
      format: req.body?.format ?? req.query.format,
      startDate: req.body?.startDate ?? req.query.startDate,
      endDate: req.body?.endDate ?? req.query.endDate,
    };
    const parsed = exportQuerySchema.parse(queryData);

    const format = parsed.format;
    const filters = {
      startDate: parsed.startDate,
      endDate: parsed.endDate,
    };

    // ---------------------------------------------------------------------------
    // Idempotency check (streaming-aware)
    //
    // The fingerprint is derived from the logical operation identity — user,
    // format, and date range — rather than the raw body bytes.  This ensures
    // that a retry with the same semantics (but different JSON whitespace, for
    // example) maps to the same record.
    // ---------------------------------------------------------------------------
    const fingerprintSource = JSON.stringify({
      userId,
      format,
      startDate: filters.startDate?.toISOString(),
      endDate: filters.endDate?.toISOString(),
    });

    const idempResult = await checkExportsIdempotency(
      req,
      res,
      fingerprintSource,
      reqId,
    );

    // Cache hit — response already written, nothing left to do.
    if (idempResult.hit === true) return;

    // Destructure for later use (null when no Idempotency-Key header).
    const idempKey = idempResult.key;
    const idempFingerprint = idempResult.fingerprint;

    // ---------------------------------------------------------------------------
    // Stream the export
    // ---------------------------------------------------------------------------
    const contentType = format === "csv" ? "text/csv" : "application/json";
    const filename = `predictions-${userId}-${Date.now()}.${format}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Transfer-Encoding", "chunked");
    res.status(200);

    const stream = getPredictionsStream(userId, filters, reqId);

    /**
     * Buffer accumulates the full response only when we need to persist it for
     * idempotency replay.  When there is no Idempotency-Key header we skip
     * buffering entirely to keep memory usage O(batch) instead of O(total).
     */
    let buffer = "";
    const shouldBuffer = idempKey !== null;

    if (format === "csv") {
      const header = "id,marketId,userId,outcome,amount,txHash,status,result,createdAt\n";
      if (shouldBuffer) buffer += header;
      res.write(header);

      for await (const row of stream) {
        const line = formatPredictionAsCsv(row);
        if (shouldBuffer) buffer += line;
        res.write(line);
      }
    } else {
      // JSON array — opening bracket
      const start = "[\n";
      if (shouldBuffer) buffer += start;
      res.write(start);

      let isFirst = true;
      for await (const row of stream) {
        const itemStr =
          (isFirst ? "  " : ",\n  ") +
          JSON.stringify({
            id: row.id,
            marketId: row.marketId,
            userId: row.userId,
            outcome: row.outcome,
            amount: row.amount,
            txHash: row.txHash,
            status: row.status,
            result: row.result,
            createdAt:
              row.createdAt instanceof Date
                ? row.createdAt.toISOString()
                : row.createdAt,
          });
        isFirst = false;
        if (shouldBuffer) buffer += itemStr;
        res.write(itemStr);
      }

      const end = "\n]\n";
      if (shouldBuffer) buffer += end;
      res.write(end);
    }

    res.end();

    // ---------------------------------------------------------------------------
    // Persist buffer for idempotency replay (fire-and-forget after res.end).
    // ---------------------------------------------------------------------------
    if (idempKey !== null && idempFingerprint !== null) {
      logger.debug({ reqId, key: idempKey }, "idempotency_persist_exports");
      await persistExportsIdempotency(
        idempKey,
        idempFingerprint,
        buffer,
        200,
        {
          "content-type": contentType,
          "content-disposition": `attachment; filename="${filename}"`,
        },
        reqId,
      );
    }
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Route registrations
//
// GET    — query-string parameters, idempotency-key supported
// POST   — body parameters, idempotency-key supported (primary safe-retry path)
// PATCH  — partial update parameters, idempotency-key supported
// ---------------------------------------------------------------------------

exportsPredictionsRouter.get("/", handleExport);
exportsPredictionsRouter.post("/", handleExport);

/**
 * PATCH /api/exports/predictions
 *
 * Semantically equivalent to POST for export generation.  Provided so callers
 * can use PATCH with an Idempotency-Key to update export parameters and safely
 * retry if the network drops before they receive a response.
 *
 * Accepts the same body schema as POST: { format, startDate?, endDate? }.
 */
exportsPredictionsRouter.patch("/", handleExport);
