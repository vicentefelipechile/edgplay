# Edgplay — Proof of Concept

A lightweight multiplayer game framework built on **Cloudflare Durable Objects** and **WebSockets**, designed to let developers build turn-based and real-time multiplayer games without managing any infrastructure.

---

## Motivation

Existing solutions like Colyseus require you to host and maintain your own server. This project explores whether Cloudflare Durable Objects can serve as a fully serverless, zero-infrastructure alternative — where each game room is a Durable Object instance that lives at the edge, automatically scales, and persists its own state.

---

## Scope (Proof of Concept)

This is **not** a production-ready framework. The goal is to validate the core architecture with four increasing levels of complexity:

| # | Game | Key challenge |
|---|---|---|
| 1 | Chess | Basic turn-based state, 2 players |
| 2 | UNO | Multiple players, partial state (hand hidden from others) |
| 3 | Poker | Partial state + betting rounds + player roles |
| 4 | 3D Multiplayer | High-frequency state sync, positions, simulation loop |

SDKs for Unity or Godot are **out of scope**. The only client target is **JavaScript/TypeScript** (browser and Node.js).

---

## Architecture Overview

```
[Client A]──┐
[Client B]──┼──WebSocket──▶ [Cloudflare Worker (entry point)]
[Client C]──┘                        │
                          ┌──────────┴──────────┐
                          │                     │
                    routes to room         routes to lobby
                          ▼                     ▼
              [Durable Object: GameRoom]   [Durable Object: LobbyDO]
               ├── Player registry         ├── Active room index (memory)
               ├── Game state              ├── Subscribed clients (WebSocket)
               ├── Action handler          ├── Writes snapshot to KV (cache)
               └── Broadcaster             └── Notified by each GameRoom DO
```

- The **Worker** handles all HTTP routing, WebSocket upgrades, and lobby requests — generated entirely by `createEngine`, never written by the developer.
- The **GameRoom DO** is the authoritative game server for a single room. One DO instance = one room.
- The **LobbyDO** is a single DO instance per game type (e.g. `lobby:poker`) that acts as the room index.
- **Cloudflare KV** caches the lobby snapshot for fast initial reads globally.
- Clients communicate exclusively over **WebSocket with binary frames** (ArrayBuffer).
- State is kept **in-memory** during a session and **persisted to DO storage** on game end or on alarm tick.

---

## Repository Structure

```
edgplay/
├── packages/
│   ├── server/               # The core framework (Cloudflare Workers + DO)
│   │   ├── src/
│   │   │   ├── createEngine.ts   # Main entry point — bootstraps worker + DOs
│   │   │   ├── GameRoom.ts       # Abstract base class developers extend
│   │   │   ├── Player.ts         # Player + identity system
│   │   │   ├── LobbyDO.ts        # DO acting as room index per game type
│   │   │   ├── persistence/
│   │   │   │   ├── D1Adapter.ts      # Persistence via Cloudflare D1
│   │   │   │   └── DOStorageAdapter.ts # Fallback persistence via DO storage + TTL
│   │   │   ├── protocol/
│   │   │   │   ├── encode.ts     # Binary message encoding + CRC-8
│   │   │   │   └── decode.ts     # Binary message decoding + CRC-8 verification
│   │   │   └── index.ts          # Public exports
│   │   ├── wrangler.jsonc        # Template — developer copies and sets name
│   │   └── package.json
│   │
│   ├── client/               # JS/TS client SDK — UI framework agnostic
│   │   ├── src/
│   │   │   ├── createClient.ts    # Main entry point — creates a client instance
│   │   │   ├── RoomConnection.ts  # Manages WebSocket lifecycle + state updates
│   │   │   ├── LobbyConnection.ts # Manages lobby WebSocket + room list
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── cli/                  # npx edgplay — migration and dev tooling
│       ├── src/
│       │   ├── migrate/
│       │   │   ├── generate.ts   # Detects schema drift, generates migration files
│       │   │   ├── apply.ts      # Applies pending migrations to D1
│       │   │   ├── rollback.ts   # Reverts last applied migration
│       │   │   └── status.ts     # Shows applied vs pending migrations
│       │   └── index.ts          # CLI entry point (npx edgplay <command>)
│       └── package.json
│
├── examples/
│   ├── chess/                # Example game 1
│   │   ├── src/
│   │   │   ├── index.ts          # createEngine bootstrap
│   │   │   └── ChessRoom.ts      # GameRoom implementation
│   │   ├── client/               # Vanilla JS frontend example
│   │   └── wrangler.jsonc
│   ├── uno/                  # Example game 2
│   ├── poker/                # Example game 3
│   └── 3d-multiplayer/       # Example game 4 (Three.js or Babylon.js)
│
└── README.md
```

---

## Core Concepts

### 1. Engine bootstrap (`createEngine`)

The developer never writes routing, WebSocket upgrade logic, or fetch handlers. Everything is generated by `createEngine` via a fluent API inspired by Hono.

```ts
// src/index.ts — the entire infrastructure file the developer writes

import { createEngine } from "edgplay";
import { ChessRoom } from "./chess";
import { PokerRoom } from "./poker";

const engine = createEngine()
  .register("chess", ChessRoom)
  .register("poker", PokerRoom)
  .onConnect((player) => {
    // optional global middleware — runs before any room
    if (!player.token) return player.reject("unauthorized");
  });

// The Worker fetch handler — all routing handled by the framework
export default engine.worker;

// Static DO exports required by Cloudflare — generated by the framework
export const { GameRoom, LobbyDO } = engine.durableObjects;
```

The `GameRoom` and `LobbyDO` export names must remain fixed since `wrangler.jsonc` references them by name. The developer never touches routing, WebSocket upgrade, or lobby logic.

The recommended `wrangler.jsonc` (provided as a template — developer only changes `name`):

```jsonc
{
  "name": "my-game",
  "main": "src/index.ts",
  "durable_objects": {
    "bindings": [
      { "name": "GAME_ROOM", "class_name": "GameRoom" },
      { "name": "LOBBY",     "class_name": "LobbyDO"  }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_classes": ["GameRoom", "LobbyDO"] }
  ]
}
```

### 2. GameRoom (server-side)

The developer extends `GameRoom` and overrides lifecycle methods, defines actions, and optionally customizes lobby behavior. The framework handles everything else.

```ts
// src/chess.ts — pure game logic, zero infrastructure

import { GameRoom, type Player } from "edgplay";

export class ChessRoom extends GameRoom<ChessState> {

  initialState() {
    return { board: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR", turn: "white", status: "waiting" };
  }

  // Lifecycle
  onCreate(options: unknown): void {}
  onJoin(player: Player, options: unknown): void {
    player.data.color = this.players.size === 1 ? "white" : "black";
    if (this.players.size === 2) this.state.status = "playing";
  }
  onLeave(player: Player): void {}
  onDispose(): void {}

  // State visible to a given player — override for hidden state (Poker, UNO)
  stateFor(player: Player) {
    return this.state; // default: everyone sees everything
  }

  // Lobby behavior — override to control room discovery
  lobbyData() {
    return { players: this.players.size, maxPlayers: this.maxPlayers, status: this.state.status };
  }
  isListed() { return this.state.status === "waiting"; }
  canJoin(player: Player) { return this.players.size < this.maxPlayers; }

  // Game actions — go through the framework pipeline (validation, auto broadcastState)
  actions = {
    move: (player: Player, payload: { from: string; to: string }) => {
      if (this.state.turn !== player.data.color) return;
      // apply move...
      this.state.turn = player.data.color === "white" ? "black" : "white";
    }
  };

  // Custom messages — bypass the framework pipeline entirely for max efficiency
  messages = {
    [MyGameEvent.SPELL_CAST]: (player: Player, buffer: ArrayBuffer) => {
      // raw buffer access, no automatic broadcastState
    }
  };
}
```

### 3. Player & Identity System

A `Player` starts as an anonymous connection. The developer enriches it inside `onConnect` by calling `player.identify()`, which attaches a persistent identity split into two scopes:

- **`public`** — visible to other players in `playerJoin` / `playerLeave` events and in `lobbyData()`.
- **`private`** — server-side only, never sent to any client. Used for inventory, stats, currency, roles, etc.

```ts
interface Player {
  id: string;                          // temporary session ID (before identify)
  identity: {
    public:  Record<string, unknown>;  // visible to other players
    private: Record<string, unknown>;  // server-side only
  };
  send(msg: unknown): void;
  reject(reason: string): void;        // disconnect before entering a room
  save(): Promise<void>;               // persist identity to D1 or DO storage
}
```

#### Defining the identity schema

`defineIdentity()` accepts either **plain type strings** (simple) or **Zod schemas** (recommended). Both approaches are supported — Zod is optional but strongly encouraged when using D1, as it produces more precise SQL constraints and full TypeScript inference.

**Plain strings (simple, no Zod dependency):**

```ts
.defineIdentity({
  public:  { name: "string", avatar: "string", level: "number" },
  private: { chips: "number", email: "string", stats: "json" }
})
```

**Zod schemas (recommended):**

```ts
import { z } from "zod";

.defineIdentity({
  public: z.object({
    name:   z.string(),
    avatar: z.string().url(),
    level:  z.number().int().min(1),
  }),
  private: z.object({
    role:   z.enum(["player", "vip", "mod"]).default("player"),
    chips:  z.number().int().min(0).default(100),
    email:  z.string().email(),
    bio:    z.string().max(500).optional(),
    stats:  z.object({
      wins:   z.number().int().default(0),
      losses: z.number().int().default(0),
    }),
  })
})
```

Using Zod provides three additional benefits over plain strings:

- **Runtime validation** — if `player.identify()` receives data that doesn't match the schema, the framework rejects the player automatically before they enter any room.
- **TypeScript inference** — `player.identity.private.chips` is typed as `number`, not `unknown`. No manual casting needed anywhere in the `GameRoom`.
- **Precise SQL constraints** — Zod modifiers map directly to SQL column definitions, producing richer and safer D1 schemas (see the Zod → SQL mapping table in the Persistence section).

#### Using identity inside a room

Identity is injected in `onConnect` after the developer validates their own auth token:

```ts
const engine = createEngine()
  .register("poker", PokerRoom)
  .withDatabase(env.DB)
  .defineIdentity({
    public: z.object({
      name:   z.string(),
      avatar: z.string().url(),
      level:  z.number().int().min(1),
    }),
    private: z.object({
      chips: z.number().int().min(0).default(100),
      email: z.string().email(),
      stats: z.object({ wins: z.number().int().default(0), losses: z.number().int().default(0) }),
    })
  })
  .onConnect(async (player, req) => {
    const token = new URL(req.url).searchParams.get("token");
    if (!token) return player.reject("unauthorized");

    const user = await myDB.getUserByToken(token);
    if (!user) return player.reject("invalid token");

    // framework validates against the Zod schema automatically
    // if validation fails, player is rejected before entering any room
    player.identify({
      public:  { name: user.username, avatar: user.avatarUrl, level: user.level },
      private: { chips: user.chips, email: user.email, stats: user.stats }
    });
  });
```

Inside a room, `player.identity.public` and `player.identity.private` are fully accessible, mutable, and typed. Call `player.save()` to persist changes:

```ts
export class PokerRoom extends GameRoom<PokerState> {

  onJoin(player: Player) {
    if (player.identity.private.chips < this.state.blinds)
      return player.reject("not enough chips");
  }

  actions = {
    raise: (player: Player, payload: { amount: number }) => {
      if (player.identity.private.chips < payload.amount) return;
      player.identity.private.chips -= payload.amount;
      player.save(); // persists to D1 or DO storage depending on config
    },
  };

  onLeave(player: Player) {
    // optionally sync back to your own external API
    await fetch("https://my-api.com/stats", {
      method: "POST",
      body: JSON.stringify({
        userId: player.identity.private.email,
        stats:  player.identity.private.stats,
      })
    });
  }

  lobbyData() {
    return {
      players: [...this.players.values()].map(p => ({
        name:   p.identity.public.name,
        avatar: p.identity.public.avatar,
      })),
      maxPlayers: this.maxPlayers,
    };
  }
}
```

### 4. Binary Message Protocol

Every WebSocket message is an `ArrayBuffer` with a fixed header and a CRC-8 integrity byte at the end:

```
Byte 0:     Message type  (uint8)
Byte 1:     Flags         (uint8)  — reserved, e.g. compression hint
Byte 2-3:   Payload size  (uint16, big-endian)
Byte 4+:    Payload       (JSON-encoded UTF-8 or raw binary)
Byte N:     CRC-8         (uint8)  — covers all previous bytes
```

Total overhead: **5 bytes per message** (4 header + 1 CRC). The CRC-8 is calculated over all bytes except itself and verified before any message reaches a handler — malformed or corrupted messages are silently discarded by the framework.

```ts
// CRC-8 (Dallas/Maxim polynomial 0x07)
function crc8(data: Uint8Array): number {
  let crc = 0x00;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? (crc << 1) ^ 0x07 : crc << 1;
      crc &= 0xFF;
    }
  }
  return crc;
}
```

#### Reserved byte ranges

The message type byte is divided into ranges to prevent collisions between framework and developer types:

```
0x01 – 0x0F   State & lobby        (framework, reserved)
0x10 – 0x1F   Actions & input      (framework, reserved)
0x20 – 0x2F   Social               (framework, reserved)
0x30 – 0x3F   Game lifecycle       (framework, reserved)
0x40 – 0x4F   Room administration  (framework, reserved)
0x50 – 0xFF   Developer-defined    (176 types available)
```

#### Framework game events

Each `GameEvent` value has a default handler built into the framework. Developers can override any of them inside their `GameRoom`. The full `GameEvent` enum with all values and byte assignments is defined in the **Enums** section.

#### Developer-defined game events

For game-specific messages, developers define their own constants in the `0x50–0xFF` range and handle them via the `messages` map. Unlike `actions`, these **bypass the framework pipeline entirely** — no automatic state broadcast, no validation — giving maximum efficiency for high-frequency or custom data.

```ts
const MyGameEvent = {
  SPELL_CAST:   0x50,
  ITEM_USE:     0x51,
} as const;

export class MyGame extends GameRoom<State> {
  actions = {
    move: (player, payload) => { /* goes through framework pipeline */ },
  };

  messages = {
    [MyGameEvent.SPELL_CAST]: (player: Player, buffer: ArrayBuffer) => {
      // raw buffer — developer handles everything manually
      const view = new DataView(buffer);
      const spellId = view.getUint8(0);
      const targetId = view.getUint16(1);
    },
  };
}
```

---

## Enums

Edgplay uses enums throughout to eliminate magic strings and provide full type safety and autocomplete. There are five enums, each with a distinct responsibility.

### GameEvent

The binary protocol layer — the byte that travels inside every WebSocket frame. Exists on both server and client. Represents what is happening at the network level.

```ts
export enum GameEvent {
  // State & lobby (0x01–0x0F)
  STATE_FULL:       0x01,
  STATE_PATCH:      0x02,
  PLAYER_JOIN:      0x03,
  PLAYER_LEAVE:     0x04,
  ROOM_ERROR:       0x05,
  LOBBY_LIST:       0x06,
  LOBBY_PATCH:      0x07,

  // Actions & input (0x10–0x1F)
  ACTION:           0x10,
  INPUT:            0x11,
  PING:             0x12,
  PONG:             0x13,

  // Social (0x20–0x2F)
  CHAT:             0x20,
  CHAT_PRIVATE:     0x21,
  EMOTE:            0x22,

  // Game lifecycle (0x30–0x3F)
  PLAYER_READY:     0x30,
  PLAYER_UNREADY:   0x31,
  COUNTDOWN:        0x32,
  GAME_START:       0x33,
  GAME_OVER:        0x34,

  // Room administration (0x40–0x4F)
  KICK:             0x40,
  HOST_TRANSFER:    0x41,

  // Developer-defined: 0x50–0xFF (176 values available)
}
```

### RoomEvent

The client SDK layer — events the developer listens to with `room.on()`. Exists only in the client. The SDK translates incoming `GameEvent` frames into `RoomEvent` emissions.

```ts
export enum RoomEvent {
  // State
  STATE_CHANGE     = "stateChange",
  STATE_PATCH      = "statePatch",

  // Players
  PLAYER_JOIN      = "playerJoin",
  PLAYER_LEAVE     = "playerLeave",

  // Game lifecycle
  COUNTDOWN        = "countdown",
  GAME_START       = "gameStart",
  GAME_OVER        = "gameOver",

  // Social
  CHAT             = "chat",
  EMOTE            = "emote",

  // Connection
  RECONNECTING     = "reconnecting",
  RECONNECTED      = "reconnected",
  RECONNECT_FAILED = "reconnectFailed",
  DISCONNECTED     = "disconnected",
}
```

### LobbyEvent

Client SDK events for the lobby connection, listened to with `lobby.on()`.

```ts
export enum LobbyEvent {
  ROOM_LIST    = "roomList",    // initial full snapshot
  ROOM_ADDED   = "roomAdded",   // a new room appeared
  ROOM_UPDATED = "roomUpdated", // a room's lobbyData changed
  ROOM_REMOVED = "roomRemoved", // a room was closed or delisted
}
```

### DisconnectReason

Why a player's connection ended. Arrives as the argument to `RoomEvent.DISCONNECTED`.

```ts
export enum DisconnectReason {
  LEFT         = "left",
  TIMEOUT      = "timeout",
  LOST         = "lost",
  KICKED       = "kicked",
  ROOM_CLOSED  = "room_closed",
  SERVER_ERROR = "server_error",
  UNAUTHORIZED = "unauthorized",
  RATE_LIMITED = "rate_limited",
}
```

### RateLimitViolation

What the framework does when a rate limit is exceeded.

```ts
export enum RateLimitViolation {
  DROP = "drop",  // silently discard the message, keep player connected
  WARN = "warn",  // send ROOM_ERROR to the client, keep player connected
  KICK = "kick",  // disconnect with DisconnectReason.RATE_LIMITED
}
```

### GameEvent vs RoomEvent

These are two distinct layers that serve different purposes:

| | `GameEvent` | `RoomEvent` |
|---|---|---|
| Layer | Network (binary protocol) | Application (client SDK) |
| Where | Server + client | Client only |
| Represents | What travels in the WebSocket frame | What the developer listens to |
| Used in | `messages`, `allowedMessages()`, rate limit config | `room.on()` |

The SDK acts as the translator between the two. Some `GameEvent` values never produce a `RoomEvent` because they are handled internally:

```
GameEvent.PING  →  SDK responds with PONG automatically — no RoomEvent emitted
GameEvent.PONG  →  SDK resets the timeout timer — no RoomEvent emitted
```

Some `RoomEvent` values have no corresponding `GameEvent` because they are generated by the SDK itself:

```
RoomEvent.RECONNECTING    →  SDK detects connection loss locally
RoomEvent.RECONNECTED     →  SDK successfully re-establishes the connection
RoomEvent.RECONNECT_FAILED →  SDK exhausts all reconnect attempts
```

---

## Client SDK

The client package (`edgplay/client`) is a **standalone, UI-framework-agnostic** library. It has no opinion on React, Vue, Svelte, or any other frontend framework — it only manages the WebSocket connection and exposes events. The developer decides how to use the data in their UI.

It works in any JavaScript environment:

```html
<!-- Vanilla JS via CDN — zero configuration -->
<script type="module">
  import { createClient, RoomEvent } from "https://esm.sh/edgplay/client";

  const client = createClient("https://my-worker.dev");
  const room = await client.game("chess").join("sala-123");
  room.on(RoomEvent.STATE_CHANGE, (state) => renderBoard(state.board));
</script>
```

```ts
// React — same API, developer wires it to state themselves
import { createClient } from "edgplay/client";

const client = createClient("https://my-worker.dev");

function ChessGame() {
  const [state, setState] = useState(null);

  useEffect(() => {
    client.game("chess").join("sala-123").then((room) => {
      room.on(RoomEvent.STATE_CHANGE, setState);
    });
  }, []);
}
```

### Room client

```ts
import { createClient, RoomEvent, LobbyEvent, DisconnectReason } from "edgplay/client";

const client = createClient("https://my-worker.dev");

// Join a room — fluent API
const room = await client
  .game("chess")
  .join("sala-123", { playerName: "Vicente" });

// State events
room.on(RoomEvent.STATE_CHANGE, (state) => renderBoard(state.board));
room.on(RoomEvent.STATE_PATCH,  (patch) => applyPatch(patch));

// Player events
room.on(RoomEvent.PLAYER_JOIN,  (player) => console.log(player.id, "joined"));
room.on(RoomEvent.PLAYER_LEAVE, (player) => console.log(player.id, "left"));

// Game lifecycle events
room.on(RoomEvent.COUNTDOWN,    (seconds) => showCountdown(seconds));
room.on(RoomEvent.GAME_START,   () => startGame());
room.on(RoomEvent.GAME_OVER,    (result) => showResult(result));

// Social events
room.on(RoomEvent.CHAT,         (msg) => appendChat(msg));
room.on(RoomEvent.EMOTE,        (emote) => playEmote(emote));

// Connection events
room.on(RoomEvent.RECONNECTING,     () => showReconnectSpinner());
room.on(RoomEvent.RECONNECTED,      () => hideSpinner());
room.on(RoomEvent.RECONNECT_FAILED, () => showRejoinButton());
room.on(RoomEvent.DISCONNECTED, (reason: DisconnectReason) => {
  if (reason === DisconnectReason.RATE_LIMITED) showMessage("Too many messages.");
});

// Send a game action
room.send("move", { from: "e2", to: "e4" });

// Send a ready signal
room.ready();

// Disconnect
room.leave();
```

### Lobby client

```ts
// Subscribe to a live lobby for a game type
const lobby = await client.game("poker").lobby();

// Receive the initial room list + real-time incremental updates
lobby.on(LobbyEvent.ROOM_LIST,    (rooms) => renderRoomList(rooms));
lobby.on(LobbyEvent.ROOM_ADDED,   (room)  => addRoomToList(room));
lobby.on(LobbyEvent.ROOM_UPDATED, (room)  => updateRoomInList(room));
lobby.on(LobbyEvent.ROOM_REMOVED, (id)    => removeRoomFromList(id));

// Optional: filter rooms client-side
lobby.filter({ status: "waiting" });

// Automatic matchmaking — finds the best available room via canJoin()
const room = await client.game("poker").joinOrCreate({ blinds: 50 });

// Or join a specific room by ID
const room = await client.game("poker").joinById("sala-42");

// Unsubscribe from lobby updates
lobby.leave();
```

---

## Lobby & Room Discovery

One of the key differentiators of this framework is that **the developer controls how rooms are discovered and listed** — the framework never makes those decisions unilaterally.

### Developer-facing API (server-side)

The developer overrides three methods on `GameRoom` to define all lobby behavior:

```ts
export class PokerRoom extends GameRoom<PokerState> {

  // What data this room exposes to the lobby — completely custom
  lobbyData(): Record<string, unknown> {
    return {
      players:     this.players.size,
      maxPlayers:  this.maxPlayers,
      blinds:      this.state.blinds,
      status:      this.state.status,
      hasPassword: !!this.password,
    };
  }

  // Whether this room appears in the lobby at all
  isListed(): boolean {
    return this.state.status === "waiting" && !this.password;
  }

  // Whether a specific player is allowed to join
  canJoin(player: Player, options: unknown): boolean {
    return this.players.size < this.maxPlayers
        && this.state.status === "waiting";
  }
}
```

The framework calls these methods automatically at the right moments:
- `lobbyData()` and `isListed()` are called whenever the room state changes, and the result is pushed to the `LobbyDO`.
- `canJoin()` is called before admitting any player, both on direct joins and on `joinOrCreate`.

### Infrastructure (handled by the framework)

The lobby system uses a **hybrid architecture** combining two Cloudflare services:

```
[GameRoom DO]  ──notifies on change──▶  [LobbyDO "lobby:poker"]
                                              │
                              ┌───────────────┴───────────────┐
                              │                               │
                    WebSocket broadcast              writes snapshot
                    to subscribed clients          to KV every N seconds
                              │                               │
                    [Client receives               [Client on first load
                     real-time update]              reads from KV — fast]
```

- **LobbyDO** — one DO instance per game type (e.g. `lobby:chess`, `lobby:poker`). Holds the authoritative room list in memory, broadcasts incremental updates to subscribed clients via WebSocket, and periodically writes a full snapshot to KV.
- **Cloudflare KV** — used exclusively as a read cache for the initial lobby load. Fast global reads, populated by the LobbyDO. Not used as source of truth (KV's eventual consistency of up to 60s makes it unsuitable for real-time updates).

### Why not other Cloudflare services?

| Service | Considered for | Verdict |
|---|---|---|
| Cloudflare KV | Real-time updates | ❌ Up to 60s propagation delay — too slow |
| Cloudflare Pub/Sub (MQTT) | Real-time push | ❌ Private beta + adds an extra protocol |
| Durable Objects | Coordination + real-time | ✅ Consistent, WebSocket-native, one per game type |
| KV | Initial load cache | ✅ Fast global reads, written by LobbyDO |

---

## The Four Example Games

### Chess
- 2 players max
- Full state visible to both
- Actions: `move`
- Win condition handled server-side (checkmate detection optional for PoC)
- Lobby: only listed while `status === "waiting"`

### UNO
- 2–8 players
- **Partial state**: each player only receives their own hand
- `stateFor(player)` returns `{ ...globalState, hand: hands[player.id] }`
- Actions: `playCard`, `drawCard`, `callUno`
- Lobby: exposes player count and whether the game has started

### Poker (Texas Hold'em)
- 2–9 players
- **Partial state**: hole cards are private; community cards are public
- Player roles: dealer, small blind, big blind rotate each round
- Actions: `fold`, `check`, `call`, `raise`
- Multiple betting rounds managed as a state machine inside the room
- Lobby: exposes blind sizes, player count, password-protected flag

### 3D Multiplayer
- N players (configurable)
- High-frequency state: player positions, rotations, animations
- Uses **DO Alarms** as a simulation tick (~20 ticks/sec = 50ms interval)
- Client-side prediction + server reconciliation (basic implementation)
- Actions: `inputState` — client sends its input each frame, server applies it

```ts
// DO Alarm used as game loop tick
async alarm() {
  this.update(Date.now() - this.lastTick);
  this.lastTick = Date.now();
  this.broadcastState();
  await this.ctx.storage.setAlarm(Date.now() + 50); // 20 ticks/sec
}
```

---

## State Synchronization Strategy

| Game | Sync method | Frequency |
|---|---|---|
| Chess | Full state on each action | On action |
| UNO | Full state (filtered per player) on each action | On action |
| Poker | Full state (filtered per player) on each action | On action |
| 3D | Delta patch broadcast | Every alarm tick (~50ms) |

Delta patches for 3D follow a simple format:

```ts
// Only changed fields are sent
{ "players": { "player-42": { "x": 12.3, "y": 0, "z": -5.1 } } }
```

---

## Persistence

### Two-tier storage model

Edgplay supports two persistence backends depending on whether the developer provides a D1 binding. The developer's code is identical in both cases — only the behavior changes.

| | Without D1 | With D1 |
|---|---|---|
| `player.save()` | Writes to DO storage with TTL (default 30 days) | Writes to D1, permanent |
| Player reconnects | Data recovered if DO is still alive | Always recovered from D1 |
| DO expires | Identity data lost | Identity data intact |
| Room state | Saved to DO storage on `onDispose` | Saved to DO storage on `onDispose` |
| Setup required | None | `withDatabase(env.DB)` + `defineIdentity()` |

### Room state persistence

Regardless of D1, the framework automatically saves and restores room state via DO storage:

- Saves full room state on game end (`onDispose`)
- Restores state on DO restart — allows resuming interrupted games
- For 3D rooms: only persists scores and metadata, not positions

### D1 database schema

When `withDatabase()` is provided, the framework manages its own tables prefixed with `edgplay_` to avoid collisions with the developer's own tables.

```sql
-- Tracks applied migrations — never modified manually
CREATE TABLE edgplay_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,    -- e.g. "0001_initial", "0002_add_level"
  applied_at  INTEGER NOT NULL     -- unix timestamp
);

-- One row per player — columns generated from defineIdentity()
CREATE TABLE edgplay_players (
  id          TEXT    PRIMARY KEY, -- the ID set in player.identify()
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
  -- public_* and private_* columns added automatically via migrations
);

-- One row per WebSocket session
CREATE TABLE edgplay_sessions (
  session_id   TEXT PRIMARY KEY,
  player_id    TEXT    NOT NULL REFERENCES edgplay_players(id),
  room_id      TEXT,
  connected_at INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);
```

Fields declared in `defineIdentity()` become real columns on `edgplay_players`. When using Zod, the framework maps Zod types to precise SQL column definitions:

| Zod type | SQL column type |
|---|---|
| `z.string()` | `TEXT` |
| `z.string().max(255)` | `TEXT CHECK(length(col) <= 255)` |
| `z.string().email()` | `TEXT` (validated at runtime by Zod) |
| `z.number().int()` | `INTEGER` |
| `z.number()` | `REAL` |
| `z.boolean()` | `INTEGER` (0/1, SQLite standard) |
| `z.object({})` / `z.array()` | `TEXT` (JSON serialized) |
| `z.string().optional()` | `TEXT` (nullable column) |
| `z.number().int().default(0)` | `INTEGER DEFAULT 0` |
| `z.enum(["a","b"])` | `TEXT CHECK(col IN ('a','b'))` |

The last three are particularly valuable — `optional()`, `default()`, and `enum()` translate directly to SQL constraints, something impossible to express with plain type strings.

For example, this `defineIdentity()`:

```ts
private: z.object({
  role:   z.enum(["player", "vip", "mod"]).default("player"),
  chips:  z.number().int().min(0).default(100),
  bio:    z.string().max(500).optional(),
})
```

Generates:

```sql
ADD COLUMN private_role   TEXT    NOT NULL DEFAULT 'player' CHECK(private_role IN ('player','vip','mod'));
ADD COLUMN private_chips  INTEGER NOT NULL DEFAULT 100      CHECK(private_chips >= 0);
ADD COLUMN private_bio    TEXT;
```

Each field is a real column — not a JSON blob — enabling efficient queries if the developer needs to filter or sort players by level, chips, role, etc.

### Migration system

Edgplay ships a CLI that detects schema drift between `defineIdentity()` and the actual D1 database, and generates migration files automatically — similar to Django's `makemigrations`.

```bash
# Detect changes and generate a migration file
npx edgplay migrate:generate

# Apply all pending migrations to D1
npx edgplay migrate:apply

# Show which migrations are applied and which are pending
npx edgplay migrate:status

# Revert the last applied migration
npx edgplay migrate:rollback
```

Each migration is a versioned TypeScript file with `up` and `down` SQL:

```ts
// migrations/0002_add_level.ts — auto-generated, developer can review before applying
export const migration = {
  name: "0002_add_level",
  up:   `ALTER TABLE edgplay_players ADD COLUMN public_level INTEGER DEFAULT 1;`,
  down: `ALTER TABLE edgplay_players DROP COLUMN public_level;`
};
```

#### Rename detection

When `migrate:generate` detects a removed field and a new field of the same type, it asks the developer whether it was a rename:

```
Detected changes:
  - Removed: private_chips (integer)
  - Added:   private_balance (integer)

Did you rename 'private_chips' to 'private_balance'? (y/N)
```

- **Yes** → generates `ALTER TABLE edgplay_players RENAME COLUMN private_chips TO private_balance` — data is preserved.
- **No** → generates `DROP COLUMN` + `ADD COLUMN` — old data is lost for that field.

This prevents the most dangerous class of silent data corruption: renaming a field without a migration would leave all existing rows with the old column untouched while new rows use the new column name.

---

## Player Profiles

Edgplay exposes an automatic HTTP endpoint for public player profiles, allowing developers to build stat pages, leaderboards, and user pages without writing any routing code.

### The three identity scopes

`defineIdentity()` now supports a third scope — `profile` — alongside `public` and `private`. It is a function that receives the full identity and returns only what the developer wants to expose publicly via the HTTP endpoint:

```ts
import { z } from "zod";

.defineIdentity({
  public: z.object({
    name:   z.string(),
    avatar: z.string().url(),
    level:  z.number().int(),
  }),
  private: z.object({
    email:  z.string().email(),       // never exposed
    chips:  z.number().int().min(0),  // never exposed
    stats: z.object({
      wins:   z.number().int().default(0),
      losses: z.number().int().default(0),
      elo:    z.number().int().default(1000),
    }),
  }),

  // What is visible on the public profile endpoint — developer decides
  profile: (identity) => ({
    name:   identity.public.name,
    avatar: identity.public.avatar,
    level:  identity.public.level,
    wins:   identity.private.stats.wins,
    losses: identity.private.stats.losses,
    elo:    identity.private.stats.elo,
    // email and chips are never included
  })
})
```

| Scope | Visible to other players in-game | Visible on profile endpoint | Visible server-side |
|---|---|---|---|
| `public` | ✅ | ✅ (always) | ✅ |
| `private` | ❌ | ❌ | ✅ |
| `profile` | ❌ | ✅ (developer-defined) | ✅ |

If `profile` is not defined, the endpoint returns only `public` fields — private data is never accidentally exposed.

### Auto-generated endpoints

`createEngine` adds two HTTP endpoints to the Worker automatically — no routing code required:

```
GET /profile/:playerId         → full profile (public + profile fields)
GET /profile/:playerId/stats   → only the profile fields
```

Example response for `GET /profile/player-123`:

```json
{
  "id":     "player-123",
  "name":   "Vicente",
  "avatar": "https://cdn.example.com/avatar.png",
  "level":  42,
  "wins":   150,
  "losses": 30,
  "elo":    1840
}
```

These endpoints read from **D1** and work even when the player is not connected to any room. If D1 is not configured, both endpoints return `404` with a clear message — profile persistence requires D1.

### Client SDK

```ts
// Fetch a player profile from the client
const profile = await client.getProfile("player-123");
console.log(profile.name, profile.elo);

// Fetch only stats
const stats = await client.getStats("player-123");
console.log(stats.wins, stats.losses);
```

### Leaderboard pattern

The profile endpoint is intentionally minimal — it serves one player at a time. For leaderboards the developer queries D1 directly in their own Worker code, using the `private_*` columns that Edgplay created:

```ts
// Developer's own Worker route — not part of Edgplay
app.get("/leaderboard", async (c) => {
  const rows = await c.env.DB
    .prepare(`
      SELECT id, public_name, public_avatar, private_stats_elo
      FROM edgplay_players
      ORDER BY private_stats_elo DESC
      LIMIT 100
    `)
    .all();
  return c.json(rows.results);
});
```

Because identity fields are real D1 columns (not JSON blobs), sorting and filtering by `elo`, `wins`, or any other stat is a native SQL operation.

---

## Disconnect Handling

Players can disconnect for many reasons — voluntary exit, network loss, timeout, or server-side kick. Edgplay exposes a typed `DisconnectReason` enum so the developer can react to each case precisely inside `onLeave`.

### Disconnect reasons

```ts
export enum DisconnectReason {
  // Voluntary
  LEFT         = "left",          // player called room.leave()

  // Network
  TIMEOUT      = "timeout",       // no PING response in N seconds (definitive)
  LOST         = "lost",          // connection dropped abruptly (WS code 1006)

  // Server-side
  KICKED       = "kicked",        // removed by host or server logic
  ROOM_CLOSED  = "room_closed",   // room was closed by the server
  SERVER_ERROR = "server_error",  // internal error

  // Auth
  UNAUTHORIZED = "unauthorized",  // token expired mid-session

  // Rate limiting
  RATE_LIMITED = "rate_limited",  // kicked due to rate limit violation
}
```

The framework detects `LOST` and `TIMEOUT` via the PING/PONG system built into the protocol. If a client does not respond to a PING within the configured threshold, the framework calls `onLeave` with `DisconnectReason.LOST` and opens a reconnect window. If the player does not reconnect within that window, `onLeave` is called again with `DisconnectReason.TIMEOUT` — this is the definitive disconnect.

Default timeouts (configurable via `withTimeouts()`):

```ts
const engine = createEngine()
  .register("chess", ChessRoom)
  .withTimeouts({
    pingInterval:    15_000,  // how often the client sends PING (ms)
    pongTimeout:      5_000,  // how long the server waits for PONG
    reconnectWindow: 30_000,  // how long the player slot is held open
  });
```

### Chess — turn-based, no active timer

In Chess the game state does not change while a player is disconnected, so the framework can simply pause the game and hold the slot open. The other player waits.

```ts
export class ChessRoom extends GameRoom<ChessState> {

  onLeave(player: Player, reason: DisconnectReason) {
    if (reason === DisconnectReason.LOST || reason === DisconnectReason.TIMEOUT) {
      // involuntary disconnect — pause and wait for reconnect
      this.state.status = "paused";
      this.state.disconnected = player.id;
      this.broadcastState();
      // framework holds the slot open for the reconnect window
      // if it expires, onLeave fires again with TIMEOUT (definitive)

    } else if (reason === DisconnectReason.LEFT) {
      // voluntary exit — the other player wins
      this.state.status = "finished";
      this.state.winner = [...this.players.values()]
        .find(p => p.id !== player.id)?.id ?? null;
      this.broadcastState();
    }
  }

  onRejoin(player: Player) {
    // player reconnected within the window
    this.state.status = "playing";
    this.state.disconnected = null;
    // framework automatically sends STATE_FULL to the rejoining player
    this.broadcastState();
  }
}
```

### Poker — active turn timer, other players are waiting

Poker cannot simply pause. If it is the disconnected player's turn, the other players cannot wait 30 seconds — the server must act on their behalf immediately. If it is not their turn, the full reconnect window can be granted.

```ts
export class PokerRoom extends GameRoom<PokerState> {

  onLeave(player: Player, reason: DisconnectReason) {
    if (reason === DisconnectReason.LOST || reason === DisconnectReason.TIMEOUT) {

      if (this.state.currentTurn === player.id) {
        // it is this player's turn — cannot block others
        // auto-fold immediately and advance the turn
        this._applyFold(player);
        this.broadcastState();
      } else {
        // not their turn — hold the slot, other players can keep going
        this.state.players[player.id].status = "reconnecting";
        this.broadcastState();
      }

    } else if (reason === DisconnectReason.LEFT) {
      // voluntary exit during an active hand → immediate fold
      if (this.state.phase === "betting") {
        this._applyFold(player);
      }
      this.state.players[player.id].status = "left";
      this.broadcastState();
    }
  }

  onRejoin(player: Player) {
    this.state.players[player.id].status = "active";
    // player receives STATE_FULL and sees the current hand
    // if it is their turn, the turn timer resets
    this.broadcastState();
  }

  private _applyFold(player: Player) {
    this.state.players[player.id].folded = true;
    this.state.players[player.id].status = "folded";
    this._advanceTurn();
  }
}
```

### Key distinction

| | Chess | Poker |
|---|---|---|
| Game pauses on disconnect | ✅ Safe — state doesn't change | ❌ Other players are blocked |
| Auto-action on disconnect | Not needed | Immediate fold if it's their turn |
| Reconnect window | Full 30s always | Full 30s only if not their turn |
| `onRejoin` restores state | Resume from exact position | Rejoin mid-hand if still in progress |

### Client-side reconnect events

The client SDK handles reconnection automatically and exposes lifecycle events:

```ts
room.on(RoomEvent.RECONNECTING,     () => showReconnectSpinner());
room.on(RoomEvent.RECONNECTED,      () => hideSpinner());
room.on(RoomEvent.RECONNECT_FAILED, () => showRejoinButton());
```

---

## Communication Control

Edgplay provides two complementary layers of rate limiting — one at the Worker level using Cloudflare's native binding, and one inside the DO for fine-grained per-message control. Both are optional and can be used together.

### Enums

```ts
export enum RateLimitViolation {
  DROP = "drop",  // silently discard the message, keep player connected
  WARN = "warn",  // send ROOM_ERROR to the client, keep player connected
  KICK = "kick",  // disconnect with DisconnectReason.RATE_LIMITED
}
```

On the client side, a `KICK` violation arrives as a typed disconnect reason:

```ts
room.on(RoomEvent.DISCONNECTED, (reason: DisconnectReason) => {
  if (reason === DisconnectReason.RATE_LIMITED) {
    showMessage("Too many messages sent.");
  }
});
```

### Layer 1 — Cloudflare Rate Limit binding (optional)

Cloudflare provides a native `ratelimit` binding for Workers. It runs **before the message reaches the DO**, blocking abusive connections at the edge with near-zero latency overhead (counters are cached locally per Cloudflare location). This is ideal for blocking connection-level abuse — repeated reconnects, connection floods, HTTP spam.

To enable it, the developer uncomments the binding in `wrangler.jsonc` (provided as a comment in the template):

```jsonc
{
  "name": "my-game",
  "main": "src/index.ts",
  "durable_objects": { ... },

  // Optional: uncomment to enable Cloudflare native rate limiting
  // "unsafe": {
  //   "bindings": [{
  //     "name": "RATE_LIMITER",
  //     "type": "ratelimit",
  //     "namespace_id": "1",
  //     "simple": { "limit": 100, "period": 60 }
  //   }]
  // }
}
```

And passes the binding to `createEngine`:

```ts
const engine = createEngine()
  .register("poker", PokerRoom)
  .withCloudflareRateLimit(env.RATE_LIMITER, {
    key: (player) => player.id,           // limit per player ID
    onViolation: RateLimitViolation.KICK,
  });
```

> **Note:** Cloudflare's rate limit counters are per Cloudflare location, not global. A player connecting from Santiago and one from São Paulo have separate counters. This makes it best suited for connection-level protection rather than game-level precision.

### Layer 2 — Edgplay native rate limits (optional)

The native system runs **inside the DO**, giving precise per-player, per-message-type control. Because it lives inside the DO, counters are global for that room instance — no location split.

Configured globally in `createEngine` and optionally overridden per room:

```ts
const engine = createEngine()
  .register("poker", PokerRoom)
  .withRateLimits({
    global: {
      messagesPerSecond: 20,              // max 20 messages/sec per player
      maxPayloadBytes:   4096,            // max payload size 4KB — checked before deserializing
      onViolation: RateLimitViolation.DROP,
    },
    perType: {
      [GameEvent.CHAT]:   { messagesPerSecond: 1, cooldownMs: 1000, onViolation: RateLimitViolation.WARN },
      [GameEvent.INPUT]:  { messagesPerSecond: 60 },   // 60fps allowed
      [GameEvent.ACTION]: { cooldownMs: 500, onViolation: RateLimitViolation.DROP },
    }
  });
```

The `maxPayloadBytes` limit is enforced at the protocol level before the payload is deserialized — the framework reads the `Payload size` field from the binary header and rejects the message immediately if it exceeds the limit, saving CPU.

#### Per-room overrides

The developer can override or extend the global limits inside any `GameRoom`:

```ts
export class PokerRoom extends GameRoom<PokerState> {

  // Tighten ACTION cooldown for this room specifically
  rateLimits = {
    perType: {
      [GameEvent.ACTION]: { cooldownMs: 500, onViolation: RateLimitViolation.DROP },
    }
  };
}
```

#### Dynamic mute and blacklist

The developer can mute a specific player for a specific message type at runtime — useful for chat moderation or anti-abuse without kicking the player:

```ts
export class PokerRoom extends GameRoom<PokerState> {

  actions = {
    reportPlayer: (player: Player, payload: { targetId: string }) => {
      // mute chat for 60 seconds
      this.mute(payload.targetId, GameEvent.CHAT, { durationMs: 60_000 });
    },
  };
}
```

#### Message whitelist by game state

The developer can declare which message types are valid per game state. Any message not in the whitelist is dropped silently — no handler is called:

```ts
export class PokerRoom extends GameRoom<PokerState> {

  allowedMessages(): number[] {
    switch (this.state.status) {
      case "waiting":  return [GameEvent.PLAYER_READY, GameEvent.CHAT, GameEvent.EMOTE, GameEvent.PING];
      case "playing":  return [GameEvent.ACTION, GameEvent.CHAT, GameEvent.EMOTE, GameEvent.PING];
      case "finished": return [GameEvent.PING];
      default:         return [GameEvent.PING];
    }
  }
}
```

### Both layers together

The two layers are complementary and can be used simultaneously:

```
[Client]
   │
   ▼
[Worker] ── Cloudflare Rate Limit binding (connection-level, per CF location)
   │
   ▼
[GameRoom DO] ── Edgplay native rate limits (message-level, global per room)
```

| | Cloudflare binding | Edgplay native |
|---|---|---|
| Runs at | Worker (before DO) | Inside the DO |
| Counters | Per Cloudflare location | Global for the room instance |
| Best for | Connection floods, reconnect abuse | Chat spam, action cooldowns, payload size |
| Requires | `wrangler.jsonc` binding | Nothing extra |
| `onViolation` | `RateLimitViolation` enum | `RateLimitViolation` enum |

---

## What This PoC Validates

- [ ] One Durable Object = one room, works correctly under WebSocket connections
- [ ] Binary protocol with CRC-8 correctly discards malformed messages
- [ ] `stateFor(player)` pattern correctly hides private state per player
- [ ] DO Alarms can serve as a reliable game loop tick for real-time games
- [ ] `createEngine()` fluent API generates all Worker routing with zero boilerplate
- [ ] `actions` vs `messages` distinction works correctly (pipeline vs bypass)
- [ ] The `GameRoom` abstraction is expressive enough for all 4 example games
- [ ] Client SDK works in vanilla JS, React, Vue, and Node.js without changes
- [ ] `lobbyData()` / `isListed()` / `canJoin()` give full control of room discovery
- [ ] LobbyDO correctly broadcasts incremental updates to subscribed clients
- [ ] KV cache delivers fast initial lobby loads without stale data issues
- [ ] `player.identify()` correctly splits public/private identity scopes
- [ ] `player.save()` writes to D1 when available, DO storage with TTL otherwise
- [ ] `migrate:generate` detects schema drift and generates correct migration files
- [ ] Rename detection correctly distinguishes rename from drop+add
- [ ] Migrations apply and rollback cleanly against a real D1 database
- [ ] Zod schemas in `defineIdentity()` produce correct SQL constraints (DEFAULT, CHECK, nullable)
- [ ] Runtime Zod validation in `player.identify()` rejects invalid identity data before room entry
- [ ] TypeScript types are correctly inferred from Zod schemas on `player.identity`
- [ ] Plain string schemas still work as a fallback when Zod is not used
- [ ] `profile` scope in `defineIdentity()` correctly limits what the HTTP endpoint exposes
- [ ] `GET /profile/:playerId` returns only public + profile fields, never private
- [ ] Profile endpoint returns `404` with a clear message when D1 is not configured
- [ ] `client.getProfile()` and `client.getStats()` correctly fetch from the endpoint
- [ ] `DisconnectReason` enum correctly identifies all disconnect causes
- [ ] Reconnect window holds the player slot open for the configured duration
- [ ] Chess correctly pauses the game on involuntary disconnect
- [ ] Poker correctly auto-folds when the disconnected player holds the active turn
- [ ] `onRejoin` restores player state and triggers `STATE_FULL` automatically
- [ ] `RateLimitViolation` enum enforced consistently across both rate limit layers
- [ ] `maxPayloadBytes` rejects oversized messages before deserialization
- [ ] Cloudflare Rate Limit binding correctly blocks at Worker level before reaching DO
- [ ] Native rate limits correctly apply per-player, per-message-type counters inside the DO
- [ ] `allowedMessages()` whitelist drops out-of-state messages silently
- [ ] `mute()` correctly suppresses a specific message type for a player for the given duration
- [ ] `DisconnectReason.RATE_LIMITED` arrives correctly on the client when `onViolation` is `KICK`

---

## Out of Scope

- Unity / Godot / Unreal SDKs
- Built-in authentication (OAuth, magic links, etc.) — developer brings their own
- Anti-cheat
- Voice/video
- Spectator mode
- Production-grade delta compression (e.g. MessagePack, FlatBuffers)

---

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers |
| Game rooms | Cloudflare Durable Objects |
| Lobby coordination | Cloudflare Durable Objects (one per game type) |
| Lobby read cache | Cloudflare KV |
| Player identity persistence | Cloudflare D1 (optional) / DO storage with TTL (default) |
| Transport | WebSocket (binary frames + CRC-8) |
| Language | TypeScript |
| Package manager | npm workspaces (monorepo) |
| Config | wrangler.jsonc |
| CLI | `npx edgplay migrate:*` |
| Rate limiting (connection-level) | Cloudflare Rate Limit binding (optional) |
| Rate limiting (message-level) | Edgplay native (built-in) |
| Schema validation | Zod (optional, recommended for D1) |
| Example frontends | Vanilla JS, React (framework-agnostic client) |
