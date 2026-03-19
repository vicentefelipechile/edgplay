import type { Player } from "../Player.js";
import type { PersistenceAdapter } from "./types.js";

/**
 * Fallback persistence via Durable Object storage.
 * Used when D1 is not configured.
 * Stores player identity as a JSON blob with an optional TTL.
 *
 * TODO: implement
 */
export class DOStorageAdapter implements PersistenceAdapter {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly ttlSeconds = 60 * 60 * 24 * 7 // 7 days default
  ) {}

  async loadPlayer(id: string): Promise<Record<string, unknown> | null> {
    // TODO: get from DO storage, check expiry
    void id;
    return null;
  }

  async savePlayer(player: Player): Promise<void> {
    // TODO: put to DO storage with TTL
    void player;
  }
}
