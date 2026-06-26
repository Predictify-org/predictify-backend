// Set dummy environment variables for tests so that config/env.ts parses successfully
process.env.NODE_ENV = "test";
process.env.PORT = "3001";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify_test";
process.env.JWT_SECRET = "test-secret-with-at-least-32-characters";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CABCDEF1234567890";

/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // Run before every test file to populate required process.env variables.
  setupFiles: ["./tests/setup.ts"],
  testMatch: ["**/tests/**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/setup.ts"],
  collectCoverageFrom: ["src/**/*.ts"],
  coverageDirectory: "coverage",
  setupFiles: ["./jest.setup.js"],
};
