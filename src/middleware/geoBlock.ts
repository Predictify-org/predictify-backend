/**
 * geoBlock — Express middleware that blocks requests from configured countries.
 *
 * Behaviour
 * ---------
 * - Loads a MaxMind MMDB file once at startup via `loadGeoBlockReader()`.
 * - Resolves the country ISO code from req.ip via the in-memory Reader.
 * - Returns 451 (Unavailable For Legal Reasons) when the country is in the
 *   GEO_BLOCKED_COUNTRIES list, unless:
 *     (a) the request carries a valid admin JWT  (admin bypass), or
 *     (b) the resolved IP is on the GEO_ALLOWLIST (per-IP allowlist).
 * - If MMDB_PATH is empty or GEO_BLOCKED_COUNTRIES is empty the middleware
 *   is a no-op, so deployments without geo-blocking are unaffected.
 *
 * Env vars (parsed by src/config/env.ts)
 * ----------------------------------------
 *   GEO_BLOCKED_COUNTRIES  comma-separated ISO 3166-1 alpha-2 codes, e.g. "RU,KP"
 *   MMDB_PATH              absolute path to GeoLite2-Country.mmdb
 *   GEO_ALLOWLIST          comma-separated IP addresses that always pass through
 */

import { readFileSync, existsSync } from "fs";
import type { NextFunction, Request, Response } from "express";
import { Reader } from "mmdb-lib";
import type { CountryResponse } from "mmdb-lib";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { env } from "../config/env";
import { logger } from "../config/logger";

// ── Module-level reader singleton ────────────────────────────────────────────

let _reader: Reader<CountryResponse> | null = null;
let _loadAttempted = false;

/** Loads the MMDB into memory synchronously. Call once at app startup. */
export function loadGeoBlockReader(): Reader<CountryResponse> | null {
  if (_loadAttempted) return _reader;
  _loadAttempted = true;

  if (!env.MMDB_PATH) return null;

  if (!existsSync(env.MMDB_PATH)) {
    logger.warn({ mmdbPath: env.MMDB_PATH }, "geo_block: MMDB file not found, geo-blocking disabled");
    return null;
  }

  try {
    const buf = readFileSync(env.MMDB_PATH);
    _reader = new Reader<CountryResponse>(buf);
    logger.info({ mmdbPath: env.MMDB_PATH }, "geo_block: MMDB loaded");
  } catch (err) {
    logger.error({ err, mmdbPath: env.MMDB_PATH }, "geo_block: failed to load MMDB");
    _reader = null;
  }

  return _reader;
}

/** Returns the cached reader (null when MMDB is not loaded). */
export function getReader(): Reader<CountryResponse> | null {
  if (!_loadAttempted) return loadGeoBlockReader();
  return _reader;
}

/** Resets the cached reader — used in tests only. */
export function _resetReader(): void {
  _reader = null;
  _loadAttempted = false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolves country ISO code from an IP address using the reader.
 * Returns null when the IP cannot be mapped (private ranges, parse errors).
 */
export function resolveCountry(reader: Reader<CountryResponse>, ip: string): string | null {
  try {
    const result = reader.get(ip);
    return result?.country?.iso_code ?? null;
  } catch {
    return null;
  }
}

/**
 * Checks whether the Authorization header carries a valid admin JWT.
 * Returns true when role === "admin" and signature is valid.
 */
export function isAdminToken(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as JwtPayload;
    return payload?.role === "admin";
  } catch {
    return false;
  }
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Returns a geoBlock RequestHandler.
 *
 * Providing a `readerOverride` lets tests inject a mock without touching the FS.
 */
export function createGeoBlock(readerOverride?: Reader<CountryResponse> | null) {
  return function geoBlock(req: Request, res: Response, next: NextFunction): void {
    const blockedCountries = env.GEO_BLOCKED_COUNTRIES;

    // No-op: feature not configured
    if (!blockedCountries.length) {
      next();
      return;
    }

    const reader = readerOverride !== undefined ? readerOverride : getReader();

    // Fail open: MMDB unavailable avoids hard outage while logging a warning
    if (!reader) {
      next();
      return;
    }

    // Admin bypass
    if (isAdminToken(req.headers.authorization)) {
      next();
      return;
    }

    const ip = req.ip ?? "";

    // Per-IP allowlist bypass
    const allowlist: string[] = env.GEO_ALLOWLIST ?? [];
    if (allowlist.includes(ip)) {
      next();
      return;
    }

    const countryCode = resolveCountry(reader, ip);

    if (countryCode && blockedCountries.includes(countryCode)) {
      logger.warn(
        { ip, countryCode, path: req.path, method: req.method },
        "geo_block: request blocked",
      );
      res.status(451).json({
        error: {
          code: "geo_blocked",
          country: countryCode,
          message: "Access from your region is not available.",
        },
      });
      return;
    }

    next();
  };
}

/** Singleton middleware instance — mount this in src/index.ts */
export const geoBlock = createGeoBlock();
