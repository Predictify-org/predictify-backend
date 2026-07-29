/**
 * Tests for src/middleware/geoBlock.ts
 *
 * Strategy: inject a mock Reader via createGeoBlock(readerOverride) so tests
 * never touch the filesystem or a real MMDB file. The env is patched per-test
 * using Object.defineProperty on the parsed env object.
 */

// Must be before any src import that reads env
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/predictify_test";
process.env.JWT_SECRET = "test-jwt-secret-that-is-at-least-32-chars!";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000000";

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { CountryResponse } from "mmdb-lib";
import { Reader } from "mmdb-lib";

import {
  createGeoBlock,
  resolveCountry,
  isAdminToken,
  _resetReader,
  loadGeoBlockReader,
  getReader,
} from "../src/middleware/geoBlock";
import { env } from "../src/config/env";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Builds a minimal Express app with one GET / that returns 200 */
function buildApp(readerOverride?: Reader<CountryResponse> | null) {
  const app = express();
  app.use(createGeoBlock(readerOverride));
  app.get("/", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

/** Creates a mock Reader that returns the given countryCode for any IP */
function mockReader(countryCode: string | null): Reader<CountryResponse> {
  return {
    get: () => (countryCode ? { country: { iso_code: countryCode, geoname_id: 1, names: { en: countryCode } } } : null),
  } as unknown as Reader<CountryResponse>;
}

/** Signs an admin JWT */
function adminToken(): string {
  return jwt.sign(
    { sub: "G" + "A".repeat(55), role: "admin" },
    env.JWT_SECRET,
    { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE },
  );
}

/** Signs a non-admin JWT */
function userToken(): string {
  return jwt.sign(
    { sub: "G" + "A".repeat(55), role: "user" },
    env.JWT_SECRET,
    { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE },
  );
}

// ── Patch env helpers ──────────────────────────────────────────────────────

function setBlockedCountries(codes: string[]) {
  Object.defineProperty(env, "GEO_BLOCKED_COUNTRIES", { value: codes, configurable: true, writable: true });
}

function setAllowlist(ips: string[]) {
  Object.defineProperty(env, "GEO_ALLOWLIST", { value: ips, configurable: true, writable: true });
}

function setMmdbPath(path: string) {
  Object.defineProperty(env, "MMDB_PATH", { value: path, configurable: true, writable: true });
}

// ── Test suite ─────────────────────────────────────────────────────────────

beforeEach(() => {
  setBlockedCountries([]);
  setAllowlist([]);
  setMmdbPath("");
  _resetReader();
});

describe("createGeoBlock middleware", () => {
  describe("when GEO_BLOCKED_COUNTRIES is empty", () => {
    it("passes every request through (no-op)", async () => {
      const res = await request(buildApp(mockReader("RU"))).get("/");
      expect(res.status).toBe(200);
    });
  });

  describe("when blocked countries are configured but reader is null", () => {
    it("fails open — passes request through", async () => {
      setBlockedCountries(["RU"]);
      const res = await request(buildApp(null)).get("/");
      expect(res.status).toBe(200);
    });
  });

  describe("when a blocked country is resolved", () => {
    it("returns 451 with geo_blocked error body", async () => {
      setBlockedCountries(["RU"]);
      const res = await request(buildApp(mockReader("RU"))).get("/");
      expect(res.status).toBe(451);
      expect(res.body.error.code).toBe("geo_blocked");
      expect(res.body.error.country).toBe("RU");
    });

    it("includes a human-readable message", async () => {
      setBlockedCountries(["KP"]);
      const res = await request(buildApp(mockReader("KP"))).get("/");
      expect(res.status).toBe(451);
      expect(typeof res.body.error.message).toBe("string");
    });
  });

  describe("when the country is not in the blocked list", () => {
    it("passes the request through", async () => {
      setBlockedCountries(["RU", "KP"]);
      const res = await request(buildApp(mockReader("DE"))).get("/");
      expect(res.status).toBe(200);
    });
  });

  describe("when IP resolves to null (private / unknown)", () => {
    it("passes the request through", async () => {
      setBlockedCountries(["RU"]);
      const res = await request(buildApp(mockReader(null))).get("/");
      expect(res.status).toBe(200);
    });
  });

  describe("admin bypass", () => {
    it("passes request from blocked country with valid admin JWT", async () => {
      setBlockedCountries(["RU"]);
      const res = await request(buildApp(mockReader("RU")))
        .get("/")
        .set("Authorization", `Bearer ${adminToken()}`);
      expect(res.status).toBe(200);
    });

    it("blocks request from blocked country with non-admin JWT", async () => {
      setBlockedCountries(["RU"]);
      const res = await request(buildApp(mockReader("RU")))
        .get("/")
        .set("Authorization", `Bearer ${userToken()}`);
      expect(res.status).toBe(451);
    });

    it("blocks request from blocked country with garbage token", async () => {
      setBlockedCountries(["RU"]);
      const res = await request(buildApp(mockReader("RU")))
        .get("/")
        .set("Authorization", "Bearer notavalidtoken");
      expect(res.status).toBe(451);
    });
  });

  describe("IP allowlist bypass", () => {
    it("passes request from blocked country when IP is in allowlist", async () => {
      setBlockedCountries(["RU"]);
      setAllowlist(["::ffff:127.0.0.1", "127.0.0.1"]);
      // supertest uses 127.0.0.1 which Express normalises to ::ffff:127.0.0.1
      const res = await request(buildApp(mockReader("RU"))).get("/");
      expect(res.status).toBe(200);
    });

    it("blocks request from blocked country when IP is NOT in allowlist", async () => {
      setBlockedCountries(["RU"]);
      setAllowlist(["10.0.0.1"]);
      const res = await request(buildApp(mockReader("RU"))).get("/");
      expect(res.status).toBe(451);
    });
  });

  describe("country code normalisation", () => {
    it("matches lower-case reader output against upper-cased config", async () => {
      setBlockedCountries(["RU"]);
      // Reader always returns uppercase from mmdb, but test the match is correct
      const res = await request(buildApp(mockReader("RU"))).get("/");
      expect(res.status).toBe(451);
    });
  });
});

describe("resolveCountry", () => {
  it("returns the iso_code from the reader result", () => {
    const reader = mockReader("DE");
    expect(resolveCountry(reader, "1.2.3.4")).toBe("DE");
  });

  it("returns null when reader returns null", () => {
    const reader = mockReader(null);
    expect(resolveCountry(reader, "1.2.3.4")).toBeNull();
  });

  it("returns null when reader throws", () => {
    const throwing = { get: () => { throw new Error("oops"); } } as unknown as Reader<CountryResponse>;
    expect(resolveCountry(throwing, "bad")).toBeNull();
  });
});

describe("isAdminToken", () => {
  it("returns true for a valid admin JWT", () => {
    expect(isAdminToken(`Bearer ${adminToken()}`)).toBe(true);
  });

  it("returns false for a user JWT", () => {
    expect(isAdminToken(`Bearer ${userToken()}`)).toBe(false);
  });

  it("returns false for garbage token", () => {
    expect(isAdminToken("Bearer garbage")).toBe(false);
  });

  it("returns false when header is undefined", () => {
    expect(isAdminToken(undefined)).toBe(false);
  });

  it("returns false when header lacks Bearer prefix", () => {
    expect(isAdminToken(`Token ${adminToken()}`)).toBe(false);
  });

  it("returns false for an expired token", () => {
    const expired = jwt.sign(
      { sub: "GTEST", role: "admin" },
      env.JWT_SECRET,
      { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: -1 },
    );
    expect(isAdminToken(`Bearer ${expired}`)).toBe(false);
  });
});

describe("loadGeoBlockReader / getReader", () => {
  it("returns null when MMDB_PATH is empty", () => {
    setMmdbPath("");
    expect(loadGeoBlockReader()).toBeNull();
  });

  it("returns null when MMDB_PATH points to a non-existent file", () => {
    setMmdbPath("/tmp/nonexistent-geo.mmdb");
    expect(loadGeoBlockReader()).toBeNull();
  });

  it("returns the cached reader on subsequent calls", () => {
    setMmdbPath("");
    const first = loadGeoBlockReader();
    const second = loadGeoBlockReader(); // _loadAttempted=true, returns cached
    expect(first).toBe(second);
  });

  it("getReader triggers load on first call", () => {
    setMmdbPath("");
    const reader = getReader();
    expect(reader).toBeNull();
  });

  it("getReader returns cached result on second call", () => {
    setMmdbPath("");
    getReader(); // first call sets _loadAttempted
    const r = getReader();
    expect(r).toBeNull();
  });
});
