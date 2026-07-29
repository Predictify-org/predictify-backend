/**
 * Tests for src/utils/keyRing.ts.
 *
 * keyRing builds its ring once per module instance (mirrors env.ts's eager
 * parsing), so each scenario below uses jest.resetModules() + require() —
 * the same pattern tests/env.test.ts uses to exercise different env configs.
 */
const SECRET = "x".repeat(32);
const SECRET_2 = "y".repeat(40);
const SECRET_3 = "z".repeat(40);

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/test",
  JWT_SECRET: SECRET,
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  PREDICTIFY_CONTRACT_ID: "C123",
};

function setEnv(overrides: Record<string, string | undefined>): void {
  delete process.env.JWT_KEYS;
  delete process.env.JWT_ACTIVE_KID;
  Object.assign(process.env, BASE_ENV);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function loadKeyRing(): typeof import("../src/utils/keyRing") {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../src/utils/keyRing");
}

afterAll(() => {
  delete process.env.JWT_KEYS;
  delete process.env.JWT_ACTIVE_KID;
});

describe("keyRing", () => {
  describe("default-only (no JWT_KEYS / JWT_ACTIVE_KID)", () => {
    it("loads JWT_SECRET as the single 'default' key", () => {
      setEnv({});
      const { listKids, getActiveKid, getSigningKey, getVerificationKey, DEFAULT_KID } = loadKeyRing();

      expect(listKids()).toEqual([DEFAULT_KID]);
      expect(getActiveKid()).toBe(DEFAULT_KID);
      expect(getSigningKey()).toEqual({ kid: DEFAULT_KID, secret: SECRET });
      expect(getVerificationKey(DEFAULT_KID)).toEqual({ kid: DEFAULT_KID, secret: SECRET });
    });

    it("falls back to the default key when kid is undefined (legacy tokens)", () => {
      setEnv({});
      const { getVerificationKey, DEFAULT_KID } = loadKeyRing();
      expect(getVerificationKey(undefined)).toEqual({ kid: DEFAULT_KID, secret: SECRET });
    });

    it("returns undefined for an unknown kid", () => {
      setEnv({});
      const { getVerificationKey } = loadKeyRing();
      expect(getVerificationKey("nope")).toBeUndefined();
    });
  });

  describe("JWT_KEYS adds rotation keys", () => {
    it("loads additional keys alongside the default", () => {
      setEnv({ JWT_KEYS: `2026-01-01:${SECRET_2},2025-12-01:${SECRET_3}` });
      const { listKids, DEFAULT_KID } = loadKeyRing();
      expect(listKids()).toEqual([DEFAULT_KID, "2026-01-01", "2025-12-01"]);
    });

    it("looks up a non-default key by kid", () => {
      setEnv({ JWT_KEYS: `2026-01-01:${SECRET_2}` });
      const { getVerificationKey } = loadKeyRing();
      expect(getVerificationKey("2026-01-01")).toEqual({ kid: "2026-01-01", secret: SECRET_2 });
    });

    it("throws when JWT_KEYS reuses the reserved 'default' kid", () => {
      setEnv({ JWT_KEYS: `default:${SECRET_2}` });
      expect(() => loadKeyRing()).toThrow(/Duplicate kid "default"/);
    });

    it("throws when JWT_KEYS has two entries with the same kid", () => {
      setEnv({ JWT_KEYS: `dup:${SECRET_2},dup:${SECRET_3}` });
      expect(() => loadKeyRing()).toThrow(/Duplicate kid "dup"/);
    });

    it("propagates malformed JWT_KEYS parse errors", () => {
      setEnv({ JWT_KEYS: "not-kid-secret-format" });
      expect(() => loadKeyRing()).toThrow(/"kid:secret" format/);
    });

    it("treats a blank JWT_KEYS the same as unset", () => {
      setEnv({ JWT_KEYS: "   " });
      const { listKids, DEFAULT_KID } = loadKeyRing();
      expect(listKids()).toEqual([DEFAULT_KID]);
    });
  });

  describe("JWT_ACTIVE_KID", () => {
    it("signs with the key named by JWT_ACTIVE_KID", () => {
      setEnv({ JWT_KEYS: `2026-01-01:${SECRET_2}`, JWT_ACTIVE_KID: "2026-01-01" });
      const { getSigningKey, getActiveKid } = loadKeyRing();
      expect(getActiveKid()).toBe("2026-01-01");
      expect(getSigningKey()).toEqual({ kid: "2026-01-01", secret: SECRET_2 });
    });

    it("defaults to the 'default' kid when unset", () => {
      setEnv({ JWT_KEYS: `2026-01-01:${SECRET_2}` });
      const { getActiveKid, DEFAULT_KID } = loadKeyRing();
      expect(getActiveKid()).toBe(DEFAULT_KID);
    });

    it("throws at load time when JWT_ACTIVE_KID names an unknown kid", () => {
      setEnv({ JWT_KEYS: `2026-01-01:${SECRET_2}`, JWT_ACTIVE_KID: "does-not-exist" });
      expect(() => loadKeyRing()).toThrow(/JWT_ACTIVE_KID "does-not-exist" does not match/);
    });

    it("verification still accepts a retired (non-active) key", () => {
      setEnv({ JWT_KEYS: `2026-01-01:${SECRET_2}`, JWT_ACTIVE_KID: "2026-01-01" });
      const { getVerificationKey, DEFAULT_KID } = loadKeyRing();
      // "default" (JWT_SECRET) is retired once a newer kid is activated,
      // but must still verify tokens issued before the rotation.
      expect(getVerificationKey(DEFAULT_KID)).toEqual({ kid: DEFAULT_KID, secret: SECRET });
    });
  });

  describe("memoization", () => {
    it("builds the ring once per module instance", () => {
      setEnv({});
      const { getKeyRing } = loadKeyRing();
      expect(getKeyRing()).toBe(getKeyRing());
    });
  });
});
