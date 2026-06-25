import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const DRIZZLE_DIR = resolve(ROOT, "drizzle");
const JOURNAL = resolve(DRIZZLE_DIR, "meta", "_journal.json");

/** Snapshot of all file paths (relative to drizzle/) before generating. */
function snapshotFiles(): Set<string> {
  if (!existsSync(DRIZZLE_DIR)) return new Set();
  return new Set(readdirSync(DRIZZLE_DIR, { recursive: true }).map(String));
}

/** Remove any file that was NOT present in the pre-generate snapshot. */
function removeNewFiles(before: Set<string>): void {
  for (const f of readdirSync(DRIZZLE_DIR, { recursive: true }).map(String)) {
    if (!before.has(f)) rmSync(resolve(DRIZZLE_DIR, f));
  }
}

/** Remove empty subdirectories left behind in drizzle/. */
function removeEmptyDirs(): void {
  for (const dir of [resolve(DRIZZLE_DIR, "meta"), DRIZZLE_DIR]) {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir);
  }
}

function main(): void {
  process.chdir(ROOT);

  const beforeFiles = snapshotFiles();
  const beforeJournal = existsSync(JOURNAL) ? readFileSync(JOURNAL, "utf-8") : null;

  try {
    execSync("npx drizzle-kit generate", { stdio: "pipe", encoding: "utf-8" });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString();
    console.error("drizzle-kit generate failed:", stderr ?? (err as Error).message);
    process.exit(1);
  }

  const afterJournal = existsSync(JOURNAL) ? readFileSync(JOURNAL, "utf-8") : null;
  const drifted = afterJournal !== beforeJournal;

  // Restore drizzle/ to pre-generate state
  removeNewFiles(beforeFiles);
  if (drifted && beforeJournal !== null) writeFileSync(JOURNAL, beforeJournal);
  removeEmptyDirs();

  if (drifted) {
    console.error("Schema drift detected!");
    console.error("The Drizzle schema has changed but no migration covers it.");
    console.error("Run `npm run db:generate`, review the new migration, and commit it.");
    process.exit(1);
  }

  console.log("No schema drift — all schema changes have matching migrations.");
}

main();
