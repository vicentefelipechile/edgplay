export interface PlayerIdentity {
  public: Record<string, unknown>;   // visible to other players
  private: Record<string, unknown>;  // server-side only, never sent to clients
}

export interface Player {
  /** Temporary session ID assigned on connect (before identify()) */
  id: string;

  /** Persistent identity — populated after player.identify() is called */
  identity: PlayerIdentity;

  /** Arbitrary per-session data the GameRoom can attach (e.g. color, role) */
  data: Record<string, unknown>;

  /** Send a pre-encoded binary message directly to this player */
  sendRaw(buffer: ArrayBuffer): void;

  /** Encode and send a typed message to this player */
  send(type: number, payload?: unknown): void;

  /** Attach a persistent identity to this player */
  identify(identity: PlayerIdentity): void;

  /** Disconnect this player before they enter a room */
  reject(reason: string): void;

  /** Persist identity to D1 (if configured) or DO storage */
  save(): Promise<void>;
}
