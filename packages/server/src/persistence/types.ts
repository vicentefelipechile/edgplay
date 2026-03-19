import type { Player } from "../Player.js";

export interface PersistenceAdapter {
  loadPlayer(id: string): Promise<Record<string, unknown> | null>;
  savePlayer(player: Player): Promise<void>;
}
