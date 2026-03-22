import type { Player, DefaultIdentity, InferIdentity, DefaultData } from "./Player.js";
import type { RateLimitViolation } from "./enums.js";
import { GameEvent } from "./enums.js";
import { encode } from "./protocol/index.js";

export interface RateLimitConfig {
  messagesPerSecond?: number;
  cooldownMs?: number;
  maxPayloadBytes?: number;
  onViolation?: RateLimitViolation;
}

export interface RateLimitsConfig {
  global?: RateLimitConfig;
  perType?: Record<number, RateLimitConfig>;
}

/**
 * Abstract base class for all game rooms.
 *
 * @typeParam TState   Shape of the game state
 * @typeParam TSchema  Identity schema (from defineIdentity) — types player.identity
 * @typeParam TData    Per-session player data shape — types player.data
 *
 * @example
 * interface ChessPlayerData {
 *   color: "white" | "black";
 * }
 *
 * export class ChessRoom extends GameRoom<ChessState, typeof identitySchema, ChessPlayerData> {
 *   onJoin(player: this["Player"]) {
 *     player.data.color = "white"          // typed as "white" | "black" ✅
 *     player.identity.public.name          // typed as string ✅
 *   }
 *   actions = {
 *     move: (player: this["Player"], payload: { from: string; to: string }) => {
 *       if (player.data.color !== this.state.turn) return  // ✅ no cast
 *     }
 *   }
 * }
 */
export abstract class GameRoom<
  TState  extends object     = Record<string, unknown>,
  TSchema extends object     = Record<string, never>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TData   extends Record<string, any> = DefaultData
> {
  /**
   * The typed Player for this room.
   * Use as parameter type in actions and lifecycle hooks:
   *
   *   move: (player: this["Player"], payload) => { ... }
   *   onJoin(player: this["Player"]) { ... }
   */
  declare Player: Player<InferIdentity<TSchema>, TData>;

  /** All currently connected players, keyed by player ID */
  readonly players = new Map<string, Player<InferIdentity<TSchema>, TData>>();

  /** Current game state */
  state!: TState;

  maxPlayers = 4;
  rateLimits?: RateLimitsConfig;

  // ─── Abstract ─────────────────────────────────────────────────────────────

  abstract initialState(): TState;

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  onCreate(_options: unknown): void {}

  /**
   * Called when a player joins. Player IS in `this.players` at this point.
   * Do NOT call broadcastState() here — the framework does it automatically.
   */
  onJoin(_player: Player<InferIdentity<TSchema>, TData>, _options: unknown): void {}

  onLeave(_player: Player<InferIdentity<TSchema>, TData>): void {}

  onDispose(): void {}

  onRejoin(_player: Player<InferIdentity<TSchema>, TData>): void {}

  // ─── State visibility ─────────────────────────────────────────────────────

  stateFor(_player: Player<InferIdentity<TSchema>, TData>): unknown {
    return this.state;
  }

  // ─── Lobby ────────────────────────────────────────────────────────────────

  lobbyData(): Record<string, unknown> {
    return { players: this.players.size, maxPlayers: this.maxPlayers };
  }

  isListed(): boolean { return true; }

  /**
   * Called BEFORE the player is added to `this.players`.
   * Do NOT use `this.players.size + 1` — the +1 is implicit.
   */
  canJoin(_player: Player<InferIdentity<TSchema>, TData>): boolean {
    return this.players.size < this.maxPlayers;
  }

  // ─── Message whitelist ────────────────────────────────────────────────────

  allowedMessages(): number[] | null { return null; }

  // ─── Actions and raw messages ─────────────────────────────────────────────

  /**
   * Action handlers — use `this["Player"]` for the player parameter type:
   *
   *   actions = {
   *     move: (player: this["Player"], payload: { from: string; to: string }) => { ... }
   *   }
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (player: any, payload: any) => void> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: Record<number, (player: any, buffer: ArrayBuffer) => void> = {};

  mute(playerId: string, type: number, options?: { durationMs?: number }): void {
    this._muteFn?.(playerId, type, options?.durationMs);
  }

  /**
   * Internal — set by the framework after the DO creates the room.
   * The developer calls this.mute() which delegates to this hook.
   * @internal
   */
  _muteFn: ((playerId: string, type: number, durationMs?: number) => void) | null = null;

  // ─── Broadcasting ─────────────────────────────────────────────────────────

  broadcastState(): void {
    for (const player of this.players.values()) {
      player.send(GameEvent.STATE_FULL, this.stateFor(player));
    }
  }

  broadcast(type: number, payload?: unknown): void {
    const buffer = encode(type, payload ?? null);
    for (const player of this.players.values()) {
      player.sendRaw(buffer);
    }
  }

  broadcastExcept(excludeId: string, type: number, payload?: unknown): void {
    const buffer = encode(type, payload ?? null);
    for (const [id, player] of this.players.entries()) {
      if (id !== excludeId) player.sendRaw(buffer);
    }
  }
}
