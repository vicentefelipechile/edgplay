import { RateLimitViolation } from "../enums.js";
import type { RateLimitConfig, RateLimitsConfig } from "../GameRoom.js";

// ─── Per-player state ─────────────────────────────────────────────────────────

interface PlayerRateState {
  /** message type → timestamp of last message */
  lastSent: Map<number, number>;
  /** message type → count of messages in current window */
  windowCount: Map<number, number>;
  /** message type → start of current 1-second window */
  windowStart: Map<number, number>;
  /** message type → muted until timestamp (0 = not muted) */
  mutedUntil: Map<number, number>;
}

function makePlayerState(): PlayerRateState {
  return {
    lastSent:    new Map(),
    windowCount: new Map(),
    windowStart: new Map(),
    mutedUntil:  new Map(),
  };
}

// ─── Result ───────────────────────────────────────────────────────────────────

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; violation: RateLimitViolation; reason: string };

// ─── RateLimiter ──────────────────────────────────────────────────────────────

/**
 * Stateful rate limiter that runs inside the DO — one instance per GameRoom.
 *
 * Checks three things in order, stopping at the first violation:
 *  1. maxPayloadBytes — checked before decoding (passed as byteLength)
 *  2. mute()         — player silenced for a specific message type
 *  3. cooldownMs     — minimum time between messages of the same type
 *  4. messagesPerSecond — sliding 1-second window per player per type
 *
 * Config is merged: global → perType → room override (most specific wins).
 */
export class RateLimiter {
  /** playerId → per-player rate state */
  private _state = new Map<string, PlayerRateState>();

  constructor(
    private readonly config: RateLimitsConfig,
    /** Injectable time function — override in tests for deterministic behavior */
    private readonly _now: () => number = () => Date.now()
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Check if a message is allowed for a given player.
   * @param playerId  The player's session ID
   * @param msgType   The GameEvent byte value
   * @param byteLength  Total frame size in bytes (for maxPayloadBytes check)
   */
  check(playerId: string, msgType: number, byteLength: number): RateLimitResult {
    const state = this._getOrCreate(playerId);
    const now   = this._now();

    // 1. Mute check — always runs, even with no rate limit config
    const mutedUntil = state.mutedUntil.get(msgType) ?? 0;
    if (now < mutedUntil) {
      return {
        allowed:   false,
        violation: RateLimitViolation.DROP,
        reason:    `Player muted for message type 0x${msgType.toString(16)}`,
      };
    }

    const cfg = this._resolveConfig(msgType);
    if (!cfg) return { allowed: true };

    // 2. maxPayloadBytes — before any per-type check
    if (cfg.maxPayloadBytes !== undefined && byteLength > cfg.maxPayloadBytes) {
      return {
        allowed:   false,
        violation: cfg.onViolation ?? RateLimitViolation.DROP,
        reason:    `Payload too large: ${byteLength} > ${cfg.maxPayloadBytes} bytes`,
      };
    }

    // 3. Cooldown check
    if (cfg.cooldownMs !== undefined) {
      const last = state.lastSent.get(msgType) ?? 0;
      if (now - last < cfg.cooldownMs) {
        return {
          allowed:   false,
          violation: cfg.onViolation ?? RateLimitViolation.DROP,
          reason:    `Cooldown active: ${cfg.cooldownMs}ms between messages`,
        };
      }
    }

    // 4. Messages-per-second sliding window
    if (cfg.messagesPerSecond !== undefined) {
      const windowStart = state.windowStart.get(msgType) ?? now;
      const count       = state.windowCount.get(msgType) ?? 0;

      if (now - windowStart < 1000) {
        // Still in the same 1-second window
        if (count >= cfg.messagesPerSecond) {
          return {
            allowed:   false,
            violation: cfg.onViolation ?? RateLimitViolation.DROP,
            reason:    `Rate limit: max ${cfg.messagesPerSecond} msg/s exceeded`,
          };
        }
        // Persist windowStart on first message so subsequent calls use it
        if (!state.windowStart.has(msgType)) state.windowStart.set(msgType, now);
        state.windowCount.set(msgType, count + 1);
      } else {
        // New window — reset counters
        state.windowStart.set(msgType, now);
        state.windowCount.set(msgType, 1);
      }
    }

    state.lastSent.set(msgType, now);
    return { allowed: true };
  }

  /**
   * Mute a player for a specific message type.
   * @param playerId   The player's session ID
   * @param msgType    The GameEvent byte value to mute
   * @param durationMs How long to mute (ms). Omit for permanent (until disconnect)
   */
  mute(playerId: string, msgType: number, durationMs?: number): void {
    const state = this._getOrCreate(playerId);
    const until = durationMs !== undefined
      ? this._now() + durationMs
      : Number.MAX_SAFE_INTEGER;
    state.mutedUntil.set(msgType, until);
  }

  /** Remove all rate state for a player (call on disconnect) */
  removePlayer(playerId: string): void {
    this._state.delete(playerId);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private _getOrCreate(playerId: string): PlayerRateState {
    let state = this._state.get(playerId);
    if (!state) {
      state = makePlayerState();
      this._state.set(playerId, state);
    }
    return state;
  }

  /**
   * Resolve the effective config for a given message type.
   * Merge order: global → perType (perType wins on conflict).
   * Returns null if no config is set at all.
   */
  private _resolveConfig(msgType: number): RateLimitConfig | null {
    const global  = this.config.global;
    const perType = this.config.perType?.[msgType];

    if (!global && !perType) return null;

    return { ...global, ...perType };
  }
}
