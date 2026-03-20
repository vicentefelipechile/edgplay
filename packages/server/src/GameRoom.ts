import type { Player } from "./Player.js";
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
 * Developers extend this class and override lifecycle methods, define actions,
 * and optionally customize lobby behavior. The framework handles all WebSocket
 * routing, state broadcasting, and protocol details.
 *
 * @typeParam TState  Shape of this room's game state
 */
export abstract class GameRoom<TState extends object = Record<string, unknown>> {
  /** All currently connected players, keyed by player ID */
  readonly players = new Map<string, Player>();

  /** Current game state — mutate directly inside actions and lifecycle methods */
  state!: TState;

  /** Maximum number of players allowed in this room */
  maxPlayers = 4;

  /**
   * Optional per-room rate limit overrides.
   * Merged with the global config set in createEngine().
   */
  rateLimits?: RateLimitsConfig;

  // ─── Abstract lifecycle — must be called by the framework ──────────────────

  /** Return the initial state for a new room instance */
  abstract initialState(): TState;

  // ─── Lifecycle hooks — override as needed ──────────────────────────────────

  onCreate(_options: unknown): void {}

  /**
   * Called when a player successfully joins the room.
   *
   * At the time this runs, the player IS already in `this.players`,
   * so `this.players.size` includes the incoming player.
   *
   * Use this to assign roles, check if the game should start, etc.
   * Call `player.reject(reason)` inside this hook to kick the player
   * out after join (e.g. if they fail a secondary validation).
   *
   * NOTE: do NOT call player.send(STATE_FULL) or broadcastState() here —
   * the framework calls broadcastState() automatically after onJoin finishes,
   * sending the current state to all connected players including the new one.
   */
  onJoin(_player: Player, _options: unknown): void {}

  onLeave(_player: Player): void {}

  onDispose(): void {}

  onRejoin(_player: Player): void {}

  // ─── State visibility — override for hidden state (Poker, UNO) ─────────────

  /**
   * Returns the state slice visible to a specific player.
   * Default: full state visible to everyone.
   * Override for games with hidden information (e.g. hand cards).
   */
  stateFor(_player: Player): unknown {
    return this.state;
  }

  // ─── Lobby behavior — override to control room discovery ───────────────────

  /** Data exposed in the lobby room list */
  lobbyData(): Record<string, unknown> {
    return { players: this.players.size, maxPlayers: this.maxPlayers };
  }

  /** Whether this room should appear in the lobby */
  isListed(): boolean {
    return true;
  }

  /**
   * Whether a player is allowed to join this room.
   *
   * Called by the framework BEFORE the player is added to `this.players`.
   * At the time this runs, `this.players` contains only confirmed players
   * (those who have already passed canJoin and onJoin without being rejected).
   *
   * The incoming player is NOT yet in the map — so to check if the room
   * is full, compare against maxPlayers directly:
   *
   * @example
   * canJoin(player) {
   *   return this.players.size < this.maxPlayers;
   * }
   *
   * Do NOT use `this.players.size + 1` — the +1 is implicit.
   */
  canJoin(_player: Player): boolean {
    return this.players.size < this.maxPlayers;
  }

  // ─── Message whitelist — override to restrict messages by game state ────────

  /**
   * Returns the list of GameEvent types accepted in the current game state.
   * Any type not in this list is silently dropped before reaching a handler.
   * Default: all messages allowed.
   */
  allowedMessages(): number[] | null {
    return null; // null = allow all
  }

  // ─── Actions and raw messages ───────────────────────────────────────────────

  /**
   * Action handlers — go through the framework pipeline:
   * validation → handler → auto broadcastState.
   *
   * Keys are action name strings (e.g. "move", "raise").
   *
   * @example
   * actions = {
   *   move: (player, payload: { from: string; to: string }) => { ... }
   * }
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, (player: Player, payload: any) => void> = {};

  /**
   * Raw message handlers — bypass the framework pipeline entirely.
   * Maximum efficiency for high-frequency or custom binary data.
   * Keys are GameEvent byte values in the developer range (0x50–0xFF).
   *
   * @example
   * messages = {
   *   [MyEvent.SPELL_CAST]: (player, buffer) => { ... }
   * }
   */
  messages: Record<number, (player: Player, buffer: ArrayBuffer) => void> = {};

  // ─── Runtime controls — called by framework or from within the room ────────

  /** Mute a specific player for a specific message type for a given duration */
  mute(
    _playerId: string,
    _type: number,
    _options?: { durationMs?: number }
  ): void {
    // TODO: implement in framework internals
  }

  // ─── Broadcasting helpers ─────────────────────────────────────────────────

  /** Broadcast the current state to all connected players (using stateFor) */
  broadcastState(): void {
    for (const player of this.players.values()) {
      player.send(GameEvent.STATE_FULL, this.stateFor(player));
    }
  }

  /** Broadcast an encoded message to all connected players */
  broadcast(type: number, payload?: unknown): void {
    const buffer = encode(type, payload ?? null);
    for (const player of this.players.values()) {
      player.sendRaw(buffer);
    }
  }

  /** Broadcast to all players except one (e.g. the sender) */
  broadcastExcept(excludeId: string, type: number, payload?: unknown): void {
    const buffer = encode(type, payload ?? null);
    for (const [id, player] of this.players.entries()) {
      if (id !== excludeId) player.sendRaw(buffer);
    }
  }
}
