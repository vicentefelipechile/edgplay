// ─── Identity shape helpers ───────────────────────────────────────────────────

/** Default identity when no schema is defined */
export interface DefaultIdentity {
  public:  Record<string, unknown>;
  private: Record<string, unknown>;
}

/**
 * Infer the TypeScript type from an identity schema (Zod or plain strings).
 */
export type InferIdentity<TSchema> =
  TSchema extends {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public:  { _output: infer TPub };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private: { _output: infer TPriv };
  }
  ? { public: TPub & Record<string, unknown>; private: TPriv & Record<string, unknown> }
  : DefaultIdentity;

/** Default session data when no TData is defined */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DefaultData = Record<string, any>;

// ─── Player interface ─────────────────────────────────────────────────────────

/**
 * Represents a connected player.
 *
 * @typeParam TIdentity  Inferred from defineIdentity() — gives typed player.identity
 * @typeParam TData      Defined per-room — gives typed player.data (session-only)
 *
 * @example
 * interface ChessPlayerData { color: "white" | "black" }
 *
 * export class ChessRoom extends GameRoom<ChessState, typeof identitySchema, ChessPlayerData> {
 *   onJoin(player: this["Player"]) {
 *     player.data.color = "white"   // typed as "white" | "black" ✅
 *   }
 *   actions = {
 *     move: (player: this["Player"], payload) => {
 *       if (player.data.color !== this.state.turn) return  // ✅
 *     }
 *   }
 * }
 */
export interface Player<
  TIdentity extends DefaultIdentity     = DefaultIdentity,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TData     extends Record<string, any> = DefaultData
> {
  /** Temporary session ID assigned on connect (before identify) */
  id: string;

  /** Typed identity — populated after player.identify() is called */
  identity: TIdentity;

  /**
   * Typed per-session data — set by the GameRoom during the player's stay.
   * Not persisted, not visible to other players, lost on disconnect.
   * Type comes from the third generic parameter of GameRoom.
   */
  data: TData;

  sendRaw(buffer: ArrayBuffer): void;
  send(type: number, payload?: unknown): void;

  /**
   * Attach a persistent identity to this player.
   * Always await this in onConnect.
   */
  identify(identity: Partial<TIdentity> & { id?: string }): Promise<void>;

  reject(reason: string): void;
  save(): Promise<void>;
}

/** Convenience alias for untyped Player */
export type AnyPlayer = Player<DefaultIdentity, DefaultData>;

/** The shape passed to identify() */
export type PlayerIdentity = DefaultIdentity;
