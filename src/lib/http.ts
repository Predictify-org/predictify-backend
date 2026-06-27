/**
 * http.ts
 *
 * Thin wrapper around the global `fetch` that automatically forwards the
 * current X-Request-Id to outbound calls (e.g. Soroban-RPC).
 *
 * Drop-in replacement for `fetch`:
 *
 *   import { fetchWithRequestId } from "../lib/http";
 *   const res = await fetchWithRequestId(sorobanRpcUrl, { method: "POST", body });
 *
 * If there is no active request context (background job, tests) the header is
 * simply omitted — the call still succeeds.
 */

import { getRequestId } from "./requestContext";

/** The canonical header name used throughout the application. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Wraps `fetch` and injects an `X-Request-Id` header derived from the current
 * AsyncLocalStorage context.  All other arguments are forwarded unchanged.
 */
export async function fetchWithRequestId(
  input: string | URL | Request,
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
