
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import type { RouteError } from "../errors/RouteError";
import { logger } from "../config/logger";
import { requestContextStorage } from "../lib/requestContext";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TOKEN_BYTES = 32;

function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** Generates a cryptographically random CSRF token. */
export function generateCsrfToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}


function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function getCorrelationId(req: Request): string {
  const ctxRequestId = requestContextStorage.getStore()?.requestId;
  if (ctxRequestId) {
    return ctxRequestId;
  }
 
  const existing = (req as Request & { id?: string }).id;
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  return crypto.randomUUID();
}

function forbidden(req: Request, _res: Response, next: NextFunction, reason: string): void {
  const correlationId = getCorrelationId(req);
  logger.warn(
    { correlationId, path: req.path, method: req.method, reason },
    "CSRF verification failed",
  );
  const routeError: RouteError = {
    kind: "Forbidden",
    message: "CSRF token missing or invalid",
    reason,
  };
 
  next(routeError);
}


export function issueCsrfToken(req: Request, res: Response, next: NextFunction): void {
  const existing = req.cookies?.[env.CSRF_COOKIE_NAME];
  if (!existing) {
    const token = generateCsrfToken();
    res.cookie(env.CSRF_COOKIE_NAME, token, {
      httpOnly: false, // must be readable by client JS to echo back in the header
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: env.CSRF_TOKEN_TTL_SECONDS * 1000,
      path: "/",
    });
  }
  next();
}


export function verifyCsrfToken(req: Request, res: Response, next: NextFunction): void {
  if (!isUnsafeMethod(req.method)) {
    next();
    return;
  }

  const hasSessionCookie = Boolean(req.cookies?.[env.SESSION_COOKIE_NAME]);
  if (!hasSessionCookie) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[env.CSRF_COOKIE_NAME];
  const headerToken = req.headers[env.CSRF_HEADER_NAME];

  if (!cookieToken || typeof cookieToken !== "string") {
    forbidden(req, res, next, "missing_csrf_cookie");
    return;
  }

  if (!headerToken || Array.isArray(headerToken)) {
    forbidden(req, res, next, "missing_csrf_header");
    return;
  }

  if (!safeCompare(cookieToken, headerToken)) {
    forbidden(req, res, next, "csrf_token_mismatch");
    return;
  }

  next();
}