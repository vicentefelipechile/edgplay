import { describe, it, expect, vi } from "vitest";
import { createEngine } from "../src/createEngine.js";
import { GameRoom } from "../src/GameRoom.js";
import type { EdgplayEnv } from "../src/createEngine.js";

// ─── Minimal GameRoom stub ────────────────────────────────────────────────────

class TestRoom extends GameRoom<{ status: string }> {
  initialState() { return { status: "waiting" }; }
}

// ─── Mock EdgplayEnv ─────────────────────────────────────────────────────────

function makeMockDONamespace(fetchResponse: Response = new Response("ok")): DurableObjectNamespace {
  const stub = { fetch: vi.fn().mockResolvedValue(fetchResponse) } as unknown as DurableObjectStub;
  return {
    idFromName: vi.fn().mockReturnValue("mock-id"),
    get: vi.fn().mockReturnValue(stub),
    idFromString: vi.fn(),
    newUniqueId: vi.fn(),
    jurisdiction: vi.fn(),
  } as unknown as DurableObjectNamespace;
}

function makeEnv(overrides: Partial<EdgplayEnv> = {}): EdgplayEnv {
  return {
    GAME_ROOM: makeMockDONamespace(),
    LOBBY: makeMockDONamespace(),
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

// ─── Helper: call worker.fetch ────────────────────────────────────────────────

async function handle(
  path: string,
  options: RequestInit = {},
  env = makeEnv()
): Promise<Response> {
  const engine = createEngine().register("chess", TestRoom);
  const handler = engine.worker as { fetch: (req: Request, env: EdgplayEnv, ctx: ExecutionContext) => Promise<Response> };
  const req = new Request(`https://example.com${path}`, options);
  return handler.fetch(req, env, makeCtx());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET / — health check", () => {
  it("returns 200 with registered games", async () => {
    const res = await handle("/");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; games: string[] };
    expect(body.ok).toBe(true);
    expect(body.games).toContain("chess");
  });
});

describe("GET /room/:game/:roomId — WebSocket upgrade", () => {
  it("rejects unknown game with 404", async () => {
    const res = await handle("/room/notexist/room-1", {
      headers: { "Upgrade": "websocket" },
    });
    expect(res.status).toBe(404);
  });

  it("rejects non-WebSocket request with 426", async () => {
    const res = await handle("/room/chess/room-1");
    expect(res.status).toBe(426);
  });

  it("forwards WebSocket upgrade to GAME_ROOM DO", async () => {
    const env = makeEnv();
    const res = await handle("/room/chess/sala-123", {
      headers: { "Upgrade": "websocket" },
    }, env);

    // DO namespace should have been called with "chess:sala-123"
    expect(env.GAME_ROOM.idFromName).toHaveBeenCalledWith("chess:sala-123");
    expect(env.GAME_ROOM.get).toHaveBeenCalled();
  });
});

describe("POST /room/:game — create room", () => {
  it("rejects unknown game with 404", async () => {
    const res = await handle("/room/notexist", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns a roomId for known game", async () => {
    const res = await handle("/room/chess", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { roomId: string };
    expect(typeof body.roomId).toBe("string");
    expect(body.roomId.length).toBeGreaterThan(0);
  });

  it("initialises the DO on room creation", async () => {
    const env = makeEnv();
    await handle("/room/chess", { method: "POST" }, env);
    expect(env.GAME_ROOM.idFromName).toHaveBeenCalled();
    expect(env.GAME_ROOM.get).toHaveBeenCalled();
  });
});

describe("GET /lobby/:game — HTTP room list", () => {
  it("rejects unknown game with 404", async () => {
    const res = await handle("/lobby/notexist");
    expect(res.status).toBe(404);
  });

  it("falls back to LobbyDO when KV cache is absent", async () => {
    const env = makeEnv(); // no LOBBY_CACHE
    const res = await handle("/lobby/chess", {}, env);
    expect(env.LOBBY.idFromName).toHaveBeenCalledWith("lobby:chess");
  });

  it("returns KV cache when available and populated", async () => {
    const snapshot = [{ roomId: "abc", players: 1 }];
    const mockKV = {
      get: vi.fn().mockResolvedValue(snapshot),
    } as unknown as KVNamespace;
    const env = makeEnv({ LOBBY_CACHE: mockKV });

    const res = await handle("/lobby/chess", {}, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(snapshot);
    // Should NOT have hit the LobbyDO
    expect(env.LOBBY.idFromName).not.toHaveBeenCalled();
  });
});

describe("WS /lobby/:game — WebSocket upgrade to LobbyDO", () => {
  it("forwards WebSocket upgrade to LOBBY DO", async () => {
    const env = makeEnv();
    await handle("/lobby/chess", {
      headers: { "Upgrade": "websocket" },
    }, env);
    expect(env.LOBBY.idFromName).toHaveBeenCalledWith("lobby:chess");
  });
});

describe("GET /profile/:playerId", () => {
  it("returns 404 when DB is not configured", async () => {
    const res = await handle("/profile/player-123");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("D1");
  });
});

describe("unknown routes", () => {
  it("returns 404 for arbitrary paths", async () => {
    const res = await handle("/something/random");
    expect(res.status).toBe(404);
  });
});
