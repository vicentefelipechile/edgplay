# Edgplay — Proof of Concept

A lightweight multiplayer game framework built on **Cloudflare Durable Objects** and **WebSockets**.
One DO instance = one room. Zero infrastructure to manage.

---

## Packages

| Package | Description |
|---|---|
| `packages/server` | Core framework — `createEngine`, `GameRoom`, binary protocol |
| `packages/client` | JS/TS client SDK — `createClient`, `RoomConnection`, `LobbyConnection` |
| `packages/cli`    | `npx edgplay migrate:*` — D1 migration tooling |

## Examples

| Example | Key challenge |
|---|---|
| `examples/chess`  | Basic turn-based state, 2 players |
| `examples/uno`    | Multiple players, hidden hand state |
| `examples/poker`  | Hidden state + betting rounds + player roles |
| `examples/3d-multiplayer` | High-frequency state sync via DO Alarms |

---

## Getting started

```bash
# Install all dependencies
npm install

# Run protocol unit tests
npm run test --workspace=packages/server

# Start Chess example locally
npm run dev:chess
```

---

## Implementation status

### Done (scaffold)
- [x] Monorepo structure with npm workspaces
- [x] All enums: `GameEvent`, `RoomEvent`, `LobbyEvent`, `DisconnectReason`, `RateLimitViolation`
- [x] Binary protocol: `encode` / `decode` / `crc8` — fully implemented + tested
- [x] `GameRoom` abstract base class with full API surface
- [x] `createEngine` fluent API skeleton
- [x] `Player` type definition
- [x] `LobbyDO` stub
- [x] Persistence adapter stubs (`DOStorageAdapter`, `D1Adapter`)
- [x] `ChessRoom` — full game logic skeleton
- [x] Chess example Worker entry point + vanilla JS client
- [x] CLI entry point with all `migrate:*` command stubs

### Next up
- [ ] `createEngine` — WebSocket upgrade routing to correct DO
- [ ] `GameRoom` DO — WebSocket lifecycle, player registry, action pipeline
- [ ] `broadcastState` called automatically after actions
- [ ] `LobbyDO` — room index, KV snapshot, incremental LOBBY_PATCH
- [ ] Client SDK — `GameEvent` → `RoomEvent` translation, reconnect logic
- [ ] Chess smoke test end-to-end with two browser tabs

### Later
- [ ] `stateFor` hidden state (UNO, Poker)
- [ ] DO Alarms game loop (3D multiplayer)
- [ ] DO storage + D1 persistence adapters
- [ ] Edgplay native rate limiting
- [ ] CLI migrations (generate, apply, rollback, status)

---

## Architecture

```
[Client A]──┐
[Client B]──┼──WebSocket──▶ [Cloudflare Worker (entry point)]
[Client C]──┘                        │
                          ┌──────────┴──────────┐
                          │                     │
                    routes to room         routes to lobby
                          ▼                     ▼
              [Durable Object: GameRoom]   [Durable Object: LobbyDO]
               ├── Player registry         ├── Active room index
               ├── Game state              ├── Subscribed clients
               ├── Action handler          ├── KV snapshot writer
               └── Broadcaster             └── LOBBY_PATCH broadcaster
```

## Binary protocol

```
Byte 0:     Message type  (uint8)   — GameEvent or developer-defined (0x50–0xFF)
Byte 1:     Flags         (uint8)   — reserved
Byte 2-3:   Payload size  (uint16, big-endian)
Byte 4+:    Payload       (JSON UTF-8 or raw binary)
Byte N:     CRC-8         (uint8)   — covers all previous bytes
```

Total overhead: **5 bytes per message**. Malformed or CRC-failed messages are silently discarded.
