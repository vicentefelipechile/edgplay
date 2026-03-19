import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockWebSocket, pushFrame } from "./setup.js";
import { LobbyConnection } from "../src/LobbyConnection.js";
import { LobbyEvent, GameEvent } from "edgplay";

beforeEach(() => MockWebSocket._reset());

function makeLobby() {
  return new LobbyConnection("ws://test/lobby/chess");
}

// ─── LOBBY_LIST ───────────────────────────────────────────────────────────────

describe("LOBBY_LIST", () => {
  it("emits ROOM_LIST with the full snapshot", () => {
    const lobby = makeLobby();
    const fn = vi.fn();
    lobby.on(LobbyEvent.ROOM_LIST, fn);

    const rooms = [
      { roomId: "r1", data: { players: 1 } },
      { roomId: "r2", data: { players: 0 } },
    ];
    pushFrame(GameEvent.LOBBY_LIST, rooms);
    expect(fn).toHaveBeenCalledWith(rooms);
  });

  it("populates rooms getter after LOBBY_LIST", () => {
    const lobby = makeLobby();
    pushFrame(GameEvent.LOBBY_LIST, [{ roomId: "r1", data: {} }]);
    expect(lobby.rooms).toHaveLength(1);
    expect(lobby.rooms[0].roomId).toBe("r1");
  });

  it("replaces previous rooms on a second LOBBY_LIST", () => {
    const lobby = makeLobby();
    pushFrame(GameEvent.LOBBY_LIST, [{ roomId: "r1", data: {} }]);
    pushFrame(GameEvent.LOBBY_LIST, [{ roomId: "r2", data: {} }]);
    expect(lobby.rooms).toHaveLength(1);
    expect(lobby.rooms[0].roomId).toBe("r2");
  });
});

// ─── LOBBY_PATCH — add ────────────────────────────────────────────────────────

describe("LOBBY_PATCH add", () => {
  it("emits ROOM_ADDED", () => {
    const lobby = makeLobby();
    const fn = vi.fn();
    lobby.on(LobbyEvent.ROOM_ADDED, fn);

    pushFrame(GameEvent.LOBBY_PATCH, { op: "add", roomId: "r1", data: { players: 0 } });
    expect(fn).toHaveBeenCalledWith({ roomId: "r1", data: { players: 0 } });
  });

  it("adds the room to rooms getter", () => {
    const lobby = makeLobby();
    pushFrame(GameEvent.LOBBY_PATCH, { op: "add", roomId: "r1", data: {} });
    expect(lobby.rooms.some(r => r.roomId === "r1")).toBe(true);
  });
});

// ─── LOBBY_PATCH — update ─────────────────────────────────────────────────────

describe("LOBBY_PATCH update", () => {
  it("emits ROOM_UPDATED for known room", () => {
    const lobby = makeLobby();
    const fn = vi.fn();
    lobby.on(LobbyEvent.ROOM_UPDATED, fn);

    pushFrame(GameEvent.LOBBY_PATCH, { op: "add",    roomId: "r1", data: { players: 0 } });
    pushFrame(GameEvent.LOBBY_PATCH, { op: "update", roomId: "r1", data: { players: 1 } });

    expect(fn).toHaveBeenCalledWith({ roomId: "r1", data: { players: 1 } });
  });

  it("updates the room data in rooms getter", () => {
    const lobby = makeLobby();
    pushFrame(GameEvent.LOBBY_PATCH, { op: "add",    roomId: "r1", data: { players: 0 } });
    pushFrame(GameEvent.LOBBY_PATCH, { op: "update", roomId: "r1", data: { players: 2 } });
    expect(lobby.rooms[0].data.players).toBe(2);
  });

  it("does NOT emit ROOM_UPDATED for unknown room", () => {
    const lobby = makeLobby();
    const fn = vi.fn();
    lobby.on(LobbyEvent.ROOM_UPDATED, fn);
    pushFrame(GameEvent.LOBBY_PATCH, { op: "update", roomId: "ghost", data: {} });
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── LOBBY_PATCH — remove ─────────────────────────────────────────────────────

describe("LOBBY_PATCH remove", () => {
  it("emits ROOM_REMOVED for known room", () => {
    const lobby = makeLobby();
    const fn = vi.fn();
    lobby.on(LobbyEvent.ROOM_REMOVED, fn);

    pushFrame(GameEvent.LOBBY_PATCH, { op: "add",    roomId: "r1", data: {} });
    pushFrame(GameEvent.LOBBY_PATCH, { op: "remove", roomId: "r1" });

    expect(fn).toHaveBeenCalledWith({ roomId: "r1" });
  });

  it("removes room from rooms getter", () => {
    const lobby = makeLobby();
    pushFrame(GameEvent.LOBBY_PATCH, { op: "add",    roomId: "r1", data: {} });
    pushFrame(GameEvent.LOBBY_PATCH, { op: "remove", roomId: "r1" });
    expect(lobby.rooms).toHaveLength(0);
  });

  it("does NOT emit ROOM_REMOVED for unknown room", () => {
    const lobby = makeLobby();
    const fn = vi.fn();
    lobby.on(LobbyEvent.ROOM_REMOVED, fn);
    pushFrame(GameEvent.LOBBY_PATCH, { op: "remove", roomId: "ghost" });
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── disconnect ───────────────────────────────────────────────────────────────

describe("disconnect()", () => {
  it("closes the WebSocket", () => {
    const lobby = makeLobby();
    const ws = MockWebSocket.latest;
    const spy = vi.spyOn(ws, "close");
    lobby.disconnect();
    expect(spy).toHaveBeenCalledWith(1000, "left");
  });

  it("clears all listeners", () => {
    const lobby = makeLobby();
    const fn = vi.fn();
    lobby.on(LobbyEvent.ROOM_LIST, fn);
    lobby.disconnect();
    pushFrame(GameEvent.LOBBY_LIST, []);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── malformed frames ─────────────────────────────────────────────────────────

describe("malformed frames", () => {
  it("ignores non-ArrayBuffer messages", () => {
    const lobby = makeLobby();
    const fn = vi.fn();
    lobby.on(LobbyEvent.ROOM_LIST, fn);
    MockWebSocket.latest._trigger("message", "text");
    expect(fn).not.toHaveBeenCalled();
  });
});
