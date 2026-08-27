  
  
export { requireAuth } from "./requireAuth";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { verifyAccessToken } from "../services/jwtService";
import { scopeForAdminPath } from "./scopeCatalog";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    stellarAddress: string;
  };
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return;
    }

    const token = authHeader.split(" ")[1];
    const payload = verifyAccessToken(token) as {
      sub: string;
      role?: string;
      scopes?: unknown;
    };

    const stellarAddress = payload.sub;
    if (!stellarAddress) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return;
    }
    if (payload.role !== undefined && payload.role !== "admin" && payload.role !== "operator") {
      res.status(403).json({ error: { code: "forbidden" } });
      return;
    }

    if (!env.ADMIN_ALLOWLIST.includes(stellarAddress)) {
      res.status(403).json({ error: { code: "forbidden" } });
      return;
    }

    const scopes = Array.isArray(payload.scopes) &&
      payload.scopes.every((scope): scope is string => typeof scope === "string")
      ? payload.scopes
      : undefined;
    const requiredScope = scopeForAdminPath(req.originalUrl || req.baseUrl || req.path);
    if (scopes !== undefined && !scopes.includes(requiredScope)) {
      res.status(403).json({ error: { code: "forbidden_scope", requiredScope } });
      return;
    }

    req.user = { id: stellarAddress, stellarAddress };
    req.authRole = payload.role ?? "admin";
    req.authScopes = scopes;
    next();
  } catch {
    res.status(401).json({ error: { code: "unauthorized" } });
  }
}
