import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../src/ratelimit/RateLimiter.js";
import { RateLimitViolation } from "../src/enums.js";
import { GameEvent } from "../src/enums.js";

const PLAYER = "player-1";
const ACTION = GameEvent.ACTION;
const CHAT   = GameEvent.CHAT;

describe("RateLimiter — maxPayloadBytes", () => {
  it("allows messages within the byte limit", () => {
    const limiter = new RateLimiter({ global: { maxPayloadBytes: 100 } });
    const result  = limiter.check(PLAYER, ACTION, 50);
    expect(result.allowed).toBe(true);
  });

  it("rejects messages exceeding the byte limit", () => {
    const limiter = new RateLimiter({ global: { maxPayloadBytes: 100 } });
    const result  = limiter.check(PLAYER, ACTION, 200);
    expect(result.allowed).toBe(false);
  });

  it("uses DROP as default violation for oversized frames", () => {
    const limiter = new RateLimiter({ global: { maxPayloadBytes: 10 } });
    const result  = limiter.check(PLAYER, ACTION, 100);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.violation).toBe(RateLimitViolation.DROP);
  });

  it("uses configured onViolation when oversized", () => {
    const limiter = new RateLimiter({
      global: { maxPayloadBytes: 10, onViolation: RateLimitViolation.KICK },
    });
    const result = limiter.check(PLAYER, ACTION, 100);
    if (!result.allowed) expect(result.violation).toBe(RateLimitViolation.KICK);
  });
});

describe("RateLimiter — cooldownMs", () => {
  it("allows first message immediately", () => {
    const limiter = new RateLimiter({ global: { cooldownMs: 500 } });
    expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(true);
  });

  it("rejects second message within cooldown window", () => {
    const limiter = new RateLimiter({ global: { cooldownMs: 500 } });
    limiter.check(PLAYER, ACTION, 10); // first — allowed, sets lastSent
    const result = limiter.check(PLAYER, ACTION, 10); // second — within cooldown
    expect(result.allowed).toBe(false);
  });

  it("allows message after cooldown expires", () => {
    let t = 1000;
    const limiter = new RateLimiter({ global: { cooldownMs: 100 } }, () => t);
    limiter.check(PLAYER, ACTION, 10);
    t += 110; // advance past cooldown
    expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(true);
  });

  it("cooldown is per message type — different types don't interfere", () => {
    const limiter = new RateLimiter({ global: { cooldownMs: 500 } });
    limiter.check(PLAYER, ACTION, 10);
    // CHAT is a different type — should be allowed immediately
    expect(limiter.check(PLAYER, CHAT, 10).allowed).toBe(true);
  });
});

describe("RateLimiter — messagesPerSecond", () => {
  it("allows messages within the per-second limit", () => {
    const limiter = new RateLimiter({ global: { messagesPerSecond: 5 } });
    for (let i = 0; i < 5; i++) {
      expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(true);
    }
  });

  it("rejects messages exceeding the per-second limit", () => {
    const limiter = new RateLimiter({ global: { messagesPerSecond: 3 } });
    limiter.check(PLAYER, ACTION, 10);
    limiter.check(PLAYER, ACTION, 10);
    limiter.check(PLAYER, ACTION, 10);
    const result = limiter.check(PLAYER, ACTION, 10); // 4th in same second
    expect(result.allowed).toBe(false);
  });

  it("resets window after 1 second", () => {
    let t = 1000;
    const limiter = new RateLimiter({ global: { messagesPerSecond: 2 } }, () => t);
    limiter.check(PLAYER, ACTION, 10);
    limiter.check(PLAYER, ACTION, 10);
    expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(false);
    t += 1001; // advance past the window
    expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(true);
  });

  it("limits are per player — different players have separate counters", () => {
    const limiter = new RateLimiter({ global: { messagesPerSecond: 1 } });
    limiter.check("player-1", ACTION, 10);
    // player-2 starts fresh
    expect(limiter.check("player-2", ACTION, 10).allowed).toBe(true);
  });
});

describe("RateLimiter — perType overrides", () => {
  it("perType overrides global for the specified type", () => {
    const limiter = new RateLimiter({
      global:  { messagesPerSecond: 10 },
      perType: { [CHAT]: { messagesPerSecond: 1 } },
    });
    limiter.check(PLAYER, CHAT, 10);
    expect(limiter.check(PLAYER, CHAT, 10).allowed).toBe(false);
    // ACTION uses global limit (10/s) — still allowed
    expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(true);
  });

  it("perType can set a stricter cooldown for a specific type", () => {
    const limiter = new RateLimiter({
      perType: { [CHAT]: { cooldownMs: 1000 } },
    });
    limiter.check(PLAYER, CHAT, 10);
    expect(limiter.check(PLAYER, CHAT, 10).allowed).toBe(false);
    // ACTION has no limit
    expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(true);
  });
});

describe("RateLimiter — mute()", () => {
  it("mutes a player for a specific message type", () => {
    let t = 1000;
    const limiter = new RateLimiter({}, () => t);
    limiter.mute(PLAYER, CHAT, 5000);
    expect(limiter.check(PLAYER, CHAT, 10).allowed).toBe(false);
  });

  it("mute only affects the specified message type", () => {
    let t = 1000;
    const limiter = new RateLimiter({}, () => t);
    limiter.mute(PLAYER, CHAT, 5000);
    // ACTION is not muted
    expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(true);
  });

  it("mute expires after durationMs", () => {
    let t = 1000;
    const limiter = new RateLimiter({}, () => t);
    limiter.mute(PLAYER, CHAT, 100);
    expect(limiter.check(PLAYER, CHAT, 10).allowed).toBe(false);
    t += 110; // advance past mute duration
    expect(limiter.check(PLAYER, CHAT, 10).allowed).toBe(true);
  });

  it("permanent mute (no duration) stays active", () => {
    let t = 1000;
    const limiter = new RateLimiter({}, () => t);
    limiter.mute(PLAYER, CHAT); // no duration
    t += 99999; // advance far into the future
    expect(limiter.check(PLAYER, CHAT, 10).allowed).toBe(false);
  });

  it("muted messages use DROP violation", () => {
    const limiter = new RateLimiter({});
    limiter.mute(PLAYER, CHAT, 5000);
    const result = limiter.check(PLAYER, CHAT, 10);
    if (!result.allowed) expect(result.violation).toBe(RateLimitViolation.DROP);
  });
});

describe("RateLimiter — removePlayer()", () => {
  it("cleans up all state for a player", () => {
    const limiter = new RateLimiter({ global: { messagesPerSecond: 1 } });
    limiter.check(PLAYER, ACTION, 10);
    expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(false);
    limiter.removePlayer(PLAYER);
    // After removal, counters reset
    expect(limiter.check(PLAYER, ACTION, 10).allowed).toBe(true);
  });
});

describe("RateLimiter — no config", () => {
  it("allows all messages when no limits configured", () => {
    const limiter = new RateLimiter({});
    for (let i = 0; i < 100; i++) {
      expect(limiter.check(PLAYER, ACTION, 999999).allowed).toBe(true);
    }
  });
});
