  
  
/* eslint-disable @typescript-eslint/no-explicit-any */ 
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env";
import { logger } from "../config/logger";
import * as schema from "./schema";

const url = new URL(env.DATABASE_URL);
url.searchParams.set("statement_timeout", String(env.PG_STATEMENT_TIMEOUT_MS));

export const pool = new Pool({
  connectionString: url.toString(),
  max: env.PG_POOL_MAX,
});

if (typeof pool.on === "function") {
  pool.on("error", (err) => {
    logger.error({ err }, "Unexpected pool error");
  });
}

export const db = drizzle(pool, { schema });

export type Database = any;
export type DB = typeof db;
export type Db = typeof db;

let overrideDb: any = null;

export function setDbForTests(testDb: any): void {
  overrideDb = testDb;
}

export function getDb(): any {
  return overrideDb ?? db;
}

export function getPool(): Pool {
  return pool;
}

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

export async function connectWithRetry(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await pool.query("SELECT 1");
      logger.info({ attempt }, "Connected to Postgres");
      return;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        logger.fatal({ err, attempt }, "Could not connect to Postgres after max retries");
        throw err;
      }
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.warn({ err, attempt, delay }, "Postgres connection failed, retrying");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function closeDb(): Promise<void> {
  logger.info("Closing Postgres pool");
  await pool.end();
}
