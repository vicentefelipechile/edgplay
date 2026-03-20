import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ColumnDef {
  name: string;
  sqlType: "TEXT" | "INTEGER" | "REAL";
  nullable: boolean;
  defaultValue?: string;
  check?: string;
}

// ─── File helpers ─────────────────────────────────────────────────────────────

export function migrationsDir(): string {
  const dir = join(process.cwd(), "migrations");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function nextMigrationNumber(dir: string): string {
  const files = readdirSync(dir).filter(f => f.endsWith(".ts")).sort();
  const last = files.at(-1);
  const num = last ? parseInt(last.slice(0, 4)) + 1 : 1;
  return String(num).padStart(4, "0");
}

export function getDbName(): string {
  const wranglerPath = join(process.cwd(), "wrangler.jsonc");
  if (!existsSync(wranglerPath)) {
    console.error("❌  wrangler.jsonc not found. Run from the project root.");
    process.exit(1);
  }
  const raw = readFileSync(wranglerPath, "utf-8")
    .replace(/\/\/.*$/gm, "")
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]");
  const config = JSON.parse(raw) as { d1_databases?: Array<{ binding: string; database_name: string }> };
  const db = config.d1_databases?.find(d => d.binding === "DB");
  if (!db) {
    console.error("❌  No D1 binding named 'DB' found in wrangler.jsonc.");
    process.exit(1);
  }
  return db.database_name;
}

export function columnToSql(col: ColumnDef): string {
  let sql = `${col.name} ${col.sqlType}`;
  if (!col.nullable) sql += " NOT NULL";
  if (col.defaultValue !== undefined) sql += ` DEFAULT ${col.defaultValue}`;
  if (col.check) sql += ` CHECK(${col.check})`;
  return sql;
}

// ─── D1 introspection ─────────────────────────────────────────────────────────

export function getD1Columns(dbName: string): ColumnDef[] {
  try {
    const result = execSync(
      `npx wrangler d1 execute ${dbName} --command "PRAGMA table_info(edgplay_players)" --json`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const rows = JSON.parse(result) as Array<{
      results: Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    }>;
    const cols = rows[0]?.results ?? [];
    const BASE = new Set(["id", "created_at", "updated_at"]);
    return cols
      .filter(c => !BASE.has(c.name))
      .map(c => ({
        name: c.name,
        sqlType: c.type.toUpperCase() as "TEXT" | "INTEGER" | "REAL",
        nullable: c.notnull === 0,
        defaultValue: c.dflt_value ?? undefined,
      }));
  } catch {
    return [];
  }
}

// ─── Config loader ────────────────────────────────────────────────────────────

export async function loadCurrentSchema(): Promise<ColumnDef[]> {
  const configPath = join(process.cwd(), "edgplay.config.ts");
  if (!existsSync(configPath)) {
    console.error("❌  edgplay.config.ts not found.");
    console.error("    Create one exporting a `schema` array. Example:");
    console.error("    export { schema } from 'edgplay/schema';");
    process.exit(1);
  }
  const mod = await import(configPath) as { schema?: ColumnDef[] };
  if (!mod.schema || !Array.isArray(mod.schema)) {
    console.error("❌  edgplay.config.ts must export a `schema: ColumnDef[]`.");
    process.exit(1);
  }
  return mod.schema;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

export interface SchemaDiff {
  added:   ColumnDef[];
  removed: ColumnDef[];
  renames: Array<{ from: string; to: string }>;
}

export async function computeDiff(current: ColumnDef[], desired: ColumnDef[]): Promise<SchemaDiff> {
  const currentNames = new Set(current.map(c => c.name));
  const desiredNames = new Set(desired.map(c => c.name));

  const added   = desired.filter(c => !currentNames.has(c.name));
  const removed = current.filter(c => !desiredNames.has(c.name));
  const renames: Array<{ from: string; to: string }> = [];

  if (added.length > 0 && removed.length > 0) {
    const rl = readline.createInterface({ input, output });

    for (const rem of [...removed]) {
      const candidates = added.filter(a => a.sqlType === rem.sqlType);
      for (const cand of candidates) {
        const answer = await rl.question(
          `\n  Detected: removed '${rem.name}' (${rem.sqlType}), added '${cand.name}' (${cand.sqlType})\n` +
          `  Did you rename '${rem.name}' → '${cand.name}'? (y/N) `
        );
        if (answer.trim().toLowerCase() === "y") {
          renames.push({ from: rem.name, to: cand.name });
          added.splice(added.indexOf(cand), 1);
          removed.splice(removed.indexOf(rem), 1);
          break;
        }
      }
    }

    rl.close();
  }

  return { added, removed, renames };
}

// ─── SQL generation ───────────────────────────────────────────────────────────

export function generateUpSql(diff: SchemaDiff): string {
  const stmts: string[] = [];
  for (const { from, to } of diff.renames) {
    stmts.push(`ALTER TABLE edgplay_players RENAME COLUMN ${from} TO ${to};`);
  }
  for (const col of diff.added) {
    stmts.push(`ALTER TABLE edgplay_players ADD COLUMN ${columnToSql(col)};`);
  }
  for (const col of diff.removed) {
    stmts.push(`ALTER TABLE edgplay_players DROP COLUMN ${col.name};`);
  }
  return stmts.join("\\n");
}

export function generateDownSql(diff: SchemaDiff): string {
  const stmts: string[] = [];
  for (const { from, to } of diff.renames) {
    stmts.push(`ALTER TABLE edgplay_players RENAME COLUMN ${to} TO ${from};`);
  }
  for (const col of diff.added) {
    stmts.push(`ALTER TABLE edgplay_players DROP COLUMN ${col.name};`);
  }
  for (const col of diff.removed) {
    stmts.push(`ALTER TABLE edgplay_players ADD COLUMN ${columnToSql(col)};`);
  }
  return stmts.join("\\n");
}

// ─── Command ──────────────────────────────────────────────────────────────────

export async function generate(_args: string[]): Promise<void> {
  console.log("🔍  Detecting schema drift…\n");

  const dbName  = getDbName();
  const desired = await loadCurrentSchema();
  const current = getD1Columns(dbName);

  if (current.length === 0 && desired.length > 0) {
    console.log("  No existing columns found — this will be the initial migration.");
  }

  const diff = await computeDiff(current, desired);

  if (!diff.added.length && !diff.removed.length && !diff.renames.length) {
    console.log("✅  No schema drift detected. Nothing to generate.");
    return;
  }

  if (diff.added.length)   console.log(`  + Added:   ${diff.added.map(c => c.name).join(", ")}`);
  if (diff.removed.length) console.log(`  - Removed: ${diff.removed.map(c => c.name).join(", ")}`);
  if (diff.renames.length) console.log(`  ~ Renamed: ${diff.renames.map(r => `${r.from} → ${r.to}`).join(", ")}`);

  const dir  = migrationsDir();
  const num  = nextMigrationNumber(dir);
  const name = `${num}_schema_update`;
  const path = join(dir, `${name}.ts`);
  const up   = generateUpSql(diff);
  const down = generateDownSql(diff);

  writeFileSync(path, `// Auto-generated by edgplay migrate:generate — review before applying\nexport const migration = {\n  name: "${name}",\n  up:   \`${up}\`,\n  down: \`${down}\`,\n};\n`);

  console.log(`\n✅  Generated: migrations/${name}.ts`);
}
