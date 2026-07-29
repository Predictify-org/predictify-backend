import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONTAINER_INFO_PATH = path.join(__dirname, ".container-info.json");

function loadContainerInfo(): { connectionString: string; containerId: string } | null {
  try {
    return JSON.parse(fs.readFileSync(CONTAINER_INFO_PATH, "utf-8"));
  } catch {
    return null;
  }
}

const info = loadContainerInfo();
if (info) {
  process.env.DATABASE_URL = `${info.connectionString}?sslmode=disable`;
}

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-integration-jwt-secret-at-least-32-chars!!";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.PREDICTIFY_CONTRACT_ID = "CTEST0000000000000000000000000000000000000000000000000000";
process.env.PG_POOL_MAX = "10";
process.env.PG_STATEMENT_TIMEOUT_MS = "5000";
process.env.LOG_LEVEL = "silent";
