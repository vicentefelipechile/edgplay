# AGENTS.md — Edgplay Maintenance Guide for AI Agents

This document is written for AI agents (Claude, Copilot, etc.) tasked with maintaining,
extending, or debugging Edgplay. It assumes you have read the source code and explains
the non-obvious decisions, invariants, and traps that are easy to break.

---

## Project Overview

Edgplay is a **serverless multiplayer game framework** built on Cloudflare Workers +
Durable Objects + WebSockets. It is a **proof-of-concept** focused on board/card games,
not real-time 3D. The primary design goal is: the developer writes game logic, Edgplay
handles everything else (routing, state sync, persistence, rate limiting, lobby).

### Monorepo structure

```
packages/server/   — the framework core (GameRoom, GameRoomDO, createEngine, protocol)
packages/client/   — the browser/Node client SDK (RoomConnection, LobbyConnection)
packages/cli/      — migration CLI (migrate:generate/apply/rollback/status)
examples/chess/    — smoke-test example, always kept working
```

The server package is the source of truth. The client and CLI depend on it conceptually
but are compiled independently. There are no circular dependencies.

---

## Before You Write Any Code

1. **Run the tests first.** There are 111+ tests across server and client. If they are
   not all passing before you start, you are building on broken ground.

   ```bash
   cd packages/server && npx vitest run
   cd packages/client && npx vitest run
   ```

2. **Type-check the chess example.** This catches type regressions that tests miss:

   ```bash
   cd examples/chess && npx tsc --noEmit
   ```

3. **Read the file you are about to change.** Use the view tool. The files are dense
   and many invariants are not obvious from the method signatures.

4. **Never use `str_replace` on a file you have not viewed since your last edit.**
   After any successful edit, the cached view in your context is stale.

---

## Architecture — Critical Invariants

### 1. GameRoomDO concurrency model

**This is the most dangerous area to touch.**

The Durable Object runs on a single thread but can be interrupted between `await` points.
Two `blockConcurrencyWhile` calls serialize critical sections:

- **Constructor**: `blockConcurrencyWhile(_restoreState)` — state is fully restored from
  DO storage before any `fetch` or `webSocketMessage` can run.
- **`_handleUpgrade`**: `blockConcurrencyWhile(_onOpen)` — a player is fully registered
  (in all three maps: `players`, `connected`, `wsByPlayer`) before any message from them
  or from other players is processed.

**If you add any `await` inside `_onOpen` without wrapping the whole thing in
`blockConcurrencyWhile`, you will introduce a race condition** where a message can arrive
for a player that is only half-registered.

### 2. The three player maps and their invariants

`GameRoomDO` maintains three maps that must always be in sync:

| Map | Key | Value | Purpose |
|-----|-----|-------|---------|
| `this.room.players` | playerId | `Player` | developer-visible, used in `onJoin`, `actions`, etc. |
| `this.connected` | playerId | `PlayerImpl` | framework-internal, full impl with `close()` etc. |
| `this.wsByPlayer` | `WebSocket` | playerId | O(1) reverse lookup from CF WS events |

**Rules:**
- A player is in all three maps or in none.
- `canJoin` is called **before** the player enters any map (it sees only confirmed players).
- `onJoin` is called **after** the player is in all maps.
- `_removePlayer` removes from all three maps atomically before calling `onLeave`.
- After hibernation, `_restoreState` rebuilds all three from `state.getWebSockets()`.
  A player whose WS is not in `getWebSockets()` is silently dropped (they disconnected
  while the DO was hibernated).

### 3. WS object identity after hibernation

Cloudflare may return **different `WebSocket` object references** from `getWebSockets()`
after a DO wakes from hibernation, compared to what was stored in `wsByPlayer`. This is
why `_playerForWs` has a fallback that reads `ws.deserializeAttachment()` — the
attachment survives hibernation when the object reference does not.

Do not remove this fallback. It is not dead code.

### 4. `canJoin` / `onJoin` contract

This is a documented invariant that examples depend on:
- `canJoin(player)`: `this.players` contains **only confirmed players** — the candidate
  is NOT yet in the map. Do not check `this.players.size + 1`.
- `onJoin(player)`: the player IS in `this.players`. `this.players.size` includes them.
- The framework calls `broadcastState()` automatically after `onJoin`. The developer
  must NOT call it manually inside `onJoin`.

### 5. `_removePlayer` side effects

`_removePlayer` does the following in order:
1. Removes player from all three maps
2. Calls `this.room.onLeave(player)`
3. Calls `this.room.broadcastState()` (updated state goes to remaining players)
4. Broadcasts `PLAYER_LEAVE` to remaining players
5. Calls `player.close(1000, reason)` on the server side (completes TCP FIN immediately)
6. If `players.size === 0`: calls `onDispose`, deletes DO storage, resets `initialized`
7. Otherwise: persists updated state to DO storage
8. Calls `_notifyLobby()`
9. Calls `_rateLimiter?.removePlayer(playerId)`

The order matters. Do not reorder steps 1-4 — `onLeave` modifies state that `broadcastState` then sends.

---

## Type System — What Not to Break

### Generic parameters on `GameRoom`

```ts
GameRoom<TState, TSchema, TData>
//        │       │         └── player.data type (per-session, not persisted)
//        │       └─────────── identity schema (Zod or plain, types player.identity)
//        └─────────────────── game state type
```

`GameRoomClass` in both `GameRoomDO.ts` and `createEngine.ts` is typed as
`new () => GameRoom<any, any, any>` — all three `any`. If you change this to be more
specific, TypeScript will reject subclasses with typed identities or data.

### `this["Player"]` pattern

The `Player` field declared on `GameRoom` with `declare`:

```ts
declare Player: Player<InferIdentity<TSchema>, TData>;
```

This is a **phantom field** — it has no runtime value, it only exists for TypeScript's
type lookup. The developer uses `this["Player"]` as a parameter type in actions and
lifecycle hooks. Do not remove it or make it a real field.

### `actions` index signature uses `any`

```ts
actions: Record<string, (player: any, payload: any) => void> = {};
```

This must stay `any`, not `Player<InferIdentity<TSchema>, TData>`. TypeScript's
contravariance rules prevent assigning `(player: SpecificType) => void` to
`(player: BaseType) => void`. The `any` here is intentional and safe — the framework
calls actions at runtime with the correct typed player.

### `InferIdentity<TSchema>` — how it works

```ts
type InferIdentity<TSchema> =
  TSchema extends { public: { _output: infer TPub }; private: { _output: infer TPriv } }
  ? { public: TPub & Record<string, unknown>; private: TPriv & Record<string, unknown> }
  : DefaultIdentity;
```

It reads `_output` from Zod's internal type — this is how `z.object({ name: z.string() })`
becomes `{ name: string }` without importing Zod's types. If Zod changes its internal
`_output` field name, this breaks. The `& Record<string, unknown>` intersection is needed
to satisfy index signature constraints in downstream code.

---

## Protocol — Binary Frame Format

```
Byte 0:    type     (uint8)  — GameEvent value
Byte 1:    flags    (uint8)  — reserved, currently always 0
Byte 2-3:  size     (uint16 big-endian) — payload byte length
Byte 4+:   payload  (JSON UTF-8)
Byte N:    CRC-8    (uint8)  — Dallas/Maxim 0x07, covers bytes 0 to N-1
```

**Rules:**
- Minimum valid frame: 5 bytes (4 header + 0 payload + 1 CRC).
- `decode()` returns `null` on any error (wrong size, bad CRC, invalid JSON). Callers
  silently discard null — never close the WS on a bad frame.
- `encode()` is called in the hot path — do not add allocations unnecessarily.
- The rate limiter peeks `byte[0]` (message type) **before** calling `decode()` to avoid
  spending CPU on oversized or malformed frames.
- Developer-defined message types live in the range `0x50–0xFF` (176 slots).

---

## Persistence — Two-Tier Model

### DO Storage (always active)

Room state is saved to DO storage after every mutation that matters:
- After `onJoin` (player joined, state may have changed)
- After each action handler
- After `onLeave` (if players remain)
- When the room empties: storage is **deleted** so the room resets cleanly

Key: `"_edgplay"`. Value: `{ gameState, gameName, roomId }`.

`initialized` flag: `false` until the room is first used. If `getWebSockets()` returns
no live connections on restore, and the room was previously initialized, the storage is
deleted and `initialized` is reset — prevents ghost state after all players disconnect
during hibernation.

### D1 (optional, activated by `withDatabase`)

D1 stores player identities permanently. The framework manages three tables:
- `edgplay_migrations` — tracks applied CLI migrations
- `edgplay_players` — one row per player, columns generated from `defineIdentity()`
- `edgplay_sessions` — one row per WebSocket session

Column naming convention: `public_*` and `private_*` prefixes matching identity scopes.
`D1Adapter._rowToIdentity()` reconstructs the nested `{ public, private }` object by
stripping these prefixes.

`ensureSchema()` is called lazily on first use — it creates the base tables if they do
not exist. It does NOT run migrations — that is the CLI's job.

---

## Rate Limiter

`RateLimiter` is stateful and lives inside the DO — one instance per `GameRoomDO`.

**Four checks run in this order:**
1. Mute — always checked, regardless of config (mute works even with `{}` config)
2. `maxPayloadBytes` — frame size in bytes, checked before full decode
3. `cooldownMs` — minimum ms between messages of the same type from the same player
4. `messagesPerSecond` — sliding 1-second window, per player per type

**Key bug that was fixed**: `windowStart` must be saved to state on the **first** message
in a window, not only on window transitions. The `??` fallback in
`state.windowStart.get(msgType) ?? now` returns a fresh `now` every call if the key was
never set — which makes every call appear to start a new window.

**`_now` injection**: The constructor accepts an optional `_now: () => number` parameter.
This is for testability only. In production the default `() => Date.now()` is always used.
Tests use this to control time without fake timers.

Config merge order: `global → perType` (perType wins on conflict). Room-level overrides
(`this.room.rateLimits`) are merged at construction time — the limiter config does not
change per-message.

---

## `onConnect` Middleware — Execution Order

```
WebSocket upgrade received
  └─ blockConcurrencyWhile(_onOpen)
       ├─ Room initialized? (first player only)
       ├─ PlayerImpl created
       ├─ onConnect(player, req)   ← auth, player.identify()
       │    └─ player.rejected?   ← ws.close(4001) and return
       ├─ room.canJoin(player)?   ← ws.close(4000) if false
       ├─ player added to all three maps
       ├─ ws.serializeAttachment(playerId)
       ├─ broadcastExcept(PLAYER_JOIN) to existing players
       ├─ room.onJoin(player)
       │    └─ player.rejected?   ← removed from maps, ws.close(4001)
       ├─ _persistState()
       ├─ room.broadcastState()   ← sends STATE_FULL to ALL players including new one
       └─ _notifyLobby()
```

**`player.identify()` flow** (called by developer inside `onConnect`):
1. Loads existing row from D1 using `id` field (if D1 configured)
2. Merges: stored data as defaults, developer-provided data as override
3. Validates with Zod schemas (if `defineIdentity` was called with Zod)
4. If validation fails: `player.reject(reason)` is called internally

`identify()` is `async` — always `await` it.

---

## CLI — How Migration Detection Works

`migrate:generate` does the following:
1. Reads `edgplay.config.ts` from cwd — must export `schema: ColumnDef[]`
2. Runs `PRAGMA table_info(edgplay_players)` via `wrangler d1 execute --json`
3. Diffs desired columns (from schema) vs current columns (from D1)
4. For removed+added pairs of the same SQL type: prompts for rename detection
5. Generates `migrations/XXXX_schema_update.ts` with `up` and `down` SQL

The `ColumnDef` type is the internal representation — it is what `schemaToColumns()`
produces from a Zod schema. The CLI reads `schema` (already-computed `ColumnDef[]`),
not the raw Zod schema.

The CLI uses `wrangler` as a subprocess — it must be run from the project directory
where `wrangler.jsonc` exists with a `d1_databases` binding named by the developer.

---

## Testing Patterns

### Mock DurableObjectState

Every DO test builds a `makeDOState()` that:
- Implements `blockConcurrencyWhile` as `(fn) => fn()` — runs synchronously
- Implements `getWebSockets()` returning `[]` by default
- Implements storage with an in-memory `Map`

**Do not change `blockConcurrencyWhile` to be truly async in tests.** The sync
behavior ensures test ordering is deterministic.

### Connecting a player in tests

Tests bypass the `fetch()` WS upgrade path and call `_onOpen` directly:

```ts
async function connectPlayer(do_, url = "https://example.com/room/chess/r1") {
  const ws  = new MockWebSocket() as unknown as WebSocket;
  const req = new Request(url);
  await (do_ as any)._onOpen(ws, req);
  return { ws: ws as MockWebSocket };
}
```

`_onOpen` is private — the cast to `any` is intentional and only used in tests.

### Time-dependent tests in RateLimiter

Never use `vi.useFakeTimers()` for RateLimiter tests — the fake timer interacts poorly
with the module's `Date.now()` caching. Instead, use the injectable `_now` parameter:

```ts
let t = 1000;
const limiter = new RateLimiter({ global: { cooldownMs: 500 } }, () => t);
limiter.check("p", GameEvent.ACTION, 10); // t = 1000
t += 600;
expect(limiter.check("p", GameEvent.ACTION, 10).allowed).toBe(true); // t = 1600
```

### What to test when adding a new feature

- **Happy path**: the feature works as documented
- **Edge cases**: empty state, zero values, single player, max players
- **Rejection paths**: invalid input is rejected cleanly, no partial state left behind
- **Ordering**: if the feature depends on lifecycle order (e.g. `onConnect` before
  `canJoin`), write a test that verifies the order with a spy

---

## Enums — Reserved Ranges

`GameEvent` byte values have reserved ranges. Do not add new values outside these:

| Range | Purpose |
|-------|---------|
| `0x01–0x0F` | State and lobby events |
| `0x10–0x1F` | Actions and input |
| `0x20–0x2F` | Social (chat, emotes) |
| `0x30–0x3F` | Game lifecycle |
| `0x40–0x4F` | Room administration |
| `0x50–0xFF` | **Developer-defined** — never add framework events here |

If you need a new framework event, add it to the appropriate reserved range and update
the enum in `enums.ts`. Then update `allowedMessages()` in the chess example if relevant.

---

## What Is Not Implemented Yet

These are stubs or partially implemented features. Do not assume they work:

- **`DOStorageAdapter`** (`persistence/DOStorageAdapter.ts`) — stub only, does nothing
- **`player.identify()` auto-load without explicit call** — only loads from D1 if the
  developer calls `identify()` in `onConnect`. There is no auto-load on connect.
- **`onRejoin`** — the hook exists on `GameRoom` but the reconnect window logic is not
  implemented. The server does not hold the player slot open after disconnect.
- **`stateFor(player)`** — implemented and called correctly by `broadcastState()`, but
  only tested through Chess (which uses the default full-state implementation). The
  partial-state path for UNO/Poker is not tested.
- **Countdown / `PLAYER_READY`** — the enum values exist but no framework logic handles them
- **`HOST_TRANSFER` / `KICK`** — enum values only, no implementation
- **3D multiplayer / DO Alarms** — explicitly out of scope for this PoC

---

## Common Mistakes to Avoid

### 1. Editing `package.json` with `str_replace` when the file has changed

Always `view` the file immediately before any `str_replace`. Package.json files are
prone to getting corrupted (duplicate content) if the cached view is stale.

### 2. Importing from `"edgplay"` in server-internal files

Inside `packages/server/src/`, always import relatively (`./GameRoom.js`). The `"edgplay"`
alias is only for external consumers (examples, user code).

### 3. Adding `require()` in an ESM file

The whole project is ESM (`"type": "module"`). Use dynamic `import()` if you need
a runtime conditional import. The `require()` call in `_handleViolation` that was
briefly present was a bug.

### 4. Forgetting `.js` extensions on imports

TypeScript with `"moduleResolution": "bundler"` resolves `.ts` files, but Vitest and
wrangler need `.js` extensions at runtime. Always write:
```ts
import { foo } from "./foo.js"; // correct — TS resolves to foo.ts
import { foo } from "./foo";    // wrong — breaks at runtime
```

### 5. Treating `this.room` as always non-null

`GameRoomDO.room` is `null` before `for()` sets it. Every method that touches `room`
must guard with `if (!this.room) return`. This is checked in most methods but easy to
forget in new ones.

### 6. Creating a new `RateLimiter` instance per message

The rate limiter is **stateful** — it tracks per-player window state across calls.
Creating a new instance per message resets all counters. It is instantiated once in the
`for()` constructor and reused for the lifetime of the DO.

### 7. Removing the `void connectMiddleware` line in the WS route

This suppresses a TypeScript "unused variable" warning. The middleware is used in
`_onOpen`, not in the Worker routing layer. It must stay captured in the closure for
future use (e.g. a pre-upgrade auth check).

---

## Adding a New Game Example

1. Create `examples/<game>/src/<Game>Room.ts` extending `GameRoom<State, Schema, Data>`
2. Define `initialState()`, `canJoin()`, `onJoin()`, `onLeave()`, `actions`
3. Create `examples/<game>/src/index.ts` with `createEngine().register(...)`
4. Create `examples/<game>/edgplay.config.ts` exporting `identitySchema` and `schema`
5. Create `examples/<game>/wrangler.jsonc` with DO bindings
6. Ensure `npx tsc --noEmit` passes in the example directory
7. Run the smoke test manually: two terminals, `wrangler dev` + Vite client

The chess example (`examples/chess/`) is the canonical reference. Match its structure.

---

## Dependency Philosophy

- **Minimal dependencies** — the framework has zero runtime dependencies (Zod is an
  optional peer dependency, never imported by framework code itself)
- Zod is introspected via `_def` duck typing, not imported — this keeps the framework
  usable without Zod
- The CLI uses Node built-ins and `wrangler` as a subprocess — no additional packages
- The client uses no dependencies — pure TypeScript

If you need to add a dependency, ask whether it could be a dev/peer dependency instead.
If it must be a runtime dependency, make it optional with graceful degradation.
