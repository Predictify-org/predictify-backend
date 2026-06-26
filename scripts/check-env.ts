/**
 * Preflight environment validator.
 *
 * Loads .env (if present), validates every variable against the same zod
 * schema used at runtime, and exits with a readable error list instead of
 * a raw ZodError stack trace.
 *
 * Invoked automatically via the "prestart" / "predev" npm scripts.
 * Run manually:  npx ts-node --transpile-only scripts/check-env.ts
 */
import fs from "fs";
import path from "path";
import { envSchema, formatEnvErrors } from "../src/config/env-schema";

// Minimal .env parser — populates process.env for keys not already set.
// Does not overwrite values injected by the shell / CI.
function loadDotEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    const value = raw.replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function main(): void {
  loadDotEnv(path.resolve(process.cwd(), ".env"));

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("✖  Environment validation failed:\n");
    console.error(formatEnvErrors(result.error));
    console.error("\nCopy .env.example → .env and set the values marked as required.");
    process.exit(1);
  }

  console.log("✓  Environment OK");
}

main();
