import { describe, it, expect, vi, beforeEach } from "vitest";
import { LobbyDO } from "../src/LobbyDO.js";
import { decode } from "../src/protocol/index.js";
import { GameEvent } from "../src/enums.js";
import type { EdgplayEnv } from "../src/createEngine.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

class MockWebSocket {
  readyState = 1;
  sent: ArrayBuffer[] = [];
  _attachment: unknown = null;

  send(data: ArrayBuffer) { this.sent.push(data); }
  close() { this.readyState = 3; }
  serializeAttachment(v: unknown) { this._attachment = v; }
  deserializeAttachment() { return this._attachment; }
}

function makeDOState(): DurableObjectState {
  return {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    storage: {} as DurableObjectStorage,
    id: { name: "lobby:chess" } as unknown as DurableObjectId,
    blockConcurrencyWhile: vi.fn(),
    waitUntil: vi.fn(),
    abort: vi.fn(),
  } as unknown as DurableObjectState;
}

function makeEnv(kv?: KVNamespace): EdgplayEnv {
  const ns = {
    idFromName: vi.fn().mockReturnValue("id"),
    get: vi.fn(),
  } as unknown as DurableObjectNamespace;
  return { GAME_ROOM: ns, LOBBY: ns, LOBBY_CACHE: kv };
}

function makeLobby(kv?: KVNamespace) {
  const state = makeDOState();
  const env = makeEnv(kv);
  const lobby = new LobbyDO(state, env);
  return { lobby, state, env };
}

function notifyReq(body: object): Request {
  return new Request("https://internal/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Inject a mock subscriber directly via _subscribeWs — avoids the 101 Response
// that Node's fetch rejects. The fetch/upgrade path is a CF runtime concern.
function addSubscriber(lobby: LobbyDO): MockWebSocket {
  const ws = new MockWebSocket() as unknown as WebSocket;
  (lobby as unknown as { _subscribeWs: (ws: WebSocket) => void })._subscribeWs(ws);
  return ws as unknown as MockWebSocket;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /list", () => {
  it("returns empty array when no rooms exist", async () => {
    const { lobby } = makeLobby();
    const res = await lobby.fetch(new Request("https://x.com/list"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns listed rooms after a notify", async () => {
    const { lobby } = makeLobby();
    await lobby.fetch(notifyReq({
      roomId: "r1", listed: true, data: { players: 1, maxPlayers: 2 }
    }));
    const res = await lobby.fetch(new Request("https://x.com/list"));
    const body = await res.json() as Array<{ roomId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].roomId).toBe("r1");
  });

  it("excludes unlisted rooms", async () => {
    const { lobby } = makeLobby();
    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data: { players: 2 } }));
    await lobby.fetch(notifyReq({ roomId: "r2", listed: false, data: {} }));
    const res = await lobby.fetch(new Request("https://x.com/list"));
    const body = await res.json() as Array<{ roomId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].roomId).toBe("r1");
  });
});

describe("POST /notify — room add", () => {
  it("returns 200 ok", async () => {
    const { lobby } = makeLobby();
    const res = await lobby.fetch(notifyReq({
      roomId: "r1", listed: true, data: {}
    }));
    expect(res.status).toBe(200);
  });

  it("returns 400 for missing roomId", async () => {
    const { lobby } = makeLobby();
    const res = await lobby.fetch(notifyReq({ listed: true, data: {} }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for bad JSON", async () => {
    const { lobby } = makeLobby();
    const res = await lobby.fetch(new Request("https://x.com/notify", {
      method: "POST",
      body: "not json",
    }));
    expect(res.status).toBe(400);
  });
});

describe("_applyUpdate — patch op logic", () => {
  it("emits 'add' op for a new listed room", async () => {
    const { lobby } = makeLobby();
    const ws = addSubscriber(lobby);

    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data: { players: 0 } }));

    expect(ws.sent.length).toBeGreaterThan(0);
    const patch = decode(ws.sent[ws.sent.length - 1]);
    expect(patch?.type).toBe(GameEvent.LOBBY_PATCH);
    expect((patch?.payload as { op: string }).op).toBe("add");
  });

  it("emits 'update' op when listed room data changes", async () => {
    const { lobby } = makeLobby();

    // First add
    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data: { players: 0 } }));

    const ws = addSubscriber(lobby);
    const sentBefore = ws.sent.length;

    // Update
    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data: { players: 1 } }));

    const newFrames = ws.sent.slice(sentBefore);
    expect(newFrames.length).toBe(1);
    const patch = decode(newFrames[0]);
    expect((patch?.payload as { op: string; roomId: string }).op).toBe("update");
    expect((patch?.payload as { op: string; roomId: string }).roomId).toBe("r1");
  });

  it("emits 'remove' op when listed room becomes unlisted", async () => {
    const { lobby } = makeLobby();
    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data: {} }));

    const ws = addSubscriber(lobby);
    const sentBefore = ws.sent.length;

    await lobby.fetch(notifyReq({ roomId: "r1", listed: false, data: {} }));

    const newFrames = ws.sent.slice(sentBefore);
    expect(newFrames.length).toBe(1);
    const patch = decode(newFrames[0]);
    expect((patch?.payload as { op: string }).op).toBe("remove");
  });

  it("emits no patch when data is identical", async () => {
    const { lobby } = makeLobby();
    const data = { players: 1, maxPlayers: 2 };
    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data }));

    const ws = addSubscriber(lobby);
    const sentBefore = ws.sent.length;

    // Same data — should produce no patch
    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data }));
    expect(ws.sent.length).toBe(sentBefore);
  });

  it("emits no patch for an unlisted room that was never listed", async () => {
    const { lobby } = makeLobby();
    const ws = addSubscriber(lobby);
    const sentBefore = ws.sent.length;

    await lobby.fetch(notifyReq({ roomId: "ghost", listed: false, data: {} }));
    expect(ws.sent.length).toBe(sentBefore);
  });
});

describe("LOBBY_LIST on subscribe", () => {
  it("sends a LOBBY_LIST frame immediately on subscribe", () => {
    const { lobby } = makeLobby();
    const ws = addSubscriber(lobby);

    // The subscriber should have received LOBBY_LIST
    expect(ws.sent.length).toBeGreaterThan(0);
    const msg = decode(ws.sent[0]);
    expect(msg?.type).toBe(GameEvent.LOBBY_LIST);
    expect(Array.isArray(msg?.payload)).toBe(true);
  });

  it("includes pre-existing rooms in the initial LOBBY_LIST", async () => {
    const { lobby } = makeLobby();
    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data: { players: 1 } }));

    const ws = addSubscriber(lobby);
    const msg = decode(ws.sent[0]);
    const list = msg?.payload as Array<{ roomId: string }>;
    expect(list.some(r => r.roomId === "r1")).toBe(true);
  });
});

describe("KV snapshot", () => {
  it("writes snapshot to KV after a notify that changes state", async () => {
    const mockKv = { put: vi.fn().mockResolvedValue(undefined) } as unknown as KVNamespace;
    const { lobby } = makeLobby(mockKv);

    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data: {} }));
    expect(mockKv.put).toHaveBeenCalledOnce();
  });

  it("does not write KV when data is unchanged", async () => {
    const mockKv = { put: vi.fn().mockResolvedValue(undefined) } as unknown as KVNamespace;
    const { lobby } = makeLobby(mockKv);
    const data = { players: 1 };

    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data }));
    await lobby.fetch(notifyReq({ roomId: "r1", listed: true, data })); // same

    expect(mockKv.put).toHaveBeenCalledOnce(); // only on first add
  });

  it("does not write KV when LOBBY_CACHE is not configured", async () => {
    const { lobby } = makeLobby(); // no KV
    // Should not throw — just silently skips the write
    await expect(
      lobby.fetch(notifyReq({ roomId: "r1", listed: true, data: {} }))
    ).resolves.toBeDefined();
  });
});

describe("webSocketClose", () => {
  it("removes subscriber on close", () => {
    const { lobby } = makeLobby();
    const ws = addSubscriber(lobby);

    const subId = ws.deserializeAttachment() as string;
    const subMap = (lobby as unknown as { subscribers: Map<string, unknown> }).subscribers;
    expect(subMap.has(subId)).toBe(true);

    lobby.webSocketClose(ws as unknown as WebSocket);
    expect(subMap.has(subId)).toBe(false);
  });
});

describe("unknown routes", () => {
  it("returns 404 for unknown paths", async () => {
    const { lobby } = makeLobby();
    const res = await lobby.fetch(new Request("https://x.com/unknown"));
    expect(res.status).toBe(404);
  });
});
