/**
 * E2E Test Setup
 *
 * This file configures the environment for E2E tests that run against
 * real testnet infrastructure.
 *
 * Environment Variables:
 * - E2E_TEST_SECRET_KEY: Stellar testnet account secret key (required)
 * - SOROBAN_RPC_URL: Testnet RPC endpoint (defaults to public testnet)
 * - HORIZON_URL: Testnet Horizon endpoint (defaults to public testnet)
 * - PREDICTIFY_CONTRACT_ID: Deployed contract ID on testnet (required)
 * - DATABASE_URL: Test database connection string (required)
 */

// Set test environment
process.env.NODE_ENV = "test";

// Default to testnet URLs if not provided
process.env.SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
process.env.STELLAR_NETWORK = "testnet";

// JWT configuration for tests
process.env.JWT_SECRET = process.env.JWT_SECRET || "e2e-test-jwt-secret-that-is-at-least-32-characters-long-for-security";
process.env.JWT_ISSUER = "predictify-e2e-test";
process.env.JWT_AUDIENCE = "predictify-e2e-test-app";

// Database configuration
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required for E2E tests");
}

// Contract configuration
if (!process.env.PREDICTIFY_CONTRACT_ID) {
  console.warn("WARNING: PREDICTIFY_CONTRACT_ID not set. E2E tests may fail.");
  process.env.PREDICTIFY_CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000000";
}

// Redis configuration (optional for E2E)
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Disable rate limiting for E2E tests
process.env.ANON_RATE_LIMIT_MAX = "10000";
process.env.CAPTCHA_THRESHOLD = "0"; // Disable captcha for E2E

// Increase timeouts for testnet operations
jest.setTimeout(120000); // 2 minutes global timeout

export {};
