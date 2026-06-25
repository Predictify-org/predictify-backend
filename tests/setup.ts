// Provide the minimum env vars needed for test suites that import src/config/env.ts.
// Values are only applied when not already set (e.g. by a CI system).
const defaults: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/predictify_test",
  JWT_SECRET: "test-jwt-secret-that-is-at-least-32-characters-long",
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  PREDICTIFY_CONTRACT_ID: "CTEST_CONTRACT_ID",
  INDEXER_REWIND_LEDGERS: "100",
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
