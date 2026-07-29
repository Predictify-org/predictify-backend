/**
 * fingerprint.ts
 *
 * Computes a stable, deterministic SHA-256 fingerprint for every inbound
 * request and makes it available throughout the request lifecycle.
 *
 * ## What is a request fingerprint?
 *
 * A fingerprint captures *what* a request is — its structural identity —
 * independently of *which* invocation it is (that is the job of X-Request-Id).
 * Two requests with the same method, path, relevant headers, and body will
 * produce the same fingerprint, enabling:
 *
 *   - Forensic correlation across retries and replays
 *   - Idempotency checks at the application layer
 *   - Anomaly detection (unexpected fingerprint spike on a path)
 *   - Audit-log enrichment without relying on mutable request IDs
 *
 * ## Inputs (in hash order)
 *
 *   1. HTTP method          — uppercased (GET, POST, …)
 *   2. Normalised path      — pathname only, no query string
 *   3. Content-Type         — lowercased, parameters stripped (e.g. "application/json")
 *   4. Accept               — lowercased, sorted q-values removed
 *   5. Body hash            — SHA-256 of the raw body bytes (empty string when absent)
 *   6. Authorization type   — scheme token only ("bearer", "basic", …); the
 *                             credential itself is intentionally excluded so the
 *                             fingerprint does NOT vary with rotating tokens
 *
 * Query parameters are excluded because they often contain session tokens,
 * pagination cursors, or timestamps that change across retries.
 *
 * ## Security properties
 *
 *   - No credential leakage: credentials are never hashed in full; only the
 *     scheme name is included.
 *   - No PII leakage: IP addresses and User-Agent strings are excluded.
 *   - The fingerprint is not a secret — it is safe to expose in response
 *     headers and logs.
 *
 * ## Outputs
 *
 *   - `res.locals.fingerprint` — hex string (64 chars, SHA-256)
 *   - `X-Request-Fingerprint` response header
 *   - Stored in AsyncLocalStorage via `requestContextStorage` so that workers
 *     and background code can read it via `getFingerprint()`.
 */

import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger";
import { getRequestId, requestContextStorage } from "../lib/requestContext";
import { getCorrelationId } from "./correlation";

// ── Constants ─────────────────────────────────────────────────────────────

/** Response header that carries the computed fingerprint back to callers. */
export const FINGERPRINT_HEADER = "x-request-fingerprint";

/**
 * Delimiter used between fingerprint components.
 * A character that cannot appear in any of the normalised fields, preventing
 * component-boundary confusion attacks.
 */
const SEP = "\x00";

// ── Normalisation helpers ─────────────────────────────────────────────────

/**
 * Normalise a Content-Type header value.
 *
 * Strips parameters (e.g. `; charset=utf-8`) and lowercases the result.
 * Returns an empty string when the header is absent.
 *
 * @example
 *   normalizeContentType("application/json; charset=utf-8") // "application/json"
 *   normalizeContentType(undefined)                         // ""
 */
export function normalizeContentType(raw: string | undefined): string {
  if (!raw) return "";
  return raw.split(";")[0].trim().toLowerCase();
}

/**
 * Normalise an Accept header value.
 *
 * Removes quality factors (`;q=…`), splits on commas, lowercases each
 * media type, and sorts them so that ordering differences do not produce
 * different fingerprints.
 *
 * Returns an empty string when the header is absent.
 *
 * @example
 *   normalizeAccept("text/html, application/json;q=0.9") // "application/json,text/html"
 *   normalizeAccept(undefined)                           // ""
 */
export function normalizeAccept(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .split(",")
    .map((part) => part.split(";")[0].trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

/**
 * Extract the authorization scheme from an Authorization header value.
 *
 * Returns only the scheme token (e.g. "bearer", "basic") — never the
 * credential itself — so that rotating tokens do not change the fingerprint.
 * Returns an empty string when the header is absent or malformed.
 *
 * @example
 *   extractAuthScheme("Bearer eyJhbGc...")  // "bearer"
 *   extractAuthScheme("Basic dXNlcjpwYXNz") // "basic"
 *   extractAuthScheme(undefined)             // ""
 */
export function extractAuthScheme(raw: string | undefined): string {
  if (!raw) return "";
  const scheme = raw.trim().split(/\s+/)[0];
  return scheme ? scheme.toLowerCase() : "";
}

/**
 * Compute SHA-256 of a string and return the hex digest.
 * Used to hash the request body without including raw body bytes in the
 * concatenated fingerprint input.
 */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ── Body extraction ───────────────────────────────────────────────────────

/**
 * Return a stable string representation of the parsed request body.
 *
 * `express.json()` / `express.urlencoded()` deserialise the body into
 * `req.body`.  We re-serialise it with sorted keys so that JSON objects
 * with the same logical content always produce the same string regardless
 * of property order.
 *
 * An absent or empty body results in an empty string.
 */
function stableBodyString(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body, Object.keys(body as object).sort());
  } catch {
    return "";
  }
}

// ── Core computation ──────────────────────────────────────────────────────

/**
 * Inputs collected from the request used to compute the fingerprint.
 * Exported so that tests can construct and assert on them directly.
 */
export interface FingerprintInputs {
  method: string;
  path: string;
  contentType: string;
  accept: string;
  authScheme: string;
  bodyHash: string;
}

/**
 * Derive the `FingerprintInputs` from an Express `Request`.
 *
 * Exported for unit-testing without standing up an HTTP server.
 */
export function buildFingerprintInputs(req: Request): FingerprintInputs {
  const method = req.method.toUpperCase();

  // Use only the pathname — no query string, no fragment.
  const path = req.path ?? "/";

  const contentType = normalizeContentType(req.headers["content-type"]);
  const accept = normalizeAccept(req.headers["accept"]);
  const authScheme = extractAuthScheme(req.headers["authorization"]);
  const bodyHash = sha256Hex(stableBodyString(req.body));

  return { method, path, contentType, accept, authScheme, bodyHash };
}

/**
 * Compute the SHA-256 fingerprint from the provided inputs.
 *
 * The canonical preimage is:
 *
 *   METHOD\x00PATH\x00CONTENT-TYPE\x00ACCEPT\x00AUTH-SCHEME\x00BODY-HASH
 *
 * The null-byte separator prevents adjacent-component collisions.
 *
 * @returns 64-character lowercase hex string
 */
export function computeFingerprint(inputs: FingerprintInputs): string {
  const preimage = [
    inputs.method,
    inputs.path,
    inputs.contentType,
    inputs.accept,
    inputs.authScheme,
    inputs.bodyHash,
  ].join(SEP);

  return sha256Hex(preimage);
}

// ── Middleware ────────────────────────────────────────────────────────────

/**
 * Express middleware that computes a stable fingerprint for every request.
 *
 * Mount this **after** `express.json()` so that `req.body` is parsed, and
 * **after** the pinoHttp / ALS middleware so that `req.id` and
 * `getRequestId()` are available for log correlation.
 *
 * Side-effects:
 *   - Sets `res.locals.fingerprint` to the hex fingerprint string.
 *   - Sets the `X-Request-Fingerprint` response header.
 *   - Emits a `debug` log line tagged with `reqId` and `fingerprint`.
 *
 * This middleware never throws — any unexpected error is caught, logged as
 * a warning, and execution continues (fingerprint will be absent from the
 * response header but the request is not blocked).
 */
export function fingerprintMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const inputs = buildFingerprintInputs(req);
    const fingerprint = computeFingerprint(inputs);

    // Attach to res.locals so route handlers and other middleware can read it.
    res.locals["fingerprint"] = fingerprint;

    // Persist in AsyncLocalStorage so workers and background code can read it
    // via `getFingerprint()` throughout the request lifecycle.
    const store = requestContextStorage.getStore();
    if (store) {
      store.fingerprint = fingerprint;
    }

    // Expose to caller for forensic correlation.
    res.setHeader(FINGERPRINT_HEADER, fingerprint);

    logger.debug(
      {
        reqId: getRequestId(),
        correlationId: getCorrelationId(),
        fingerprint,
        method: inputs.method,
        path: inputs.path,
      },
      "request_fingerprint_computed",
    );
  } catch (err) {
    // Fingerprint computation is best-effort — a failure must not block the
    // request.  Log the problem so it surfaces in monitoring.
    logger.warn(
      { reqId: getRequestId(), correlationId: getCorrelationId(), err },
      "request_fingerprint_error",
    );
  }

  next();
}
