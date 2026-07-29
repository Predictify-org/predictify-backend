  
  
export { requireAuth } from "./requireAuth";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { verifyAccessToken } from "../services/jwtService";

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
    const payload = verifyAccessToken(token) as { sub: string };

    const stellarAddress = payload.sub;
    if (!stellarAddress) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return;
    }

    if (!env.ADMIN_ALLOWLIST.includes(stellarAddress)) {
      res.status(403).json({ error: { code: "forbidden" } });
      return;
    }

    req.user = { id: stellarAddress, stellarAddress };
    next();
  } catch {
    res.status(401).json({ error: { code: "unauthorized" } });
  }
}

