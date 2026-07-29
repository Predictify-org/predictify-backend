/**
 * requestContext.ts
 *
 * Provides an AsyncLocalStorage-based store that makes per-request values
 * available anywhere in the call stack — including workers and background
 * jobs — without threading them through every function signature.
 *
 * Currently carried values:
 *   - requestId   : sanitised X-Request-Id (set by pinoHttp + ALS middleware)
 *   - fingerprint : stable SHA-256 request fingerprint (set by fingerprintMiddleware)
 *
 * Usage:
 *
 *   import { getRequestId, getFingerprint } from "../lib/requestContext";
 *   logger.info({ reqId: getRequestId(), fp: getFingerprint() }, "doing work");
 */

import { AsyncLocalStorage } from "async_hooks";

/** Shape of the per-request context bag. */
export interface RequestContext {
  /** Sanitised X-Request-Id for this request (max 64 chars). */
  requestId: string;
  /**
   * Stable SHA-256 fingerprint of the request structure.
   * Populated after fingerprintMiddleware runs; undefined until then.
   */
  fingerprint?: string;
  /**
   * Resolved X-Correlation-Id for this request.
   * Populated by `correlationMiddleware` after it runs; undefined until then.
   * Prefer reading via `getCorrelationId()` from `src/middleware/correlation`.
   */
  correlationId?: string;
}

/**
 * The singleton storage instance.
 * Exported so Express middleware can call `.run()` on it.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the request ID for the currently active async context,
 * or `undefined` when called outside of a request (e.g. startup code).
 */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}

/**
 * Returns the request fingerprint for the currently active async context,
 * or `undefined` when called outside of a request or before the fingerprint
 * middleware has run.
 */
export function getFingerprint(): string | undefined {
  return requestContextStorage.getStore()?.fingerprint;
}
