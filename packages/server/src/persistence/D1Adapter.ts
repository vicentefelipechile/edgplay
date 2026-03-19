import type { Player } from "../Player.js";
import type { PersistenceAdapter } from "./types.js";

/**
 * Persistence via Cloudflare D1 (SQLite).
 * Used when withDatabase(env.DB) is set in createEngine().
 *
 * TODO: implement
 * - CREATE TABLE IF NOT EXISTS players (...)
 * - INSERT OR REPLACE on savePlayer
 * - SELECT on loadPlayer
 * - Schema generated from defineIdentity() schema (Zod or plain strings)
 */
export class D1Adapter implements PersistenceAdapter {
  constructor(private readonly db: D1Database) {}

  async loadPlayer(id: string): Promise<Record<string, unknown> | null> {
    // TODO
    void id;
    return null;
  }

  async savePlayer(player: Player): Promise<void> {
    // TODO
    void player;
  }
}
