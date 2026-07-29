/**
 * @module middleware/securityHeaders
 *
 * Sets a strict, JSON-API-appropriate set of security response headers:
 * `Content-Security-Policy`, `X-Content-Type-Options`, and `Referrer-Policy`.
 *
 * Why a separate middleware from `middleware/csp.ts`
 * ---------------------------------------------------
 * `csp.ts` configures `helmet()` for HTML-serving surfaces (the Swagger docs
 * page) that legitimately load scripts, styles, and fonts from a small
 * allow-list of origins. Pure JSON API routes never render markup and never
 * need to load any sub-resource, so they get a stricter, purpose-built
 * policy instead of reusing the docs/browser-oriented one:
 *
 *   - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none';
 *     base-uri 'none'` — denies loading of any resource type and blocks the
 *     response from ever being framed. Defence-in-depth: even though the
 *     response is JSON and browsers won't execute it, this guarantees a
 *     compliant client (or a browser tricked into rendering the body,
 *     e.g. via a content-type confusion bug upstream) has zero capability.
 *   - `X-Content-Type-Options: nosniff` — stops browsers from MIME-sniffing
 *     the JSON body as HTML/script and executing it.
 *   - `Referrer-Policy: no-referrer` — the request URL (which may embed
 *     resource identifiers) is never leaked to a third party via the
 *     `Referer` header on any outbound navigation/subrequest.
 *
 * Usage
 * -----
 *   import { securityHeaders } from "../middleware/securityHeaders";
 *
 *   // Mount first, before auth/business-logic middleware, so the headers
 *   // are present on every response from this router — including 401/403s
 *   // and indexer responses (/api/indexer).
 *   someRouter.use(securityHeaders);
 */

import type { NextFunction, Request, Response } from "express";
import { logger } from "../config/logger";
import { getCorrelationId } from "./correlation";

/**
 * The exact header/value pairs applied by {@link securityHeaders}.
 * Exported so tests can assert against a single source of truth instead of
 * duplicating literal strings.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/**
 * Express middleware — sets {@link API_SECURITY_HEADERS} on every response
 * for the router it is mounted on, then calls `next()` unconditionally.
 *
 * Safe to mount as the very first middleware on any router: it never reads
 * the request body, never throws, and never short-circuits the chain.
 */
export function securityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  for (const [header, value] of Object.entries(API_SECURITY_HEADERS)) {
    res.setHeader(header, value);
  }

  logger.debug(
    { correlationId: getCorrelationId(), path: req.path },
    "security_headers_applied",
  );

  next();
}
