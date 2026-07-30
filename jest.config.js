// Set dummy environment variables for tests so that config/env.ts parses successfully
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify_test";
process.env.JWT_SECRET = "test-secret-with-at-least-32-characters";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF1234567890";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.test.json",
        // Disable full type-checking during test runs — tsc in CI handles
        // that separately. This lets ts-jest transpile files that have
        // pre-existing type errors in unrelated modules without blocking
        // the test suite.
        diagnostics: false,
      },
    ],
  },
  setupFiles: ["<rootDir>/tests/setup.ts"],
  moduleNameMapper: {
    // Stub missing/broken modules so the test runner can import src/index.ts
    "^.*/config/redis$": "<rootDir>/src/config/redis.ts",
    "^.*/cache/marketsCache$": "<rootDir>/src/cache/marketsCache.ts",
  },
  testMatch: ["**/tests/**/*.test.ts", "**/src/__tests__/**/*.test.ts"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/index.ts",
  ],
  coverageDirectory: "coverage",
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 90,
      statements: 90,
    },
  },
  // Separate E2E and Testcontainers-backed integration tests from unit tests.
  // Integration tests need the Postgres container started by
  // jest.integration.config.js — run them with `npm run test:integration`.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/",
    "/tests/integration/",
  ],
  // Increase timeout for E2E tests
  testTimeout: 10000, // 10 seconds default, E2E tests override this
  verbose: true,
};