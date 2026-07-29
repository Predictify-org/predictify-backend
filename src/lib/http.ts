/**
 * http.ts
 *
 * Thin wrappers around the global `fetch` that automatically forward per-request
 * trace headers to outbound calls (e.g. Soroban-RPC, partner APIs).
 *
 * Two helpers are provided:
 *
 *   fetchWithRequestId(url, init?)     — injects X-Request-Id
 *   fetchWithCorrelationId(url, init?) — injects X-Correlation-Id
 *
 * Both are drop-in replacements for `fetch`:
 *
 *   import { fetchWithCorrelationId } from "../lib/http";
 *   const res = await fetchWithCorrelationId(sorobanRpcUrl, { method: "POST", body });
 *
 * If there is no active request context (background job, tests) the header is
 * simply omitted — the call still succeeds.
 */

import { getRequestId } from "./requestContext";

/** The canonical X-Request-Id header name used throughout the application. */
export const REQUEST_ID_HEADER = "x-request-id";

/** The canonical X-Correlation-Id header name used throughout the application. */
export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Wraps `fetch` and injects an `X-Request-Id` header derived from the current
 * AsyncLocalStorage context.  All other arguments are forwarded unchanged.
 */
export async function fetchWithRequestId(
  input: string | URL | globalThis.Request,
  init?: RequestInit,
): Promise<Response> {
  const requestId = getRequestId();

  if (!requestId) {
    // No active request context — call fetch as-is.
    return fetch(input, init);
  }

  const headers = new Headers(init?.headers);
  headers.set(REQUEST_ID_HEADER, requestId);

  return fetch(input, { ...init, headers });
}

/**
 * Wraps `fetch` and injects an `X-Correlation-Id` header derived from the
 * current AsyncLocalStorage context (set by `correlationMiddleware`).
 *
 * This ensures that correlation IDs established at the HTTP boundary are
 * propagated to every downstream / outbound call made within the same request
 * lifecycle — enabling end-to-end distributed tracing without manual threading.
 *
 * If no correlation ID is present in the current context the call is forwarded
 * to `fetch` unchanged (same behaviour as `fetchWithRequestId`).
 */
export async function fetchWithCorrelationId(
  input: string | URL | globalThis.Request,
  init?: RequestInit,
): Promise<Response> {
  // Import lazily to avoid circular dependency at module evaluation time.
  const { getCorrelationId } = await import("../middleware/correlation");
  const correlationId = getCorrelationId();

  if (!correlationId) {
    return fetch(input, init);
  }

  const headers = new Headers(init?.headers);
  headers.set(CORRELATION_ID_HEADER, correlationId);

  return fetch(input, { ...init, headers });
}
