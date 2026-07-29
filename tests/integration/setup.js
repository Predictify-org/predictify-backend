var fs = require("fs");
var path = require("path");

var CONTAINER_INFO_PATH = path.join(__dirname, ".container-info.json");

var info = null;
try {
  info = JSON.parse(fs.readFileSync(CONTAINER_INFO_PATH, "utf-8"));
} catch (e) {
  // container-info.json not found; run globalSetup first
}

if (info && info.connectionString) {
  process.env.DATABASE_URL = info.connectionString;
}

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-integration-jwt-secret-at-least-32-chars!!";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000000";
process.env.PG_POOL_MAX = "10";
process.env.PG_STATEMENT_TIMEOUT_MS = "5000";
process.env.LOG_LEVEL = "error";
