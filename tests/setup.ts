/**
 * Jest global setup — runs before every test file.
 *
 * Sets the minimum required environment variables so that `src/config/env.ts`
 * (a Zod schema.parse at module load time) does not throw during tests.
 * Real integration tests should override these with actual values or use a
 * dedicated .env.test file loaded via a custom jest resolver.
 */

// Only set variables that are absent so real values in the shell take precedence.
const defaults: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/predictify_test",
  JWT_SECRET: "test-secret-at-least-32-characters-long",
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  PREDICTIFY_CONTRACT_ID: "CTEST",
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
