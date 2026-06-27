import { z } from "zod";

export const envSchema = z.object({
  // ── Application ───────────────────────────────────────────
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // ── Database ──────────────────────────────────────────────
  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // ── JWT ───────────────────────────────────────────────────
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default("predictify"),
  JWT_AUDIENCE: z.string().default("predictify-app"),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // ── Stellar / Soroban ─────────────────────────────────────
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  SOROBAN_RPC_URL: z.string().url(),
  HORIZON_URL: z.string().url(),
  PREDICTIFY_CONTRACT_ID: z.string().min(1),

  // ── Indexer tunables ──────────────────────────────────────
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  INDEXER_REWIND_LEDGERS: z.coerce.number().int().positive().default(100),

  // ── Observability ─────────────────────────────────────────
  METRICS_AUTH_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function formatEnvErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  • ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}
