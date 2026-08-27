import type { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "../config/logger";
import { requireAdmin } from "./requireAdmin";
import type { AdminScope } from "./scopeCatalog";

export { ADMIN_SCOPES } from "./scopeCatalog";
export type { AdminScope } from "./scopeCatalog";

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      authRole?: string;
      authScopes?: string[];
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

/** Returns true only when a scoped token contains the exact requested scope. */
export function hasScope(
  scopes: readonly string[] | undefined,
  required: AdminScope,
): boolean {
  return scopes?.includes(required) ?? false;
}

function auditOperatorDecision(
  req: Request,
  required: AdminScope,
  allowed: boolean,
): void {
  logger.info(
    {
      audit: true,
      action: allowed ? "operator.scope_granted" : "operator.scope_denied",
      actor: req.adminAddress ?? null,
      role: req.authRole ?? null,
      requiredScope: required,
      scopes: req.authScopes ?? [],
      method: req.method,
      path: req.path,
      ip: req.ip,
    },
    allowed ? "operator_scope_granted" : "operator_scope_denied",
  );
}

/**
 * Enforces one exact authorization domain after `requireAdmin` has verified
 * the token. Admin tokens issued before scopes were introduced remain valid
 * as a compatibility bridge; any token that carries scopes is restricted to
 * those scopes. Operator tokens must always carry the required scope.
 */
export function requireScope(required: AdminScope): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const isLegacyAdmin = req.authRole === "admin" && req.authScopes === undefined;
    const allowed = isLegacyAdmin || hasScope(req.authScopes, required);
    if (!allowed) {
      auditOperatorDecision(req, required, false);
      res.status(403).json({ error: { code: "forbidden_scope", requiredScope: required } });
      return;
    }
    if (req.authRole === "operator") auditOperatorDecision(req, required, true);
    next();
  };
}

/** Combines the existing identity check and an explicit scope declaration. */
export function requireScopedAdmin(required: AdminScope): RequestHandler {
  const scopeMiddleware = requireScope(required);
  return (req, res, next) => {
    requireAdmin(req, res, () => scopeMiddleware(req, res, next));
  };
}
