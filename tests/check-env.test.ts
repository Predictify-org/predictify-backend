import { envSchema, formatEnvErrors } from "../src/config/env-schema";

const VALID_ENV = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/predictify",
  JWT_SECRET: "a-secret-that-is-at-least-32-chars-long",
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  PREDICTIFY_CONTRACT_ID: "CABC123",
};

describe("envSchema", () => {
  it("accepts a complete valid config", () => {
    expect(envSchema.safeParse(VALID_ENV).success).toBe(true);
  });

  it("applies defaults for optional keys", () => {
    const result = envSchema.safeParse(VALID_ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3001);
      expect(result.data.NODE_ENV).toBe("development");
      expect(result.data.LOG_LEVEL).toBe("info");
      expect(result.data.STELLAR_NETWORK).toBe("testnet");
      expect(result.data.JWT_ISSUER).toBe("predictify");
      expect(result.data.JWT_AUDIENCE).toBe("predictify-app");
      expect(result.data.JWT_TTL_SECONDS).toBe(3600);
      expect(result.data.INDEXER_POLL_INTERVAL_MS).toBe(5000);
      expect(result.data.INDEXER_START_LEDGER).toBe(0);
    }
  });

  it("coerces PORT from string to number", () => {
    const result = envSchema.safeParse({ ...VALID_ENV, PORT: "8080" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.PORT).toBe(8080);
  });

  it("rejects missing DATABASE_URL", () => {
    const { DATABASE_URL: _omit, ...rest } = VALID_ENV;
    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing SOROBAN_RPC_URL", () => {
    const { SOROBAN_RPC_URL: _omit, ...rest } = VALID_ENV;
    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing HORIZON_URL", () => {
    const { HORIZON_URL: _omit, ...rest } = VALID_ENV;
    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing PREDICTIFY_CONTRACT_ID", () => {
    const { PREDICTIFY_CONTRACT_ID: _omit, ...rest } = VALID_ENV;
    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects JWT_SECRET shorter than 32 characters", () => {
    const result = envSchema.safeParse({ ...VALID_ENV, JWT_SECRET: "too-short" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid NODE_ENV value", () => {
    const result = envSchema.safeParse({ ...VALID_ENV, NODE_ENV: "staging" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid LOG_LEVEL value", () => {
    const result = envSchema.safeParse({ ...VALID_ENV, LOG_LEVEL: "verbose" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-URL DATABASE_URL", () => {
    const result = envSchema.safeParse({ ...VALID_ENV, DATABASE_URL: "not-a-url" });
    expect(result.success).toBe(false);
  });
});

describe("formatEnvErrors", () => {
  it("lists each failing field with a bullet", () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = formatEnvErrors(result.error);
      expect(msg).toContain("•");
      expect(msg).toContain("DATABASE_URL");
      expect(msg).toContain("JWT_SECRET");
      expect(msg).toContain("SOROBAN_RPC_URL");
      expect(msg).toContain("HORIZON_URL");
      expect(msg).toContain("PREDICTIFY_CONTRACT_ID");
    }
  });

  it("returns one line per issue", () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const lines = formatEnvErrors(result.error)
        .split("\n")
        .filter((l) => l.trim());
      expect(lines.length).toBeGreaterThanOrEqual(5);
    }
  });
});
