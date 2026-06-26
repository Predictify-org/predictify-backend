import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export interface JwtPayload {
  sub: string;
  stellarAddress: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: { code: "unauthorized", message: "Missing or malformed Authorization header" } });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as JwtPayload;

    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: { code: "unauthorized", message: "Invalid or expired token" } });
  }
}
