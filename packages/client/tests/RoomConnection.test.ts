import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockWebSocket, pushFrame, pushBadFrame, serverClose } from "./setup.js";
import { RoomConnection } from "../src/RoomConnection.js";
import { RoomEvent, DisconnectReason, GameEvent } from "edgplay";
import { decode } from "edgplay";

beforeEach(() => MockWebSocket._reset());

function makeRoom(url = "ws://test/room/chess/r1") {
  return new RoomConnection(url, { maxAttempts: 2, baseDelayMs: 10 });
}

// ─── Connection ───────────────────────────────────────────────────────────────

describe("connection", () => {
  it("connects to the provided URL", () => {
    makeRoom("ws://x.com/room/chess/abc");
    expect(MockWebSocket.latest.url).toBe("ws://x.com/room/chess/abc");
  });

  it("sets binaryType to arraybuffer", () => {
    makeRoom();
    expect(MockWebSocket.latest.binaryType).toBe("arraybuffer");
  });
});

// ─── GameEvent → RoomEvent translation ───────────────────────────────────────

describe("GameEvent → RoomEvent", () => {
  it("STATE_FULL → STATE_CHANGE", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.STATE_CHANGE, fn);
    pushFrame(GameEvent.STATE_FULL, { board: "rnbq" });
    expect(fn).toHaveBeenCalledWith({ board: "rnbq" });
  });

  it("STATE_PATCH → STATE_PATCH", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.STATE_PATCH, fn);
    pushFrame(GameEvent.STATE_PATCH, { turn: "black" });
    expect(fn).toHaveBeenCalledWith({ turn: "black" });
  });

  it("PLAYER_JOIN → PLAYER_JOIN", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.PLAYER_JOIN, fn);
    pushFrame(GameEvent.PLAYER_JOIN, { id: "p1", identity: { name: "Alice" } });
    expect(fn).toHaveBeenCalledWith({ id: "p1", identity: { name: "Alice" } });
  });

  it("PLAYER_LEAVE → PLAYER_LEAVE", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.PLAYER_LEAVE, fn);
    pushFrame(GameEvent.PLAYER_LEAVE, { id: "p1", reason: "left" });
    expect(fn).toHaveBeenCalledWith({ id: "p1", reason: "left" });
  });

  it("GAME_START → GAME_START", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.GAME_START, fn);
    pushFrame(GameEvent.GAME_START, null);
    expect(fn).toHaveBeenCalledWith(null);
  });

  it("GAME_OVER → GAME_OVER", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.GAME_OVER, fn);
    pushFrame(GameEvent.GAME_OVER, { winner: "white", reason: "resign" });
    expect(fn).toHaveBeenCalledWith({ winner: "white", reason: "resign" });
  });

  it("CHAT → CHAT", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.CHAT, fn);
    pushFrame(GameEvent.CHAT, { text: "gg" });
    expect(fn).toHaveBeenCalledWith({ text: "gg" });
  });

  it("CHAT_PRIVATE → CHAT (same handler)", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.CHAT, fn);
    pushFrame(GameEvent.CHAT_PRIVATE, { text: "psst" });
    expect(fn).toHaveBeenCalledWith({ text: "psst" });
  });

  it("EMOTE → EMOTE", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.EMOTE, fn);
    pushFrame(GameEvent.EMOTE, { emote: "wave" });
    expect(fn).toHaveBeenCalledWith({ emote: "wave" });
  });
});

// ─── PING auto-reply ──────────────────────────────────────────────────────────

describe("PING → auto PONG", () => {
  it("responds to PING with a PONG frame", () => {
    makeRoom();
    const ws = MockWebSocket.latest;
    pushFrame(GameEvent.PING, null, ws);
    expect(ws.sent.length).toBe(1);
    const msg = decode(ws.sent[0] as ArrayBuffer);
    expect(msg?.type).toBe(GameEvent.PONG);
  });

  it("does not emit any RoomEvent for PING", () => {
    const room = makeRoom();
    const fn = vi.fn();
    // Listen to all events we care about
    Object.values(RoomEvent).forEach(ev => room.on(ev as RoomEvent, fn));
    pushFrame(GameEvent.PING, null);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── CRC / malformed frames ───────────────────────────────────────────────────

describe("malformed frames", () => {
  it("silently discards frames with bad CRC", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.STATE_CHANGE, fn);
    pushBadFrame();
    expect(fn).not.toHaveBeenCalled();
  });

  it("silently discards non-ArrayBuffer messages", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.STATE_CHANGE, fn);
    MockWebSocket.latest._trigger("message", "text message");
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── send / sendRaw ───────────────────────────────────────────────────────────

describe("send()", () => {
  it("encodes as ACTION frame with action name and payload", () => {
    makeRoom();
    const ws = MockWebSocket.latest;
    const room = new RoomConnection(ws.url);
    // Get the second WS (created by RoomConnection constructor)
    const activeWs = MockWebSocket.latest;

    room.send("move", { from: "e2", to: "e4" });

    expect(activeWs.sent.length).toBe(1);
    const msg = decode(activeWs.sent[0] as ArrayBuffer);
    expect(msg?.type).toBe(GameEvent.ACTION);
    expect((msg?.payload as { action: string }).action).toBe("move");
  });

  it("does nothing when WebSocket is not OPEN", () => {
    const room = makeRoom();
    const ws = MockWebSocket.latest;
    ws.readyState = MockWebSocket.CLOSED;
    room.send("move", {});
    expect(ws.sent.length).toBe(0);
  });
});

describe("sendRaw()", () => {
  it("encodes as the given type", () => {
    const room = makeRoom();
    const ws = MockWebSocket.latest;
    room.sendRaw(0x50, { spell: "fireball" });
    expect(ws.sent.length).toBe(1);
    const msg = decode(ws.sent[0] as ArrayBuffer);
    expect(msg?.type).toBe(0x50);
  });
});

// ─── leave() ─────────────────────────────────────────────────────────────────

describe("leave()", () => {
  it("closes the WebSocket with code 1000", () => {
    const room = makeRoom();
    const ws = MockWebSocket.latest;
    const closeSpy = vi.spyOn(ws, "close");
    room.leave();
    expect(closeSpy).toHaveBeenCalledWith(1000, "left");
  });

  it("emits DISCONNECTED with reason LEFT", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.DISCONNECTED, fn);
    room.leave();
    expect(fn).toHaveBeenCalledWith(DisconnectReason.LEFT);
  });

  it("does not attempt reconnect after leave()", () => {
    const room = makeRoom();
    room.leave();
    const instancesBefore = MockWebSocket._instances.length;
    // Even after close fires, no new WebSocket should be created
    expect(MockWebSocket._instances.length).toBe(instancesBefore);
  });
});

// ─── Reconnect logic ──────────────────────────────────────────────────────────

describe("reconnect", () => {
  it("emits RECONNECTING when connection drops unexpectedly", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.RECONNECTING, fn);
    serverClose(1001); // LOST
    expect(fn).toHaveBeenCalledWith({ attempt: 1, maxAttempts: 2 });
  });

  it("does not reconnect on normal close (1000)", () => {
    const room = makeRoom();
    const fn = vi.fn();
    room.on(RoomEvent.RECONNECTING, fn);
    serverClose(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not reconnect when room is full (4000)", () => {
    const room = makeRoom();
    const reconnFn = vi.fn();
    const discFn = vi.fn();
    room.on(RoomEvent.RECONNECTING, reconnFn);
    room.on(RoomEvent.DISCONNECTED, discFn);
    serverClose(4000);
    expect(reconnFn).not.toHaveBeenCalled();
    expect(discFn).toHaveBeenCalledWith(DisconnectReason.KICKED);
  });

  it("emits RECONNECTING once per attempt", () => {
    const room = makeRoom(); // maxAttempts: 2
    const fn = vi.fn();
    room.on(RoomEvent.RECONNECTING, fn);

    serverClose(1006); // attempt 1
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ attempt: 1, maxAttempts: 2 });
  });
});
