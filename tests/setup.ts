// Minimum env vars required by src/config/env.ts so modules can be imported in tests.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/predictify_test";
process.env.JWT_SECRET = "test-jwt-secret-that-is-at-least-32-chars!";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000000";
process.env.WEBHOOK_CORS_ALLOWED_ORIGINS = "http://localhost:5173,https://admin.predictify.dev";
process.env.MARKETS_CORS_ALLOWED_ORIGINS = "http://localhost:5173,https://app.predictify.dev";
process.env.AUDIT_CORS_ALLOWED_ORIGINS = "http://localhost:5173,https://admin.predictify.dev";
