/**
 * requestContext.ts
 *
 * Provides an AsyncLocalStorage-based store that makes the current request ID
 * available anywhere in the call stack — including workers and background jobs —
 * without threading it through every function signature.
 *
 * Usage (Express middleware sets it, everything else reads it):
 *
 *   import { getRequestId } from "../lib/requestContext";
 *   logger.info({ reqId: getRequestId() }, "doing work");
 */

import { AsyncLocalStorage } from "async_hooks";

/** Shape of the per-request context bag. */
export interface RequestContext {
  /** Sanitised X-Request-Id for this request (max 64 chars). */
  requestId: string;
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
