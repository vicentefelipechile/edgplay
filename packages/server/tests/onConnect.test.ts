import { describe, it, expect, vi, beforeEach } from "vitest";
import { GameRoomDO } from "../src/GameRoomDO.js";
import { GameRoom } from "../src/GameRoom.js";
import type { Player } from "../src/Player.js";
import { encode } from "../src/protocol/index.js";
import { GameEvent } from "../src/enums.js";
import type { EdgplayEnv } from "../src/createEngine.js";
import type { D1Adapter } from "../src/persistence/D1Adapter.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

class MockWebSocket {
  readyState = 1;
  sent: ArrayBuffer[] = [];
  closed: { code: number; reason: string } | null = null;
  _attachment: unknown = null;

  send(data: ArrayBuffer) { this.sent.push(data); }
  close(code = 1000, reason = "") { this.closed = { code, reason }; this.readyState = 3; }
  serializeAttachment(v: unknown) { this._attachment = v; }
  deserializeAttachment() { return this._attachment; }
}

function makeDOState(): DurableObjectState {
  const store = new Map<string, unknown>();
  return {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    storage: {
      put:    vi.fn().mockImplementation((k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); }),
      get:    vi.fn().mockImplementation((k: string) => Promise.resolve(store.get(k))),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as DurableObjectStorage,
    id: {} as DurableObjectId,
    blockConcurrencyWhile: vi.fn().mockImplementation((fn: () => Promise<void>) => fn()),
    waitUntil: vi.fn(),
    abort: vi.fn(),
  } as unknown as DurableObjectState;
}

function makeEnv(): EdgplayEnv {
  const ns = {
    idFromName: vi.fn().mockReturnValue("id"),
    get: vi.fn().mockReturnValue({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }),
  } as unknown as DurableObjectNamespace;
  return { GAME_ROOM: ns, LOBBY: ns };
}

class SimpleRoom extends GameRoom<{ x: number }> {
  initialState() { return { x: 0 }; }
}

async function connectPlayer(do_: GameRoomDO, url = "https://example.com/room/chess/r1") {
  const ws  = new MockWebSocket() as unknown as WebSocket;
  const req = new Request(url);
  await (do_ as unknown as { _onOpen: (ws: WebSocket, req: Request) => Promise<void> })._onOpen(ws, req);
  return { ws: ws as unknown as MockWebSocket };
}

// ─── onConnect middleware ─────────────────────────────────────────────────────

describe("onConnect middleware", () => {
  it("runs before canJoin and onJoin", async () => {
    const order: string[] = [];

    class WatchedRoom extends GameRoom<object> {
      initialState() { return {}; }
      canJoin()  { order.push("canJoin"); return true; }
      onJoin()   { order.push("onJoin"); }
    }

    const middleware = vi.fn(async (player: Player) => {
      order.push("onConnect");
      await player.identify({ public: { name: "test" }, private: {} });
    });

    const DOClass = GameRoomDO.for(WatchedRoom, undefined, middleware);
    const do_ = new DOClass(makeDOState(), makeEnv());
    await connectPlayer(do_);

    expect(order).toEqual(["onConnect", "canJoin", "onJoin"]);
    expect(middleware).toHaveBeenCalledOnce();
  });

  it("player.reject() in onConnect closes WS with 4001 and skips canJoin/onJoin", async () => {
    const canJoinSpy = vi.fn().mockReturnValue(true);
    const onJoinSpy  = vi.fn();

    class WatchedRoom extends GameRoom<object> {
      initialState() { return {}; }
      canJoin()  { canJoinSpy(); return true; }
      onJoin()   { onJoinSpy(); }
    }

    const DOClass = GameRoomDO.for(
      WatchedRoom,
      undefined,
      (player) => { player.reject("unauthorized"); }
    );
    const do_ = new DOClass(makeDOState(), makeEnv());
    const { ws } = await connectPlayer(do_);

    expect(ws.closed?.code).toBe(4001);
    expect(ws.closed?.reason).toBe("unauthorized");
    expect(canJoinSpy).not.toHaveBeenCalled();
    expect(onJoinSpy).not.toHaveBeenCalled();
  });

  it("player identity set in onConnect is available in onJoin", async () => {
    let nameInJoin: unknown;

    class WatchedRoom extends GameRoom<object> {
      initialState() { return {}; }
      onJoin(player: Player) { nameInJoin = player.identity.public.name; }
    }

    const DOClass = GameRoomDO.for(
      WatchedRoom,
      undefined,
      async (player) => {
        await player.identify({ public: { name: "Vicente" }, private: {} });
      }
    );
    const do_ = new DOClass(makeDOState(), makeEnv());
    await connectPlayer(do_);

    expect(nameInJoin).toBe("Vicente");
  });

  it("token from URL query param can be used in onConnect", async () => {
    let capturedToken: string | null = null;

    const DOClass = GameRoomDO.for(
      SimpleRoom,
      undefined,
      async (player, req) => {
        capturedToken = new URL(req.url).searchParams.get("token");
        await player.identify({ public: {}, private: {} });
      }
    );
    const do_ = new DOClass(makeDOState(), makeEnv());
    await connectPlayer(do_, "https://example.com/room/chess/r1?token=abc123");

    expect(capturedToken).toBe("abc123");
  });

  it("no middleware — player joins with empty identity", async () => {
    const DOClass = GameRoomDO.for(SimpleRoom);
    const do_     = new DOClass(makeDOState(), makeEnv());
    await connectPlayer(do_);

    const players = (do_ as unknown as { room: GameRoom<object> }).room.players;
    const player  = [...players.values()][0] as Player;
    expect(player.identity.public).toEqual({});
    expect(player.identity.private).toEqual({});
  });
});

// ─── player.identify() ───────────────────────────────────────────────────────

describe("player.identify()", () => {
  it("sets identity.public and identity.private", async () => {
    let captured: Player | null = null;

    class WatchedRoom extends GameRoom<object> {
      initialState() { return {}; }
      onJoin(player: Player) { captured = player; }
    }

    const DOClass = GameRoomDO.for(
      WatchedRoom,
      undefined,
      async (player) => {
        await player.identify({
          public:  { name: "Alice", level: 5 },
          private: { email: "alice@example.com" },
        });
      }
    );
    const do_ = new DOClass(makeDOState(), makeEnv());
    await connectPlayer(do_);

    expect(captured!.identity.public.name).toBe("Alice");
    expect(captured!.identity.public.level).toBe(5);
    expect(captured!.identity.private.email).toBe("alice@example.com");
  });

  it("validates with Zod schema — rejects player on failure", async () => {
    const { z } = await import("zod");

    const schemas = {
      public:  z.object({ name: z.string().min(1) }),
      private: z.object({ chips: z.number().int().min(0) }),
    };

    const DOClass = GameRoomDO.for(
      SimpleRoom,
      undefined,
      async (player) => {
        // chips is negative — should fail Zod validation
        await player.identify({
          public:  { name: "Alice" },
          private: { chips: -50 },
        });
      },
      schemas
    );

    const do_ = new DOClass(makeDOState(), makeEnv());
    const { ws } = await connectPlayer(do_);

    // Player should be rejected due to validation failure
    expect(ws.closed).not.toBeNull();
    expect(ws.closed?.code).toBe(4001);
    expect(ws.closed?.reason).toContain("validation failed");
  });

  it("validates with Zod schema — accepts valid data", async () => {
    const { z } = await import("zod");

    const schemas = {
      public:  z.object({ name: z.string() }),
      private: z.object({ chips: z.number().int().min(0).default(100) }),
    };

    let capturedChips: unknown;

    class WatchedRoom extends GameRoom<object> {
      initialState() { return {}; }
      onJoin(player: Player) { capturedChips = player.identity.private.chips; }
    }

    const DOClass = GameRoomDO.for(
      WatchedRoom,
      undefined,
      async (player) => {
        await player.identify({
          public:  { name: "Bob" },
          private: {},  // chips not provided — Zod default (100) should apply
        });
      },
      schemas
    );

    const do_ = new DOClass(makeDOState(), makeEnv());
    const { ws } = await connectPlayer(do_);

    expect(ws.closed).toBeNull();
    expect(capturedChips).toBe(100); // Zod default applied
  });

  it("merges stored D1 data with provided data — provided wins", async () => {
    let capturedLevel: unknown;

    class WatchedRoom extends GameRoom<object> {
      initialState() { return {}; }
      onJoin(player: Player) { capturedLevel = player.identity.public.level; }
    }

    // Mock D1 adapter that returns stored data
    const mockAdapter = {
      loadPlayer: vi.fn().mockResolvedValue({
        public:  { name: "Alice", level: 42 },  // stored level = 42
        private: { chips: 500 },
      }),
      savePlayer:       vi.fn().mockResolvedValue(undefined),
      ensureSchema:     vi.fn().mockResolvedValue(undefined),
      getPublicProfile: vi.fn().mockResolvedValue(null),
    } as unknown as D1Adapter;

    const makeAdapter = () => mockAdapter;

    const DOClass = GameRoomDO.for(
      WatchedRoom,
      makeAdapter,
      async (player) => {
        await player.identify({
          id:      "player-alice",
          public:  { name: "Alice", level: 99 }, // override stored level
          private: {},
        });
      }
    );

    const do_ = new DOClass(makeDOState(), makeEnv());
    await connectPlayer(do_);

    // Provided level (99) overrides stored level (42)
    expect(capturedLevel).toBe(99);
    expect(mockAdapter.loadPlayer).toHaveBeenCalledWith("player-alice");
  });

  it("uses stored D1 data as defaults when not provided", async () => {
    let capturedChips: unknown;

    class WatchedRoom extends GameRoom<object> {
      initialState() { return {}; }
      onJoin(player: Player) { capturedChips = player.identity.private.chips; }
    }

    const mockAdapter = {
      loadPlayer: vi.fn().mockResolvedValue({
        public:  { name: "Alice" },
        private: { chips: 750 }, // stored chips
      }),
      savePlayer:       vi.fn().mockResolvedValue(undefined),
      ensureSchema:     vi.fn().mockResolvedValue(undefined),
      getPublicProfile: vi.fn().mockResolvedValue(null),
    } as unknown as D1Adapter;

    const DOClass = GameRoomDO.for(
      WatchedRoom,
      () => mockAdapter,
      async (player) => {
        await player.identify({
          id:      "player-alice",
          public:  { name: "Alice" },
          private: {}, // chips not provided — should use stored value
        });
      }
    );

    const do_ = new DOClass(makeDOState(), makeEnv());
    await connectPlayer(do_);

    expect(capturedChips).toBe(750); // stored value used as default
  });

  it("player.save() calls D1 adapter savePlayer", async () => {
    const mockAdapter = {
      loadPlayer:       vi.fn().mockResolvedValue(null),
      savePlayer:       vi.fn().mockResolvedValue(undefined),
      ensureSchema:     vi.fn().mockResolvedValue(undefined),
      getPublicProfile: vi.fn().mockResolvedValue(null),
    } as unknown as D1Adapter;

    let capturedPlayer: Player | null = null;

    class WatchedRoom extends GameRoom<object> {
      initialState() { return {}; }
      onJoin(player: Player) { capturedPlayer = player; }
    }

    const DOClass = GameRoomDO.for(
      WatchedRoom,
      () => mockAdapter,
      async (player) => {
        await player.identify({ public: { name: "Bob" }, private: { chips: 100 } });
      }
    );

    const do_ = new DOClass(makeDOState(), makeEnv());
    await connectPlayer(do_);

    await capturedPlayer!.save();
    expect(mockAdapter.savePlayer).toHaveBeenCalledOnce();
  });
});

// ─── PLAYER_JOIN includes identity.public ────────────────────────────────────

describe("PLAYER_JOIN event", () => {
  it("includes public identity when second player joins", async () => {
    const { decode } = await import("../src/protocol/index.js");

    const DOClass = GameRoomDO.for(
      SimpleRoom,
      undefined,
      async (player) => {
        await player.identify({ public: { name: "Alice" }, private: {} });
      }
    );
    const do_  = new DOClass(makeDOState(), makeEnv());

    // First player connects
    const { ws: ws1 } = await connectPlayer(do_);
    const sentBefore = ws1.sent.length;

    // Second player connects — first player should receive PLAYER_JOIN
    await connectPlayer(do_);

    const newFrames = ws1.sent.slice(sentBefore);
    const joinFrame = newFrames.find(f => {
      const msg = decode(f as ArrayBuffer);
      return msg?.type === GameEvent.PLAYER_JOIN;
    });

    expect(joinFrame).toBeDefined();
    const msg = decode(joinFrame as ArrayBuffer);
    expect((msg!.payload as { identity: { name: string } }).identity.name).toBe("Alice");
  });
});
