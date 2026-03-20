import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDbName } from "./generate.js";

function getMigrationName(path: string): string {
  const src = readFileSync(path, "utf-8");
  const match = src.match(/name:\s*"([^"]+)"/);
  return match?.[1] ?? path;
}

function getAppliedMigrations(dbName: string): Set<string> {
  try {
    const result = execSync(
      `npx wrangler d1 execute ${dbName} --command "SELECT name FROM edgplay_migrations ORDER BY id" --json`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const rows = JSON.parse(result) as Array<{ results: Array<{ name: string }> }>;
    return new Set((rows[0]?.results ?? []).map(r => r.name));
  } catch {
    return new Set();
  }
}

export async function status(_args: string[]): Promise<void> {
  const dbName = getDbName();
  const dir    = join(process.cwd(), "migrations");

  if (!existsSync(dir)) {
    console.log("No migrations directory found.");
    return;
  }

  const applied = getAppliedMigrations(dbName);
  const files   = readdirSync(dir).filter(f => f.endsWith(".ts")).sort();

  if (files.length === 0) {
    console.log("No migration files found.");
    return;
  }

  console.log("\n  Migration status:\n");

  for (const file of files) {
    const name    = getMigrationName(join(dir, file));
    const isApplied = applied.has(name);
    console.log(`  ${isApplied ? "✅" : "⏳"} ${name}`);
  }

  const pending = files.filter(f => !applied.has(getMigrationName(join(dir, f))));
  console.log(`\n  ${applied.size} applied, ${pending.length} pending.\n`);
}
