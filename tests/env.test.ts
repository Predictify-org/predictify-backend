const mockPinoWarn = jest.fn();
jest.mock("pino", () => jest.fn(() => ({ warn: mockPinoWarn })));

const BASE_ENV = {
  DATABASE_URL: "postgres://localhost:5432/test",
  JWT_SECRET: "x".repeat(32),
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  PREDICTIFY_CONTRACT_ID: "C123",
};

function setEnv(overrides: Record<string, string>): void {
  delete process.env.NODE_ENV;
  delete process.env.JWT_TTL_SECONDS;
  delete process.env.WORKER_HEARTBEAT_SECONDS;
  Object.assign(process.env, BASE_ENV, overrides);
}

function loadEnv(): typeof import("../src/config/env") {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../src/config/env");
}

beforeEach(() => {
  mockPinoWarn.mockClear();
  setEnv({});
});

afterAll(() => {
  delete process.env.DATABASE_URL;
  delete process.env.JWT_SECRET;
  delete process.env.SOROBAN_RPC_URL;
  delete process.env.HORIZON_URL;
  delete process.env.PREDICTIFY_CONTRACT_ID;
  delete process.env.JWT_TTL_SECONDS;
  delete process.env.WORKER_HEARTBEAT_SECONDS;
});

describe("env schema", () => {
  describe("defaults", () => {
    it("uses default JWT_TTL_SECONDS when not set", () => {
      setEnv({});
      const { env } = loadEnv();
      expect(env.JWT_TTL_SECONDS).toBe(3600);
    });

    it("uses default WORKER_HEARTBEAT_SECONDS when not set", () => {
      setEnv({});
      const { env } = loadEnv();
      expect(env.WORKER_HEARTBEAT_SECONDS).toBe(30);
    });
  });

  describe("JWT_TTL validation", () => {
    it("accepts JWT_TTL >= WORKER_HEARTBEAT * 2", () => {
      setEnv({ JWT_TTL_SECONDS: "120", WORKER_HEARTBEAT_SECONDS: "30" });
      expect(() => loadEnv()).not.toThrow();
    });

    it("rejects JWT_TTL < WORKER_HEARTBEAT * 2", () => {
      setEnv({ JWT_TTL_SECONDS: "50", WORKER_HEARTBEAT_SECONDS: "30" });
      expect(() => loadEnv()).toThrow(
        "JWT_TTL_SECONDS (50) must be at least WORKER_HEARTBEAT_SECONDS * 2 (60)"
      );
    });

    it("accepts JWT_TTL exactly at 2x heartbeat (boundary)", () => {
      setEnv({ JWT_TTL_SECONDS: "60", WORKER_HEARTBEAT_SECONDS: "30" });
      expect(() => loadEnv()).not.toThrow();
    });

    it("accepts JWT_TTL just above 2x heartbeat", () => {
      setEnv({ JWT_TTL_SECONDS: "61", WORKER_HEARTBEAT_SECONDS: "30" });
      expect(() => loadEnv()).not.toThrow();
    });
  });

  describe("error message", () => {
    it("includes actual and expected values", () => {
      setEnv({ JWT_TTL_SECONDS: "5", WORKER_HEARTBEAT_SECONDS: "10" });
      expect(() => loadEnv()).toThrow(
        "JWT_TTL_SECONDS (5) must be at least WORKER_HEARTBEAT_SECONDS * 2 (20)"
      );
    });
  });

  describe("warning log", () => {
    it("logs warning when TTL is within 10% of minimum", () => {
      setEnv({ JWT_TTL_SECONDS: "65", WORKER_HEARTBEAT_SECONDS: "30" });
      loadEnv();
      expect(mockPinoWarn).toHaveBeenCalledTimes(1);
    });

    it("does not log warning when TTL is >= 110% of minimum", () => {
      setEnv({ JWT_TTL_SECONDS: "66", WORKER_HEARTBEAT_SECONDS: "30" });
      loadEnv();
      expect(mockPinoWarn).not.toHaveBeenCalled();
    });

    it("logs warning with the correct metadata", () => {
      setEnv({ JWT_TTL_SECONDS: "62", WORKER_HEARTBEAT_SECONDS: "30" });
      loadEnv();
      expect(mockPinoWarn).toHaveBeenCalledWith(
        { JWT_TTL_SECONDS: 62, minimumRecommended: 60 },
        expect.stringContaining("within 10%")
      );
    });

    it("does not log warning at exactly 110% threshold", () => {
      setEnv({ JWT_TTL_SECONDS: "66", WORKER_HEARTBEAT_SECONDS: "30" });
      loadEnv();
      expect(mockPinoWarn).not.toHaveBeenCalled();
    });
  });

  describe("boolean env coercion & schedule validation (#982)", () => {
    afterEach(() => {
      delete process.env.RECONCILIATION_ENABLED;
      delete process.env.TRUST_PROXY;
      delete process.env.SLOW_QUERY_ALERTER_ENABLED;
      delete process.env.RECONCILIATION_SCHEDULE;
    });

    it("Row 8: parses RECONCILIATION_ENABLED=false as false", () => {
      setEnv({ RECONCILIATION_ENABLED: "false" });
      const { env } = loadEnv();
      expect(env.RECONCILIATION_ENABLED).toBe(false);
    });

    it("accepts true/false/1/0/yes/no case-insensitively across boolean flags", () => {
      setEnv({
        RECONCILIATION_ENABLED: "YES",
        TRUST_PROXY: "0",
        SLOW_QUERY_ALERTER_ENABLED: "No",
      });
      const { env } = loadEnv();
      expect(env.RECONCILIATION_ENABLED).toBe(true);
      expect(env.TRUST_PROXY).toBe(false);
      expect(env.SLOW_QUERY_ALERTER_ENABLED).toBe(false);

      setEnv({
        RECONCILIATION_ENABLED: "1",
        TRUST_PROXY: "True",
        SLOW_QUERY_ALERTER_ENABLED: "FALSE",
      });
      const { env: env2 } = loadEnv();
      expect(env2.RECONCILIATION_ENABLED).toBe(true);
      expect(env2.TRUST_PROXY).toBe(true);
      expect(env2.SLOW_QUERY_ALERTER_ENABLED).toBe(false);
    });

    it("Row 9: rejects TRUST_PROXY=maybe and invalid RECONCILIATION_SCHEDULE", () => {
      const { envSchema } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../src/config/env-schema") as typeof import("../src/config/env-schema");
      expect(
        envSchema.safeParse({ ...BASE_ENV, TRUST_PROXY: "maybe" }).success,
      ).toBe(false);
      expect(
        envSchema.safeParse({
          ...BASE_ENV,
          RECONCILIATION_SCHEDULE: "61 * * * *",
        }).success,
      ).toBe(false);
      expect(
        envSchema.safeParse({
          ...BASE_ENV,
          RECONCILIATION_SCHEDULE: "*/15 * * * *",
        }).success,
      ).toBe(true);
    });
  });
});
