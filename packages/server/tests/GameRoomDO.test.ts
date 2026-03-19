import { describe, it, expect, vi, beforeEach } from "vitest";
import { GameRoomDO } from "../src/GameRoomDO.js";
import { GameRoom } from "../src/GameRoom.js";
import type { Player } from "../src/Player.js";
import { encode } from "../src/protocol/index.js";
import { GameEvent, DisconnectReason } from "../src/enums.js";
import type { EdgplayEnv } from "../src/createEngine.js";

// ─── Mock WebSocket ───────────────────────────────────────────────────────────

class MockWebSocket {
  readyState = 1; // OPEN
  sent: ArrayBuffer[] = [];
  closed: { code: number; reason: string } | null = null;

  send(data: ArrayBuffer) { this.sent.push(data); }
  close(code = 1000, reason = "") { this.closed = { code, reason }; this.readyState = 3; }
  deserializeAttachment() { return null; }
  serializeAttachment(_v: unknown) {}
}

// ─── Mock DurableObjectState ──────────────────────────────────────────────────

function makeDOState(): DurableObjectState {
  return {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    storage: {} as DurableObjectStorage,
    id: {} as DurableObjectId,
    blockConcurrencyWhile: vi.fn(),
    waitUntil: vi.fn(),
    abort: vi.fn(),
  } as unknown as DurableObjectState;
}

function makeEnv(): EdgplayEnv {
  const stub = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
  const ns = {
    idFromName: vi.fn().mockReturnValue("id"),
    get: vi.fn().mockReturnValue(stub),
  } as unknown as DurableObjectNamespace;
  return { GAME_ROOM: ns, LOBBY: ns };
}

// ─── Test GameRoom implementation ─────────────────────────────────────────────

interface TestState { count: number; status: string }

class CounterRoom extends GameRoom<TestState> {
  initialState() { return { count: 0, status: "waiting" }; }

  onJoin(player: Player) {
    player.data.joined = true;
  }

  actions = {
    increment: (_player: Player, payload: { by?: number }) => {
      this.state.count += payload?.by ?? 1;
    },
    reject_me: (player: Player) => {
      player.reject("nope");
    },
  };
}

// ─── Helper: create a DO instance and simulate a player connecting ────────────

function makeRoom() {
  const DOClass = GameRoomDO.for(CounterRoom);
  const state = makeDOState();
  const env = makeEnv();
  const do_ = new DOClass(state, env);
  return { do_, state, env };
}

// ─── Helper: connect a player directly (bypasses WebSocketPair/fetch) ─────────
//
// Instead of going through fetch() (which needs WebSocketPair), we:
//  1. Create a MockWebSocket
//  2. Call do_._connectWs() — an internal test hook that runs _onOpen + registers the WS
//
// This keeps the tests focused on message-handling logic, not CF upgrade mechanics.
// The fetch/upgrade path is tested separately in the fetch tests above.

async function connectPlayer(do_: GameRoomDO, _state: DurableObjectState) {
  const ws = new MockWebSocket() as unknown as WebSocket;
  const req = new Request("https://example.com/room/test/room-1");
  // Access the private method via any-cast — acceptable in test-only helpers
  (do_ as unknown as { _onOpen: (ws: WebSocket, req: Request) => void })._onOpen(ws, req);
  return { ws: ws as unknown as MockWebSocket };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GameRoomDO.for()", () => {
  it("creates a DO subclass bound to the given GameRoom", () => {
    const DOClass = GameRoomDO.for(CounterRoom);
    const state = makeDOState();
    const instance = new DOClass(state, makeEnv());
    expect(instance).toBeInstanceOf(GameRoomDO);
  });
});

describe("fetch /init", () => {
  it("returns 200 ok", async () => {
    const { do_ } = makeRoom();
    const res = await do_.fetch(new Request("https://x.com/init", { method: "POST" }));
    expect(res.status).toBe(200);
  });
});

describe("fetch — WebSocket upgrade", () => {
  it("calls state.acceptWebSocket on upgrade request", async () => {
    const { do_, state } = makeRoom();
    (state.acceptWebSocket as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const req = new Request("https://x.com/room/chess/r1", {
      headers: { "Upgrade": "websocket" },
    });
    // Note: Response with status 101 throws in Node's fetch impl —
    // that's expected, CF Workers handles it natively.
    // We just verify the DO called acceptWebSocket correctly.
    try { await do_.fetch(req); } catch { /* 101 not valid in Node */ }
    expect(state.acceptWebSocket).toHaveBeenCalledOnce();
  });

  it("does not call acceptWebSocket for non-upgrade requests", async () => {
    const { do_, state } = makeRoom();
    await do_.fetch(new Request("https://x.com/init", { method: "POST" }));
    expect(state.acceptWebSocket).not.toHaveBeenCalled();
  });
});

describe("PING → PONG", () => {
  it("auto-responds to PING with PONG", async () => {
    const { do_, state } = makeRoom();
    const { ws } = await connectPlayer(do_, state);

    const pingBuf = encode(GameEvent.PING, null);
    await do_.webSocketMessage(ws as unknown as WebSocket, pingBuf);

    expect(ws.sent.length).toBe(1);
    // Decode the response and verify it's a PONG
    const { decode } = await import("../src/protocol/index.js");
    const msg = decode(ws.sent[0]);
    expect(msg?.type).toBe(GameEvent.PONG);
  });
});

describe("ACTION pipeline", () => {
  it("calls the correct action handler", async () => {
    const { do_, state } = makeRoom();
    const { ws } = await connectPlayer(do_, state);

    const buf = encode(GameEvent.ACTION, { action: "increment", payload: { by: 5 } });
    await do_.webSocketMessage(ws as unknown as WebSocket, buf);

    // After action, broadcastState should have sent STATE_FULL to the player
    expect(ws.sent.length).toBeGreaterThan(0);
    const { decode } = await import("../src/protocol/index.js");
    const msg = decode(ws.sent[ws.sent.length - 1]);
    expect(msg?.type).toBe(GameEvent.STATE_FULL);
    expect((msg?.payload as TestState).count).toBe(5);
  });

  it("broadcasts updated state to all connected players after action", async () => {
    const { do_, state } = makeRoom();
    const { ws: ws1 } = await connectPlayer(do_, state);
    const { ws: ws2 } = await connectPlayer(do_, state);

    const sentBefore1 = ws1.sent.length;
    const sentBefore2 = ws2.sent.length;

    const buf = encode(GameEvent.ACTION, { action: "increment", payload: { by: 3 } });
    await do_.webSocketMessage(ws1 as unknown as WebSocket, buf);

    // Both players should have received an updated state
    expect(ws1.sent.length).toBeGreaterThan(sentBefore1);
    expect(ws2.sent.length).toBeGreaterThan(sentBefore2);
  });

  it("silently ignores unknown actions", async () => {
    const { do_, state } = makeRoom();
    const { ws } = await connectPlayer(do_, state);

    const sentBefore = ws.sent.length;
    const buf = encode(GameEvent.ACTION, { action: "nonexistent", payload: null });
    await do_.webSocketMessage(ws as unknown as WebSocket, buf);

    // No STATE_FULL sent (action not found, so broadcastState not called)
    expect(ws.sent.length).toBe(sentBefore);
  });

  it("silently ignores malformed action payload", async () => {
    const { do_, state } = makeRoom();
    const { ws } = await connectPlayer(do_, state);

    const sentBefore = ws.sent.length;
    const buf = encode(GameEvent.ACTION, null); // no action field
    await do_.webSocketMessage(ws as unknown as WebSocket, buf);
    expect(ws.sent.length).toBe(sentBefore);
  });
});

describe("CRC / malformed frames", () => {
  it("silently discards frames that fail CRC", async () => {
    const { do_, state } = makeRoom();
    const { ws } = await connectPlayer(do_, state);

    const good = new Uint8Array(encode(GameEvent.ACTION, { action: "increment", payload: null }));
    good[good.length - 1] ^= 0xff; // corrupt CRC

    const sentBefore = ws.sent.length;
    await do_.webSocketMessage(ws as unknown as WebSocket, good.buffer);
    expect(ws.sent.length).toBe(sentBefore);
  });

  it("silently discards non-ArrayBuffer messages", async () => {
    const { do_, state } = makeRoom();
    const { ws } = await connectPlayer(do_, state);

    const sentBefore = ws.sent.length;
    await do_.webSocketMessage(ws as unknown as WebSocket, "text message" as unknown as ArrayBuffer);
    expect(ws.sent.length).toBe(sentBefore);
  });
});

describe("allowedMessages() whitelist", () => {
  it("drops messages not in the whitelist", async () => {
    class StrictRoom extends GameRoom<{ x: number }> {
      initialState() { return { x: 0 }; }
      allowedMessages() { return [GameEvent.PING]; } // only PING allowed
      actions = {
        increment: () => { this.state.x += 1; },
      };
    }

    const DOClass = GameRoomDO.for(StrictRoom);
    const state = makeDOState();
    const do_ = new DOClass(state, makeEnv());
    const { ws } = await connectPlayer(do_, state);

    const sentBefore = ws.sent.length;
    // ACTION is not in whitelist — should be dropped
    const buf = encode(GameEvent.ACTION, { action: "increment", payload: null });
    await do_.webSocketMessage(ws as unknown as WebSocket, buf);
    expect(ws.sent.length).toBe(sentBefore);
  });
});

describe("webSocketClose", () => {
  it("removes player and calls onLeave on close", async () => {
    const leaveSpy = vi.fn();
    class WatchedRoom extends GameRoom<object> {
      initialState() { return {}; }
      onLeave(p: Player) { leaveSpy(p.id); }
    }

    const DOClass = GameRoomDO.for(WatchedRoom);
    const state = makeDOState();
    const do_ = new DOClass(state, makeEnv());
    const { ws } = await connectPlayer(do_, state);

    await do_.webSocketClose(ws as unknown as WebSocket, 1001, "going away");
    expect(leaveSpy).toHaveBeenCalledOnce();
  });
});
