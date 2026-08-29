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
import { logger } from "../config/logger";

/** The canonical X-Request-Id header name used throughout the application. */
export const REQUEST_ID_HEADER = "x-request-id";

/** The canonical X-Correlation-Id header name used throughout the application. */
export const CORRELATION_ID_HEADER = "x-correlation-id";

export interface FetchRetryOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
}

export class FetchError extends Error {
  constructor(public readonly response: Response | undefined, message: string) {
    super(message);
    this.name = "FetchError";
  }
}

/**
 * Wraps `fetch` with a bounded retry policy, exponential backoff, and timeouts.
 * Retries on 5xx status codes, 429 Too Many Requests, or network failures.
 */
export async function fetchWithRetry(
  input: string | URL | globalThis.Request,
  init?: RequestInit,
  options: FetchRetryOptions = {}
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseBackoff = options.baseBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 10000;
  const timeoutMs = options.timeoutMs ?? 10000;

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const mergedSignal = init?.signal 
      ? AbortSignal.any([init.signal, controller.signal]) 
      : controller.signal;

    try {
      const response = await fetch(input, { ...init, signal: mergedSignal });
      
      if (!response.ok && (response.status >= 500 || response.status === 429)) {
        throw new FetchError(response, `HTTP ${response.status}`);
      }

      return response;
    } catch (err: any) {
      lastError = err;
      
      // Do not retry on explicit aborts from the caller's own signal
      if (err.name === 'AbortError' && init?.signal?.aborted) {
        throw err;
      }

      if (attempt >= maxAttempts) {
        break;
      }

      const backoff = Math.min(maxBackoff, baseBackoff * Math.pow(2, attempt - 1));
      
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      logger.warn({ url: urlStr, attempt, error: err.message }, "fetchWithRetry: external provider call failed, retrying");
      
      await new Promise(resolve => setTimeout(resolve, backoff));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

/**
 * Wraps `fetch` and injects an `X-Request-Id` header derived from the current
 * AsyncLocalStorage context.  All other arguments are forwarded unchanged.
 */
export async function fetchWithRequestId(
  input: string | URL | globalThis.Request,
  init?: RequestInit,
  options?: FetchRetryOptions
): Promise<Response> {
  const requestId = getRequestId();

  if (!requestId) {
    // No active request context — call fetch as-is.
    return fetchWithRetry(input, init, options);
  }

  const headers = new Headers(init?.headers);
  headers.set(REQUEST_ID_HEADER, requestId);

  return fetchWithRetry(input, { ...init, headers }, options);
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
  options?: FetchRetryOptions
): Promise<Response> {
  // Import lazily to avoid circular dependency at module evaluation time.
  const { getCorrelationId } = await import("../middleware/correlation");
  const correlationId = getCorrelationId();

  if (!correlationId) {
    return fetchWithRetry(input, init, options);
  }

  const headers = new Headers(init?.headers);
  headers.set(CORRELATION_ID_HEADER, correlationId);

  return fetchWithRetry(input, { ...init, headers }, options);
}
