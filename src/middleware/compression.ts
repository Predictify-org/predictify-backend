/**
 * @module compression
 *
 * Provides gzip/deflate response compression for Express routes.
 *
 * ## Overview
 *
 * `compressResponse` is an Express middleware that compresses outgoing JSON
 * responses when:
 *
 * 1. The client advertises `gzip` or `deflate` in its `Accept-Encoding` header.
 * 2. The serialised response body meets or exceeds `COMPRESSION_THRESHOLD`
 *    (default: 1 KiB).
 *
 * Small responses below the threshold are sent uncompressed to avoid the CPU
 * overhead of compressing tiny payloads.
 *
 * ## Encoding preference
 *
 * `gzip` is preferred over `deflate` because it is more widely supported and
 * adds a CRC32 checksum for data-integrity verification.  `identity` (no
 * compression) is always accepted as a fallback.
 *
 * ## How it works
 *
 * The middleware intercepts `res.json()` before the body is written to the
 * socket.  It serialises the payload, decides whether to compress, and writes
 * the appropriate `Content-Encoding`, `Content-Length`, and `Vary` headers
 * before flushing the bytes.
 *
 * ## Usage
 *
 * ```ts
 * import { compressResponse } from "../middleware/compression";
 *
 * // Apply to a specific router
 * router.use(compressResponse);
 *
 * // Or apply to a single route
 * router.post("/", compressResponse, myHandler);
 * ```
 */

import zlib from "zlib";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { logger } from "../config/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum serialised response size (in bytes) required before compression is
 * applied.  Responses smaller than this threshold are sent as-is to avoid
 * wasting CPU on negligible savings.
 *
 * Default: 1024 bytes (1 KiB).
 */
export const COMPRESSION_THRESHOLD = 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Encoding = "gzip" | "deflate" | "identity";

/**
 * Parses the `Accept-Encoding` request header and returns the best supported
 * encoding for this middleware.
 *
 * Priority order: gzip > deflate > identity.
 *
 * @param acceptEncoding - Raw value of the `Accept-Encoding` header.
 * @returns The chosen encoding.
 */
export function selectEncoding(
  acceptEncoding: string | undefined,
): Encoding {
  if (!acceptEncoding) return "identity";
  const header = acceptEncoding.toLowerCase();
  if (header.includes("gzip")) return "gzip";
  if (header.includes("deflate")) return "deflate";
  return "identity";
}

/**
 * Synchronously compresses `data` using the given encoding.
 *
 * @param data     - The buffer to compress.
 * @param encoding - `"gzip"` or `"deflate"`.
 * @returns A compressed `Buffer`.
 * @throws When the underlying zlib call fails.
 */
function compress(data: Buffer, encoding: "gzip" | "deflate"): Buffer {
  return encoding === "gzip"
    ? zlib.gzipSync(data)
    : zlib.deflateSync(data);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that compresses JSON responses for disputes endpoints.
 *
 * - Intercepts `res.json()` to serialise and optionally compress the body.
 * - Adds `Vary: Accept-Encoding` so caches store separate entries per encoding.
 * - Only compresses when `Accept-Encoding` includes `gzip` or `deflate` *and*
 *   the serialised body is ≥ `COMPRESSION_THRESHOLD` bytes.
 * - Falls back to uncompressed for small payloads or unsupported encodings.
 */
export const compressResponse: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Always advertise that the response varies by Accept-Encoding so HTTP
  // caches (proxies, CDNs) store separate copies per encoding.
  res.setHeader("Vary", "Accept-Encoding");

  const encoding = selectEncoding(req.headers["accept-encoding"] as string | undefined);

  if (encoding === "identity") {
    // Client does not want compression — proceed normally.
    next();
    return;
  }

  // Intercept res.json to apply compression before writing to the socket.
  const originalJson = res.json.bind(res);

  res.json = function compressedJson(body: unknown): Response {
    const serialised = JSON.stringify(body);
    const rawBuffer = Buffer.from(serialised, "utf8");

    // Skip compression for small responses.
    if (rawBuffer.byteLength < COMPRESSION_THRESHOLD) {
      logger.debug(
        {
          path: req.path,
          method: req.method,
          bytes: rawBuffer.byteLength,
          threshold: COMPRESSION_THRESHOLD,
        },
        "compression_skipped_below_threshold",
      );
      return originalJson(body);
    }

    try {
      const compressed = compress(rawBuffer, encoding);

      logger.debug(
        {
          path: req.path,
          method: req.method,
          encoding,
          originalBytes: rawBuffer.byteLength,
          compressedBytes: compressed.byteLength,
          ratio: (
            ((rawBuffer.byteLength - compressed.byteLength) /
              rawBuffer.byteLength) *
            100
          ).toFixed(1),
        },
        "compression_applied",
      );

      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", compressed.byteLength);

      res.status(res.statusCode);
      res.end(compressed);
      return res;
    } catch (err) {
      // If compression fails for any reason, fall back to uncompressed.
      logger.warn(
        { path: req.path, method: req.method, encoding, err },
        "compression_failed_fallback_to_identity",
      );
      return originalJson(body);
    }
  };

  next();
};
