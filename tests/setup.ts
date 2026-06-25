/**
 * Jest global setup — inject stub environment variables so src/config/env.ts
 * validates successfully without a real .env file during tests.
 */
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/predictify_test";
process.env.JWT_SECRET ??= "test-secret-that-is-at-least-32-chars-longXX";
process.env.SOROBAN_RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL ??= "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID ??= "CTESTCONTRACT000000000000000000000000000000000000000000000";
