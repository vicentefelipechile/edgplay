import type { Player } from "../Player.js";
import type { PersistenceAdapter } from "./types.js";
import type { ColumnDef } from "./schema.js";

/**
 * Persistence adapter for Cloudflare D1.
 * Activated when withDatabase(env.DB) is set in createEngine().
 */
export class D1Adapter implements PersistenceAdapter {
  private _schemaReady = false;

  constructor(
    private readonly db: D1Database,
    private readonly columns: ColumnDef[] = []
  ) {}

  // ─── Schema bootstrap ─────────────────────────────────────────────────────

  async ensureSchema(): Promise<void> {
    if (this._schemaReady) return;
    await this.db.batch([
      this.db.prepare(`CREATE TABLE IF NOT EXISTS edgplay_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`),
      this.db.prepare(`CREATE TABLE IF NOT EXISTS edgplay_players (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      this.db.prepare(`CREATE TABLE IF NOT EXISTS edgplay_sessions (
        session_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES edgplay_players(id),
        room_id TEXT,
        connected_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      )`),
    ]);
    this._schemaReady = true;
  }

  // ─── PersistenceAdapter ───────────────────────────────────────────────────

  async loadPlayer(id: string): Promise<Record<string, unknown> | null> {
    await this.ensureSchema();
    const row = await this.db
      .prepare("SELECT * FROM edgplay_players WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return this._rowToIdentity(row);
  }

  async savePlayer(player: Player): Promise<void> {
    await this.ensureSchema();
    const now = Date.now();
    const flat = this._identityToRow(player.id, player.identity, now);
    const cols = Object.keys(flat);
    const placeholders = cols.map(() => "?").join(", ");
    const updates = cols
      .filter(c => c !== "id" && c !== "created_at")
      .map(c => `${c} = excluded.${c}`)
      .join(", ");
    await this.db
      .prepare(`INSERT INTO edgplay_players (${cols.join(", ")})
        VALUES (${placeholders})
        ON CONFLICT(id) DO UPDATE SET ${updates}`)
      .bind(...Object.values(flat))
      .run();
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  async getPublicProfile(playerId: string): Promise<Record<string, unknown> | null> {
    await this.ensureSchema();
    const publicCols = this.columns
      .filter(c => c.name.startsWith("public_"))
      .map(c => c.name);
    const selectCols = ["id", ...publicCols].join(", ");
    const row = await this.db
      .prepare(`SELECT ${selectCols} FROM edgplay_players WHERE id = ?`)
      .bind(playerId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return this._rowToPublicProfile(row);
  }

  // ─── Conversion helpers ───────────────────────────────────────────────────

  private _identityToRow(
    id: string,
    identity: { public: Record<string, unknown>; private: Record<string, unknown> },
    now: number
  ): Record<string, unknown> {
    const row: Record<string, unknown> = { id, created_at: now, updated_at: now };
    for (const [k, v] of Object.entries(identity.public))  row[`public_${k}`]  = this._ser(v);
    for (const [k, v] of Object.entries(identity.private)) row[`private_${k}`] = this._ser(v);
    return row;
  }

  private _rowToIdentity(row: Record<string, unknown>): Record<string, unknown> {
    const pub: Record<string, unknown> = {};
    const prv: Record<string, unknown> = {};
    for (const [col, val] of Object.entries(row)) {
      if (col.startsWith("public_"))   pub[col.slice(7)] = this._deser(col, val);
      else if (col.startsWith("private_")) prv[col.slice(8)] = this._deser(col, val);
    }
    return { public: pub, private: prv };
  }

  private _rowToPublicProfile(row: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { id: row.id };
    for (const [col, val] of Object.entries(row)) {
      if (col.startsWith("public_")) result[col.slice(7)] = this._deser(col, val);
    }
    return result;
  }

  private _ser(v: unknown): unknown {
    return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  }

  private _deser(col: string, v: unknown): unknown {
    if (typeof v !== "string") return v;
    const def = this.columns.find(c => c.name === col);
    if (def?.sqlType === "TEXT" && (v.startsWith("{") || v.startsWith("["))) {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }
}
