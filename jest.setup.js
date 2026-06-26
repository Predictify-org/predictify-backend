process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/predictify_test";
process.env.JWT_SECRET = "test-jwt-secret-that-is-at-least-32-chars!!";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "TEST_CONTRACT_ID";
