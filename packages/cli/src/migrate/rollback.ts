import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDbName } from "./generate.js";

function loadMigrationFile(path: string) {
  const src = readFileSync(path, "utf-8");
  const nameMatch = src.match(/name:\s*"([^"]+)"/);
  const downMatch = src.match(/down:\s*`([^`]*)`/s);
  if (!nameMatch || !downMatch) throw new Error(`Invalid migration file: ${path}`);
  return { name: nameMatch[1], down: downMatch[1].trim() };
}

function getLastApplied(dbName: string): string | null {
  try {
    const result = execSync(
      `npx wrangler d1 execute ${dbName} --command "SELECT name FROM edgplay_migrations ORDER BY id DESC LIMIT 1" --json`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const rows = JSON.parse(result) as Array<{ results: Array<{ name: string }> }>;
    return rows[0]?.results[0]?.name ?? null;
  } catch {
    return null;
  }
}

function runSql(dbName: string, sql: string): void {
  const escaped = sql.replace(/'/g, "'\\''");
  execSync(`npx wrangler d1 execute ${dbName} --command '${escaped}'`, { stdio: "inherit" });
}

export async function rollback(_args: string[]): Promise<void> {
  const dbName = getDbName();
  const last   = getLastApplied(dbName);

  if (!last) {
    console.log("Nothing to roll back — no migrations have been applied.");
    return;
  }

  const dir      = join(process.cwd(), "migrations");
  const filename = `${dir}/${last}.ts`;

  if (!existsSync(filename)) {
    console.error(`❌  Migration file not found: ${filename}`);
    process.exit(1);
  }

  const migration = loadMigrationFile(filename);
  console.log(`Rolling back: ${migration.name}\n`);

  if (migration.down) runSql(dbName, migration.down);

  runSql(dbName, `DELETE FROM edgplay_migrations WHERE name = '${migration.name}'`);

  console.log(`\n✅  Rolled back: ${migration.name}`);
}
