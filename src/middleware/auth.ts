import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export interface AuthenticatedRequest extends Request {
  user?: {
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
    const payload = jwt.verify(token, env.JWT_SECRET, {
      audience: env.JWT_AUDIENCE,
      issuer: env.JWT_ISSUER,
    }) as { sub: string };

    const stellarAddress = payload.sub;
    if (!stellarAddress) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return;
    }

    if (!env.ADMIN_ALLOWLIST.includes(stellarAddress)) {
      res.status(403).json({ error: { code: "forbidden" } });
      return;
    }

    req.user = { stellarAddress };
    next();
  } catch (err) {
    res.status(401).json({ error: { code: "unauthorized" } });
  }
}

