import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDbName } from "./generate.js";

interface Migration {
  name: string;
  up: string;
  down: string;
}

function migrationsDir(): string {
  return join(process.cwd(), "migrations");
}

function loadMigrationFile(path: string): Migration {
  // Use a simple regex extraction to avoid needing ts-node for the migration files
  const src = readFileSync(path, "utf-8");
  const nameMatch = src.match(/name:\s*"([^"]+)"/);
  const upMatch   = src.match(/up:\s*`([^`]*)`/s);
  const downMatch = src.match(/down:\s*`([^`]*)`/s);
  if (!nameMatch || !upMatch || !downMatch) {
    throw new Error(`Invalid migration file: ${path}`);
  }
  return {
    name: nameMatch[1],
    up:   upMatch[1].trim(),
    down: downMatch[1].trim(),
  };
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

function runSql(dbName: string, sql: string): void {
  // Escape single quotes in the SQL command
  const escaped = sql.replace(/'/g, "'\\''");
  execSync(
    `npx wrangler d1 execute ${dbName} --command '${escaped}'`,
    { stdio: "inherit" }
  );
}

export async function apply(_args: string[]): Promise<void> {
  const dbName = getDbName();
  const dir    = migrationsDir();

  if (!existsSync(dir)) {
    console.log("No migrations directory found. Run migrate:generate first.");
    return;
  }

  // Ensure the migrations table exists
  runSql(dbName,
    "CREATE TABLE IF NOT EXISTS edgplay_migrations " +
    "(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, applied_at INTEGER NOT NULL)"
  );

  const applied = getAppliedMigrations(dbName);
  const files   = readdirSync(dir).filter(f => f.endsWith(".ts")).sort();
  const pending = files.filter(f => {
    const migration = loadMigrationFile(join(dir, f));
    return !applied.has(migration.name);
  });

  if (pending.length === 0) {
    console.log("✅  All migrations are already applied.");
    return;
  }

  console.log(`Applying ${pending.length} pending migration(s)…\n`);

  for (const file of pending) {
    const migration = loadMigrationFile(join(dir, file));
    console.log(`  → ${migration.name}`);

    // Apply the migration SQL
    if (migration.up) runSql(dbName, migration.up);

    // Record it
    const now = Date.now();
    runSql(dbName,
      `INSERT INTO edgplay_migrations (name, applied_at) VALUES ('${migration.name}', ${now})`
    );

    console.log(`  ✅  Applied`);
  }

  console.log("\n✅  Done.");
}
