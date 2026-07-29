/**
 * Tests for src/services/jwtService.ts — the centralized sign/verify layer
 * backed by the key ring (src/utils/keyRing.ts).
 *
 * Env vars (including JWT_KEYS / JWT_ACTIVE_KID) must be set before env.ts
 * and keyRing.ts are imported, so this file sets them up-front and uses
 * jest.resetModules() to get a fresh keyRing/jwtService per scenario —
 * the same pattern used by tests/env.test.ts and tests/keyRing.test.ts.
 */
import jwt from "jsonwebtoken";

const SECRET = "x".repeat(32);
const NEXT_SECRET = "y".repeat(40);
const ISSUER = "predictify";
const AUDIENCE = "predictify-app";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost:5432/test",
  JWT_SECRET: SECRET,
  JWT_ISSUER: ISSUER,
  JWT_AUDIENCE: AUDIENCE,
  JWT_TTL_SECONDS: "3600",
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

function loadJwtService(): typeof import("../src/services/jwtService") {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../src/services/jwtService");
}

/**
 * Asserts `fn` throws an error with the given jsonwebtoken `.name`.
 *
 * jest.resetModules() (used by loadJwtService) gives jwtService its own
 * `jsonwebtoken` module instance, so the `JsonWebTokenError` class it throws
 * is a different object identity than the one imported at the top of this
 * file — `toThrow(jwt.JsonWebTokenError)` would always report a (spurious)
 * mismatch. `.name` is a plain string set by the constructor and stays
 * stable across module instances, so check that instead — the same
 * discriminator src/middleware/requireAuth.ts itself relies on.
 */
function expectThrowsNamed(fn: () => unknown, name: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as Error).name).toBe(name);
    return;
  }
  throw new Error(`Expected function to throw "${name}", but it did not throw`);
}

afterAll(() => {
  delete process.env.JWT_KEYS;
  delete process.env.JWT_ACTIVE_KID;
});

describe("signAccessToken", () => {
  it("signs with the default key and embeds kid='default' when no rotation is configured", () => {
    setEnv({});
    const { signAccessToken } = loadJwtService();

    const token = signAccessToken({ sub: "GUSER" });
    const decoded = jwt.decode(token, { complete: true });

    expect(decoded?.header.kid).toBe("default");
    expect(decoded?.header.alg).toBe("HS256");

    const payload = jwt.verify(token, SECRET, { issuer: ISSUER, audience: AUDIENCE }) as jwt.JwtPayload;
    expect(payload.sub).toBe("GUSER");
  });

  it("signs with the active rotation key and embeds its kid", () => {
    setEnv({ JWT_KEYS: `2026-01-01:${NEXT_SECRET}`, JWT_ACTIVE_KID: "2026-01-01" });
    const { signAccessToken } = loadJwtService();

    const token = signAccessToken({ sub: "GUSER" });
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.kid).toBe("2026-01-01");

    // Verifying with the OLD secret must fail — proves it signed with the new one.
    expectThrowsNamed(() => jwt.verify(token, SECRET), "JsonWebTokenError");
    const payload = jwt.verify(token, NEXT_SECRET, { issuer: ISSUER, audience: AUDIENCE }) as jwt.JwtPayload;
    expect(payload.sub).toBe("GUSER");
  });

  it("carries arbitrary extra claims through to the payload", () => {
    setEnv({});
    const { signAccessToken } = loadJwtService();
    const token = signAccessToken({ sub: "GUSER", stellarAddress: "GUSER", role: "admin" });
    const payload = jwt.verify(token, SECRET) as jwt.JwtPayload;
    expect(payload.stellarAddress).toBe("GUSER");
    expect(payload.role).toBe("admin");
  });
});

describe("verifyAccessToken", () => {
  it("verifies a token signed by signAccessToken with the default key", () => {
    setEnv({});
    const { signAccessToken, verifyAccessToken } = loadJwtService();
    const token = signAccessToken({ sub: "GUSER" });
    expect(verifyAccessToken(token).sub).toBe("GUSER");
  });

  it("verifies a token signed with the currently active rotation key", () => {
    setEnv({ JWT_KEYS: `2026-01-01:${NEXT_SECRET}`, JWT_ACTIVE_KID: "2026-01-01" });
    const { signAccessToken, verifyAccessToken } = loadJwtService();
    const token = signAccessToken({ sub: "GUSER" });
    expect(verifyAccessToken(token).sub).toBe("GUSER");
  });

  it("still verifies a token signed under a now-retired key (rotation doesn't invalidate it)", () => {
    // "default" (JWT_SECRET) is retired in favor of the new active kid, but a
    // token issued before the rotation must keep verifying until it expires.
    setEnv({ JWT_KEYS: `2026-01-01:${NEXT_SECRET}`, JWT_ACTIVE_KID: "2026-01-01" });
    const { verifyAccessToken } = loadJwtService();

    const legacyToken = jwt.sign({ sub: "GUSER" }, SECRET, {
      algorithm: "HS256",
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: 3600,
      keyid: "default",
    });

    expect(verifyAccessToken(legacyToken).sub).toBe("GUSER");
  });

  it("falls back to the default key for tokens with no kid header (pre-rotation tokens)", () => {
    setEnv({ JWT_KEYS: `2026-01-01:${NEXT_SECRET}`, JWT_ACTIVE_KID: "2026-01-01" });
    const { verifyAccessToken } = loadJwtService();

    const noKidToken = jwt.sign({ sub: "GUSER" }, SECRET, {
      algorithm: "HS256",
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: 3600,
    });
    expect(jwt.decode(noKidToken, { complete: true })?.header.kid).toBeUndefined();

    expect(verifyAccessToken(noKidToken).sub).toBe("GUSER");
  });

  it("throws JsonWebTokenError for a token naming an unrecognized kid", () => {
    setEnv({});
    const { verifyAccessToken } = loadJwtService();

    const forged = jwt.sign({ sub: "GUSER" }, "some-other-32-character-secret!!", {
      algorithm: "HS256",
      issuer: ISSUER,
      audience: AUDIENCE,
      keyid: "kid-that-was-never-loaded",
    });

    expectThrowsNamed(() => verifyAccessToken(forged), "JsonWebTokenError");
  });

  it("throws TokenExpiredError for an expired token", () => {
    setEnv({});
    const { signAccessToken, verifyAccessToken } = loadJwtService();
    const token = signAccessToken({ sub: "GUSER" }, { expiresIn: -1 });
    expectThrowsNamed(() => verifyAccessToken(token), "TokenExpiredError");
  });

  it("throws JsonWebTokenError for a tampered signature", () => {
    setEnv({});
    const { signAccessToken, verifyAccessToken } = loadJwtService();
    const token = signAccessToken({ sub: "GUSER" });
    const tampered = token.slice(0, -2) + (token.slice(-2) === "AA" ? "BB" : "AA");
    expectThrowsNamed(() => verifyAccessToken(tampered), "JsonWebTokenError");
  });

  it("throws JsonWebTokenError for the wrong issuer", () => {
    setEnv({});
    const { verifyAccessToken } = loadJwtService();
    const token = jwt.sign({ sub: "GUSER" }, SECRET, {
      algorithm: "HS256",
      issuer: "someone-else",
      audience: AUDIENCE,
      keyid: "default",
    });
    expectThrowsNamed(() => verifyAccessToken(token), "JsonWebTokenError");
  });

  it("throws JsonWebTokenError for the wrong audience", () => {
    setEnv({});
    const { verifyAccessToken } = loadJwtService();
    const token = jwt.sign({ sub: "GUSER" }, SECRET, {
      algorithm: "HS256",
      issuer: ISSUER,
      audience: "someone-elses-app",
      keyid: "default",
    });
    expectThrowsNamed(() => verifyAccessToken(token), "JsonWebTokenError");
  });

  it("throws JsonWebTokenError for a malformed token string", () => {
    setEnv({});
    const { verifyAccessToken } = loadJwtService();
    expectThrowsNamed(() => verifyAccessToken("not.a.jwt"), "JsonWebTokenError");
  });
});
