/**
 * @module etag
 *
 * Provides strong ETag support for GET endpoints per RFC 7232.
 *
 * ## How it works
 *
 * `generateETag(payload)` – deterministically hashes any serialisable value
 * using SHA-256 and returns a quoted strong ETag string, e.g. `"a3f2..."`.
 *
 * `conditionalGet(payload)` – Express middleware helper. Call it with the
 * freshly-loaded resource payload after the database read (single object or
 * collection response payloads such as `{ data: [...] }`):
 *
 *   1. Computes the strong ETag for `payload`.
 *   2. Sets `ETag` and `Cache-Control: no-cache` response headers so the
 *      browser/proxy can store and revalidate the response.
 *   3. If the request carries `If-None-Match` whose value matches the
 *      computed ETag, responds with **304 Not Modified** (no body).
 *   4. Otherwise calls `next()` so the route handler continues and sends
 *      the full 200 response.
 *
 * `Cache-Control: no-cache` is intentional — it tells the client "you MAY
 * cache this, but always revalidate with the server before using the cached
 * copy".  This pairs correctly with conditional GETs: the client revalidates
 * cheaply (304 = no body) instead of always re-downloading.
 *
 * ## Security
 *
 * Strong ETags are content-derived (SHA-256).  Weak ETags (`W/"..."`) are
 * explicitly not used because the spec reserves them for semantically
 * equivalent representations, which is not what we model here.
 *
 * The `If-None-Match` header value is stripped of its surrounding quotes
 * before comparison so both `"abc"` and `abc` are handled safely.  The
 * header is never written back to clients or persisted.
 *
 * ## Usage example
 *
 * ```ts
 * import { generateETag, conditionalGet } from "../middleware/etag";
 *
 * marketsRouter.get("/:id", async (req, res, next) => {
 *   const market = await getMarketById(req.params.id);
 *   if (!market) return res.status(404).json({ ... });
 *
 *   // Respond with 304 if client already has the current version.
 *   const done = conditionalGet(market, req, res);
 *   if (done) return;
 *
 *   return res.json({ data: market });
 * });
 * ```
 */

import { createHash } from "crypto";
import type { Request, Response } from "express";
import { logger } from "../config/logger";

// ---------------------------------------------------------------------------
// ETag generation
// ---------------------------------------------------------------------------

/**
 * Generates a strong ETag for the given payload.
 *
 * The payload is JSON-serialised with sorted keys so that field-insertion
 * order does not affect the resulting hash (identical data → identical ETag).
 *
 * @param payload - Any JSON-serialisable value (object, array, primitive).
 * @returns A quoted strong ETag string, e.g. `"d4e5f6..."`.
 */
export function generateETag(payload: unknown): string {
  // Sort keys for deterministic serialisation — field-ordering in the DB
  // result set must never change the ETag for the same logical state.
  const serialised = JSON.stringify(payload, sortedReplacer);
  const hash = createHash("sha256").update(serialised).digest("hex");
  // RFC 7232 §2.3 requires the ETag value to be enclosed in double-quotes.
  return `"${hash}"`;
}

/**
 * JSON.stringify replacer that sorts object keys alphabetically.
 * Arrays are left in their natural order.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Conditional GET helper
// ---------------------------------------------------------------------------

/**
 * Handles conditional GET logic for a single resource.
 *
 * Sets the `ETag` and `Cache-Control` response headers, then checks whether
 * the client's `If-None-Match` header matches the computed ETag.
 *
 * @param payload  - The resource payload that will be sent in the 200 body.
 * @param req      - The Express request object.
 * @param res      - The Express response object.
 * @returns `true` when a 304 was sent (caller must **return** immediately);
 *          `false` when the caller should continue and send the full response.
 *
 * @example
 * ```ts
 * const etag = conditionalGet(market, req, res);
 * if (etag) return; // 304 already sent
 * return res.json({ data: market });
 * ```
 */
export function conditionalGet(
  payload: unknown,
  req: Request,
  res: Response,
): boolean {
  const reqId = String((req as { id?: unknown }).id ?? "anon");
  const etag = generateETag(payload);

  // Always set ETag so the client can cache the value for future requests.
  res.setHeader("ETag", etag);

  // Cache-Control: no-cache tells clients they may cache the response but
  // must revalidate it before use — enabling efficient conditional GETs
  // while ensuring stale data is never served without a check.
  res.setHeader("Cache-Control", "no-cache");

  const ifNoneMatch = req.headers["if-none-match"];
  const ifNoneMatchValues = Array.isArray(ifNoneMatch)
    ? ifNoneMatch.filter((value): value is string => typeof value === "string")
    : typeof ifNoneMatch === "string"
      ? [ifNoneMatch]
      : [];

  if (ifNoneMatchValues.length > 0) {
    // Strip surrounding quotes from the client-sent header value so both
    // `"abc123"` (quoted, as sent by compliant clients) and the raw hash
    // are compared correctly against our quoted ETag.
    const normalisedValues = ifNoneMatchValues.map((value) =>
      value.replace(/^"|"$/g, ""),
    );
    const currentHash = etag.replace(/^"|"$/g, "");

    if (normalisedValues.includes(currentHash)) {
      logger.debug(
        { reqId, etag, path: req.path },
        "etag_not_modified",
      );
      // RFC 7232 §4.1 — 304 must NOT include a message body.
      res.status(304).end();
      return true;
    }
  }

  return false;
}
