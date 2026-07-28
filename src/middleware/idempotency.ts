/**
 * Idempotency-Key middleware
 *
 * Provides two exports:
 *
 *   `idempotency` — Express middleware for standard (non-streaming) POST/PATCH
 *   routes. Intercepts `res.json` to capture and persist the response body.
 *   Applied globally to all /api POST/PATCH requests in index.ts.
 *
 *   `checkExportsIdempotency` — Helper used by the /api/exports/predictions
 *   route to perform idempotency checks for streaming (chunked) responses.
 *   Because streaming routes write directly to `res` without going through
 *   `res.json`, the global middleware cannot intercept them; the route handles
 *   persistence itself after the stream completes.
 *
 * Flow (both variants):
 *  1. No Idempotency-Key header → pass through (key is optional).
 *  2. Key present but invalid format (>255 chars or non-printable ASCII)
 *     → 400 request_failed with code "invalid_idempotency_key".
 *  3. Key valid, compute sha256 fingerprint of the request body (global) or
 *     the request parameters (streaming helper).
 *  4. Look up the key in `idempotency_records` (only non-expired rows).
 *     - HIT  + matching fingerprint  → replay stored response (short-circuit).
 *       Adds `Idempotent-Replayed: true` header.
 *     - HIT  + different fingerprint → 409 conflict.
 *     - MISS → execute the route handler; persist the response afterwards.
 *
 * Security notes:
 *  - Keys are capped at 255 printable-ASCII characters (\x20-\x7E).
 *  - Only 2xx responses are persisted; errors are never cached.
 *  - TTL is 24 hours; expired rows are swept by the cleanup worker.
 *  - Fingerprints are SHA-256 hashes — collisions are computationally
 *    infeasible and the stored hash is never returned to callers.
 */

import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { idempotencyRecords } from "../db/schema";
import { logger } from "../config/logger";
import { getRequestId } from "../lib/requestContext";
import { RouteErrorFactory } from "../errors";

/** 24-hour TTL for stored idempotency records. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Subset of response headers that is safe and useful to replay. */
const REPLAY_HEADERS = ["content-type", "location", "x-request-id", "content-disposition"];

/**
 * Computes a SHA-256 hex digest of the given string.
 * Used to derive both the key-validation guard (indirectly) and the body
 * fingerprint.
 */
export function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Validates an Idempotency-Key value.
 *
 * Rules:
 *  - Must be a string (not an array header).
 *  - 1–255 printable ASCII characters (\x20-\x7E inclusive).
 *
 * @returns `true` if valid, `false` otherwise.
 */
export function isValidIdempotencyKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length >= 1 &&
    key.length <= 255 &&
    /^[\x20-\x7E]+$/.test(key)
  );
}

// ---------------------------------------------------------------------------
// Global middleware — for non-streaming POST/PATCH routes
// ---------------------------------------------------------------------------

/**
 * Express middleware that provides idempotent semantics for POST and PATCH
 * requests on /api routes that return JSON via `res.json`.
 *
 * Must be registered *before* route handlers:
 *
 *   app.use("/api", (req, res, next) =>
 *     ["POST", "PATCH"].includes(req.method) ? idempotency(req, res, next) : next()
 *   );
 *
 * The middleware intercepts `res.json` on a cache miss so it can persist the
 * response body without the route handler needing any changes.
 *
 * Streaming routes (e.g. /api/exports/predictions) bypass this middleware and
 * use `checkExportsIdempotency` instead.
 */
export async function idempotency(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const key = req.headers["idempotency-key"];
  // No key — the header is optional; pass through.
  if (!key) return next();

  const reqId = getRequestId() ?? crypto.randomUUID();

  // Validate key format before any DB access.
  if (!isValidIdempotencyKey(key)) {
    logger.warn({ reqId, key: typeof key === "string" ? key.slice(0, 64) : "[non-string]" }, "invalid_idempotency_key");
    res.status(400).json({
      error: {
        code: "invalid_idempotency_key",
        message: "Idempotency-Key must be 1–255 printable ASCII characters",
        correlationId: reqId,
      },
    });
    return;
  }

  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? "");
  const fingerprint = sha256(body);
  const now = new Date();

  // --- Lookup ---
  const [existing] = await db
    .select()
    .from(idempotencyRecords)
    .where(and(eq(idempotencyRecords.key, key), gt(idempotencyRecords.expiresAt, now)))
    .limit(1);

  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      logger.warn({ reqId, key }, "idempotency_conflict");
      const routeErr = RouteErrorFactory.conflict("Idempotency key reused with a different request body");
      res.status(409).json({
        error: {
          code: "conflict",
          message: routeErr.message,
          correlationId: reqId,
        },
      });
      return;
    }

    // Cache hit — replay stored response without calling the route handler.
    logger.info({ reqId, key }, "idempotency_replay");
    const headers = (existing.responseHeaders ?? {}) as Record<string, string>;
    for (const h of REPLAY_HEADERS) {
      if (headers[h]) res.setHeader(h, headers[h]);
    }
    res.setHeader("Idempotent-Replayed", "true");
    res.status(existing.responseStatus).json(existing.responseBody);
    return;
  }

  // --- Miss: wrap res.json to persist the response before flushing ---
  const originalJson = res.json.bind(res);

  res.json = function (responseBody: unknown) {
    const status = res.statusCode;
    const headers: Record<string, string> = {};
    for (const h of REPLAY_HEADERS) {
      const v = res.getHeader(h);
      if (v) headers[h] = String(v);
    }

    // Only cache successful mutations; client / server errors are not stored.
    if (status >= 200 && status < 300) {
      const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
      db.insert(idempotencyRecords)
        .values({
          key,
          fingerprint,
          responseStatus: status,
          responseBody,
          responseHeaders: headers,
          expiresAt,
        })
        .catch((err) =>
          logger.error({ err, reqId, key }, "idempotency_persist_failed"),
        );
    }

    return originalJson(responseBody);
  };

  next();
}

// ---------------------------------------------------------------------------
// Streaming helper — for export routes that stream chunked responses
// ---------------------------------------------------------------------------

/**
 * Result returned by `checkExportsIdempotency` on a cache miss.
 * The route handler should call `persistExportsIdempotency` after the stream
 * completes successfully.
 */
export interface IdempotencyMissResult {
  hit: false;
  key: string;
  fingerprint: string;
}

/**
 * Result returned by `checkExportsIdempotency` when the key is absent.
 * The route handler should skip idempotency logic entirely.
 */
export interface IdempotencySkipResult {
  hit: false;
  key: null;
  fingerprint: null;
}

/**
 * Checks the idempotency store for streaming (export) routes.
 *
 * Streaming routes cannot use the global `idempotency` middleware because
 * that middleware intercepts `res.json`, which is never called for chunked
 * responses. Instead, routes call this helper *before* starting the stream.
 *
 * On a cache *hit*, this function writes the replay response directly to `res`
 * and returns `{ hit: true }`. The route handler must return immediately.
 *
 * On a cache *miss*, it returns metadata the route needs to persist the
 * response after streaming completes. The fingerprint is computed from the
 * caller-supplied `fingerprintSource` string (typically a stable serialisation
 * of the request parameters, e.g. `userId + format + date range`).
 *
 * @param req               - Express request
 * @param res               - Express response
 * @param fingerprintSource - Stable string that uniquely identifies the
 *                           logical operation. Use the same deterministic
 *                           serialisation every time.
 * @param reqId             - Correlation ID for structured log entries.
 *
 * @returns
 *   `{ hit: true }` if the response was replayed (caller must return).
 *   `{ hit: false, key: string, fingerprint: string }` on a miss (persist after streaming).
 *   `{ hit: false, key: null, fingerprint: null }` when no key header is present.
 *   Throws (via next()) a RouteError on format violations or fingerprint conflicts.
 */
export async function checkExportsIdempotency(
  req: Request,
  res: Response,
  fingerprintSource: string,
  reqId: string,
): Promise<
  | { hit: true }
  | IdempotencyMissResult
  | IdempotencySkipResult
  | { hit: "error" }
> {
  const rawKey = req.headers["idempotency-key"];

  // No key — idempotency is optional.
  if (rawKey === undefined) {
    return { hit: false, key: null, fingerprint: null };
  }

  // Validate key format.
  if (!isValidIdempotencyKey(rawKey)) {
    logger.warn(
      { reqId, key: typeof rawKey === "string" ? rawKey.slice(0, 64) : "[non-string]" },
      "invalid_idempotency_key_exports",
    );
    const err = RouteErrorFactory.badRequest(
      "Idempotency-Key must be 1–255 printable ASCII characters",
      "invalid_idempotency_key",
    );
    // Surface as a standard error envelope so the caller's next(err) path works.
    throw err;
  }

  const fingerprint = sha256(fingerprintSource);
  const now = new Date();

  const [existing] = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.key, rawKey),
        gt(idempotencyRecords.expiresAt, now),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      logger.warn({ reqId, key: rawKey }, "idempotency_conflict_exports");
      throw RouteErrorFactory.conflict("Idempotency key reused with different request parameters");
    }

    // Cache hit — replay the buffered streaming response.
    logger.info({ reqId, key: rawKey }, "idempotency_replay_exports");
    res.setHeader("Idempotent-Replayed", "true");
    const headers = (existing.responseHeaders ?? {}) as Record<string, string>;
    for (const [hk, hv] of Object.entries(headers)) {
      if (REPLAY_HEADERS.includes(hk)) res.setHeader(hk, hv);
    }
    res.status(existing.responseStatus);
    const bodyObj = existing.responseBody as { content: string };
    res.write(bodyObj.content);
    res.end();
    return { hit: true };
  }

  // Cache miss — return key and fingerprint for later persistence.
  return { hit: false, key: rawKey, fingerprint };
}

/**
 * Persists a completed streaming export response to the idempotency store.
 *
 * Call this after `res.end()` has been called and the stream completed
 * successfully. If persistence fails, the error is logged but not surfaced
 * to the client (the response has already been sent).
 *
 * @param key           - The validated Idempotency-Key value.
 * @param fingerprint   - The SHA-256 fingerprint from `checkExportsIdempotency`.
 * @param buffer        - The full buffered response body.
 * @param responseStatus - HTTP status that was sent (must be 2xx).
 * @param responseHeaders - Headers to replay on cache hit.
 * @param reqId         - Correlation ID for structured log entries.
 */
export async function persistExportsIdempotency(
  key: string,
  fingerprint: string,
  buffer: string,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  reqId: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
  await db
    .insert(idempotencyRecords)
    .values({
      key,
      fingerprint,
      responseStatus,
      responseBody: { content: buffer },
      responseHeaders,
      expiresAt,
    })
    .catch((err) => {
      logger.error({ err, reqId, key }, "idempotency_persist_failed_exports");
    });
}
