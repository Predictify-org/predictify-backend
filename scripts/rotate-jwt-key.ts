/**
 * JWT key rotation CLI.
 *
 * Manages the JWT_KEYS / JWT_ACTIVE_KID env vars consumed by
 * src/utils/keyRing.ts. Safe, zero-downtime rotation is a three-step
 * process — see docs/jwt-rotation.md for the full runbook:
 *
 *   1. add               — generate a new key, add it to JWT_KEYS (NOT yet
 *                           used for signing). Deploy so every verifier
 *                           knows the new key.
 *   2. activate <kid>     — flip JWT_ACTIVE_KID to the new key. Deploy so
 *                           new tokens are signed with it.
 *   3. remove <kid>       — once JWT_TTL_SECONDS has fully elapsed (so no
 *                           outstanding token still uses the old key),
 *                           delete the retired key. Deploy.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/rotate-jwt-key.ts list
 *   npx ts-node --transpile-only scripts/rotate-jwt-key.ts add [kid]
 *   npx ts-node --transpile-only scripts/rotate-jwt-key.ts activate <kid>
 *   npx ts-node --transpile-only scripts/rotate-jwt-key.ts remove <kid>
 *
 * By default the new state is only printed (paste it into your secrets
 * manager / deployment config). Pass --write to also update a local .env
 * file (handy in development); --file <path> overrides the .env location.
 */
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { DEFAULT_KID, parseJwtKeysEnv, formatJwtKeysEnv, type JwtKey } from "../src/utils/jwtKeyFormat";

const SECRET_BYTES = 32; // 32 bytes -> 64 hex chars, well above the 32-char minimum.

interface ParsedArgs {
  command: string;
  positional: string[];
  write: boolean;
  file: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  let write = false;
  let file = path.resolve(process.cwd(), ".env");

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--write") {
      write = true;
    } else if (arg === "--file") {
      file = path.resolve(process.cwd(), rest[++i] ?? "");
    } else {
      positional.push(arg);
    }
  }

  return { command: command ?? "", positional, write, file };
}

/** Minimal .env loader — same contract as scripts/check-env.ts. */
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

/** Replaces (or appends) a `KEY=value` line in an .env file's contents. */
function setEnvLine(content: string, key: string, value: string): string {
  const linePattern = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (linePattern.test(content)) {
    return content.replace(linePattern, line);
  }
  const withTrailingNewline = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  return `${withTrailingNewline}${line}\n`;
}

function formatJwtKeys(keys: JwtKey[]): string {
  return keys.map((k) => `${k.kid}:${k.secret}`).join(",");
}

function loadCurrentKeys(): JwtKey[] {
  const raw = process.env.JWT_KEYS;
  return raw && raw.trim().length > 0 ? parseJwtKeysEnv(raw) : [];
}

function printResult(jwtKeys: JwtKey[], activeKid: string, args: ParsedArgs): void {
  console.log(`JWT_KEYS=${formatJwtKeys(jwtKeys)}`);
  console.log(`JWT_ACTIVE_KID=${activeKid}`);

  if (args.write) {
    if (!fs.existsSync(args.file)) {
      console.error(`\n--write was passed but ${args.file} does not exist.`);
      process.exit(1);
    }
    let content = fs.readFileSync(args.file, "utf8");
    content = setEnvLine(content, "JWT_KEYS", formatJwtKeys(jwtKeys));
    content = setEnvLine(content, "JWT_ACTIVE_KID", activeKid);
    fs.writeFileSync(args.file, content);
    console.log(`\nWrote updated JWT_KEYS / JWT_ACTIVE_KID to ${args.file}`);
  } else {
    console.log("\n(--write not passed: paste the lines above into your env config and deploy.)");
  }
}

function cmdList(): void {
  const keys = loadCurrentKeys();
  const activeKid = process.env.JWT_ACTIVE_KID?.trim() || DEFAULT_KID;

  console.log(`${DEFAULT_KID}\t(JWT_SECRET)${activeKid === DEFAULT_KID ? "  <- active" : ""}`);
  for (const key of keys) {
    console.log(`${key.kid}\t(JWT_KEYS)${activeKid === key.kid ? "  <- active" : ""}`);
  }
}

function cmdAdd(args: ParsedArgs): void {
  const keys = loadCurrentKeys();
  const taken = new Set([DEFAULT_KID, ...keys.map((k) => k.kid)]);

  let kid = args.positional[0];
  if (kid) {
    if (taken.has(kid)) {
      console.error(`kid "${kid}" already exists`);
      process.exit(1);
    }
  } else {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    kid = today;
    let suffix = 2;
    while (taken.has(kid)) {
      kid = `${today}-${suffix++}`;
    }
  }

  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const updatedKeys = [...keys, { kid, secret }];
  const activeKid = process.env.JWT_ACTIVE_KID?.trim() || DEFAULT_KID;

  console.log(`Added kid "${kid}". JWT_ACTIVE_KID is unchanged (${activeKid}) — deploy this first,`);
  console.log(`then run "activate ${kid}" once every instance has picked up the new key.\n`);
  printResult(updatedKeys, activeKid, args);
}

function cmdActivate(args: ParsedArgs): void {
  const kid = args.positional[0];
  if (!kid) {
    console.error("Usage: rotate-jwt-key activate <kid>");
    process.exit(1);
  }

  const keys = loadCurrentKeys();
  if (kid !== DEFAULT_KID && !keys.some((k) => k.kid === kid)) {
    console.error(`Unknown kid "${kid}". Loaded kids: ${[DEFAULT_KID, ...keys.map((k) => k.kid)].join(", ")}`);
    process.exit(1);
  }

  printResult(keys, kid, args);
}

function cmdRemove(args: ParsedArgs): void {
  const kid = args.positional[0];
  if (!kid) {
    console.error("Usage: rotate-jwt-key remove <kid>");
    process.exit(1);
  }
  if (kid === DEFAULT_KID) {
    console.error(`Cannot remove "${DEFAULT_KID}" — it is tied to JWT_SECRET, not JWT_KEYS.`);
    process.exit(1);
  }

  const activeKid = process.env.JWT_ACTIVE_KID?.trim() || DEFAULT_KID;
  if (kid === activeKid) {
    console.error(`kid "${kid}" is the active signing key — activate a different kid before removing it.`);
    process.exit(1);
  }

  const keys = loadCurrentKeys();
  if (!keys.some((k) => k.kid === kid)) {
    console.error(`Unknown kid "${kid}". Loaded kids: ${[DEFAULT_KID, ...keys.map((k) => k.kid)].join(", ")}`);
    process.exit(1);
  }

  console.log(`Removing kid "${kid}". Only do this once JWT_TTL_SECONDS has fully elapsed since it was`);
  console.log(`deactivated — any token still signed with it will fail verification after this deploys.\n`);
  printResult(keys.filter((k) => k.kid !== kid), activeKid, args);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(args.file);

  switch (args.command) {
    case "list":
      return cmdList();
    case "add":
      return cmdAdd(args);
    case "activate":
      return cmdActivate(args);
    case "remove":
      return cmdRemove(args);
    default:
      console.error("Usage: rotate-jwt-key <list|add|activate|remove> [kid] [--write] [--file <path>]");
      process.exit(1);
  }
}

main();
