/**
 * X-Api-Version middleware
 *
 * Flow:
 *  1. Read X-Api-Version header (defaults to v1 if not provided).
 *  2. Normalize version string: strip "v" prefix if present.
 *  3. Validate against supported versions (v1, v2).
 *  4. Reject unsupported versions with 400 BadRequest.
 *  5. Attach normalized version to req.apiVersion for downstream handlers.
 *  6. Echo the normalized version in response header.
 */

import type { NextFunction, Request, Response } from "express";

export const API_VERSION_HEADER = "x-api-version";
export const DEFAULT_API_VERSION = "v1";
export const SUPPORTED_VERSIONS = ["v1", "v2"] as const;

type SupportedVersion = (typeof SUPPORTED_VERSIONS)[number];

/**
 * Normalize a version string to canonical form (e.g., "2" -> "v2", "v1" -> "v1").
 * Returns undefined if invalid format.
 */
function normalizeVersion(raw: string): SupportedVersion | undefined {
  const trimmed = raw.trim().toLowerCase();
  // Match "v1", "v2", "1", "2" etc.
  const match = trimmed.match(/^v?(\d+)$/);
  if (!match) return undefined;
  const normalized = `v${match[1]}`;
  if (SUPPORTED_VERSIONS.includes(normalized as SupportedVersion)) {
    return normalized as SupportedVersion;
  }
  return undefined;
}

export function apiVersionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Get header (case-insensitive)
  const raw = req.headers[API_VERSION_HEADER];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;

  // Default to v1 if not provided
  const versionString = headerValue ?? DEFAULT_API_VERSION;

  // Normalize and validate
  const resolvedVersion = normalizeVersion(versionString);

  if (!resolvedVersion) {
    // Unsupported version
    res.status(400).json({
      error: {
        code: "BadRequest",
        message: `Unsupported API version: "${versionString}". Supported versions: ${SUPPORTED_VERSIONS.join(", ")}`,
      },
    });
    return;
  }

  // Attach to request for downstream handlers
  (req as Request & { apiVersion?: string }).apiVersion = resolvedVersion;

  // Echo in response header
  res.setHeader(API_VERSION_HEADER, resolvedVersion);

  next();
}
