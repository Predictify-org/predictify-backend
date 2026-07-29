import type { NextFunction, Request, Response } from "express";

export const API_VERSION_HEADER = "x-api-version";
export const DEPRECATION_HEADER = "Deprecation";
export const SUNSET_HEADER = "Sunset";

// Deprecation and Sunset dates
// Deprecation: API version is now deprecated.
// Sunset: API version will be removed on this date.
const DEPRECATION_DATE = "Tue, 28 Jul 2026 00:00:00 GMT";
const SUNSET_DATE = "Tue, 28 Jul 2027 00:00:00 GMT";

export function deprecationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const raw = req.headers[API_VERSION_HEADER.toLowerCase()];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  
  // Default to v1 if not provided, per existing convention.
  const versionString = headerValue ?? "v1";

  if (versionString === "v1" || versionString === "1") {
    res.setHeader(DEPRECATION_HEADER, DEPRECATION_DATE);
    res.setHeader(SUNSET_HEADER, SUNSET_DATE);
  }
  next();
}
