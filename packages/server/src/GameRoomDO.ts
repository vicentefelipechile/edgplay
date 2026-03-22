import type { GameRoom } from "./GameRoom.js";
import type { EdgplayEnv } from "./createEngine.js";
import type { Player } from "./Player.js";
import { PlayerImpl } from "./PlayerImpl.js";
import { decode, encode } from "./protocol/index.js";
import { GameEvent, DisconnectReason, RateLimitViolation } from "./enums.js";
import { RateLimiter } from "./ratelimit/RateLimiter.js";
import type { RateLimitsConfig } from "./GameRoom.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GameRoomClass = new () => GameRoom<any, any, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodSchema = { safeParse: (data: unknown) => { success: boolean; error?: any; data?: any } };

interface IdentitySchemas {
  public?:  ZodSchema;
  private?: ZodSchema;
}

type ConnectMiddleware = (player: Player, req: Request) => void | Promise<void>;

/**
 * GameRoomDO — the Durable Object that backs every game room.
 *
 * Concurrency model:
 *  - blockConcurrencyWhile in constructor: restores persisted state before
 *    any fetch/message runs
 *  - _handleUpgrade wraps _onOpen in blockConcurrencyWhile: the player is
 *    fully registered before any message from them (or anyone else) is processed
 *  - This serializes all mutable operations, matching the CF DO single-thread guarantee
 */
export class GameRoomDO implements DurableObject {
  private room: GameRoom | null = null;
  private RoomClass: GameRoomClass | null = null;
  private _adapter: import("./persistence/D1Adapter.js").D1Adapter | null = null;
  private _onConnect: ConnectMiddleware | null = null;
  private _schemas: IdentitySchemas = {};
  private _globalRateLimits: RateLimitsConfig = {};
  private _rateLimiter: RateLimiter | null = null;

  private _gameName: string | null = null;
  private _roomId_: string | null = null;

  /** playerId → PlayerImpl */
  private connected = new Map<string, PlayerImpl>();

  /** ws → playerId — O(1) reverse lookup */
  private wsByPlayer = new Map<WebSocket, string>();

  private initialized = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: EdgplayEnv
  ) {
    this.state.blockConcurrencyWhile(async () => {
      await this._restoreState();
    });
  }

  // ─── State persistence ────────────────────────────────────────────────────

  private async _restoreState(): Promise<void> {
    const stored = await this.state.storage.get<{
      gameState: unknown;
      gameName: string;
      roomId: string;
    }>("_edgplay");

    if (!stored || !this.room) return;

    this.room.state  = stored.gameState as never;
    this._gameName   = stored.gameName;
    this._roomId_    = stored.roomId;
    this.initialized = true;

    // Rebuild player registry from live WebSockets only.
    // getWebSockets() is the authoritative source — if a WS isn't here,
    // that player disconnected while the DO was hibernated.
    const liveWs = this.state.getWebSockets();

    for (const ws of liveWs) {
      const playerId = ws.deserializeAttachment() as string | null;
      if (!playerId) continue;
      const player = new PlayerImpl(playerId, ws);
      this.connected.set(playerId, player);
      this.wsByPlayer.set(ws, playerId);
      this.room.players.set(playerId, player);
    }

    // If players disconnected while hibernated, the room.players map
    // only contains those with live WS — which is correct.
    // But the persisted gameState may have had more players.
    // If all players are gone, reset so new players can join cleanly.
    if (liveWs.length === 0 && this.initialized) {
      this.initialized = false;
      await this.state.storage.delete("_edgplay");
    }
  }

  private async _persistState(): Promise<void> {
    if (!this.room || !this.initialized) return;
    await this.state.storage.put("_edgplay", {
      gameState: this.room.state,
      gameName:  this._gameName ?? "",
      roomId:    this._roomId_  ?? "",
    });
  }

  // ─── fetch entry point ────────────────────────────────────────────────────

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/init") {
      const game = url.searchParams.get("game");
      const room  = url.searchParams.get("room");
      if (game) this._gameName = game;
      if (room) this._roomId_  = room;
      return new Response("ok");
    }

    if (req.headers.get("Upgrade") === "websocket") {
      return this._handleUpgrade(req);
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── WebSocket upgrade ────────────────────────────────────────────────────

  private _handleUpgrade(req: Request): Response {
    const { 0: client, 1: server } = new WebSocketPair();

    // acceptWebSocket MUST be called synchronously (before any await)
    this.state.acceptWebSocket(server);

    // Wrap _onOpen in blockConcurrencyWhile so no message handler runs
    // until the player is fully registered in all maps.
    // This is the key fix for the "messages arrive before player is registered" bug.
    this.state.blockConcurrencyWhile(() => this._onOpen(server, req));

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── CF WebSocket lifecycle ───────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (!(message instanceof ArrayBuffer)) return;

    const player = this._playerForWs(ws);
    if (!player || !this.room) return;

    // ── Rate limiting — checked before decoding ───────────────────────────────
    // Peek the message type from byte 0 (no full decode needed for the check)
    if (this._rateLimiter) {
      const msgType = message.byteLength > 0 ? new DataView(message).getUint8(0) : 0;
      const result  = this._rateLimiter.check(player.id, msgType, message.byteLength);
      if (!result.allowed) {
        this._handleViolation(player, result.violation);
        return;
      }
    }

    const msg = decode(message);
    if (!msg) return; // CRC fail — discard

    const allowed = this.room.allowedMessages();
    if (allowed !== null && !allowed.includes(msg.type)) return;

    switch (msg.type) {
      case GameEvent.PING:
        player.sendRaw(encode(GameEvent.PONG, null));
        return;

      case GameEvent.ACTION:
        await this._handleAction(player, msg.payload);
        return;
    }

    // Developer-defined range 0x50–0xFF
    if (msg.type >= 0x50) {
      const handler = this.room.messages[msg.type];
      if (handler) handler(player, message);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string): Promise<void> {
    const player = this._playerForWs(ws);
    if (!player || !this.room) return;
    const reason = code === 1001 ? DisconnectReason.LOST : DisconnectReason.LEFT;
    this._removePlayer(player, reason);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const player = this._playerForWs(ws);
    if (!player || !this.room) return;
    this._removePlayer(player, DisconnectReason.SERVER_ERROR);
  }

  // ─── Player open ──────────────────────────────────────────────────────────

  private async _onOpen(ws: WebSocket, req: Request): Promise<void> {
    if (!this.room) {
      ws.close(1011, "room not initialized");
      return;
    }

    const parts = new URL(req.url).pathname.replace(/^\//, "").split("/");
    // parts: ["room", "chess", "sala-123"]

    if (!this.initialized) {
      this.room.state = this.room.initialState();
      this.room.onCreate(null);
      this.initialized = true;
      if (!this._gameName) this._gameName = parts[1] ?? null;
      if (!this._roomId_)  this._roomId_  = parts[2] ?? null;
      await this._persistState();
    }

    const playerId = crypto.randomUUID();
    const player   = new PlayerImpl(playerId, ws, this._adapter, this._schemas);
    // This is where the developer validates auth tokens and calls player.identify()
    if (this._onConnect) {
      await this._onConnect(player, req);

      if (player.rejected) {
        ws.close(4001, player.rejectReason || "unauthorized");
        return;
      }
    }

    // canJoin sees only already-confirmed players — new player NOT yet in map
    if (!this.room.canJoin(player)) {
      ws.close(4000, "room full");
      return;
    }

    // Register in all maps atomically (we're inside blockConcurrencyWhile)
    this.room.players.set(playerId, player);
    this.connected.set(playerId, player);
    this.wsByPlayer.set(ws, playerId);
    ws.serializeAttachment(playerId);

    // Notify existing players — include public identity so they see the name
    this.room.broadcastExcept(playerId, GameEvent.PLAYER_JOIN, {
      id:       playerId,
      identity: player.identity.public,
    });

    // Developer hook — player.reject() can be called here
    this.room.onJoin(player, this._parseJoinOptions(req));

    if (player.rejected) {
      this.room.players.delete(playerId);
      this.connected.delete(playerId);
      this.wsByPlayer.delete(ws);
      ws.close(4001, player.rejectReason || "rejected");
      return;
    }

    // Persist after onJoin — state may have changed (e.g. status → "playing")
    await this._persistState();

    // Single broadcastState after onJoin — sends updated state to ALL players.
    // The developer's onJoin should NOT call player.send(STATE_FULL) manually;
    // the framework handles it here.
    this.room.broadcastState();

    this._notifyLobby();
  }

  // ─── Player remove ────────────────────────────────────────────────────────

  private _removePlayer(player: PlayerImpl, reason: DisconnectReason): void {
    if (!this.room) return;

    this.room.players.delete(player.id);
    this.connected.delete(player.id);
    for (const [ws, id] of this.wsByPlayer.entries()) {
      if (id === player.id) { this.wsByPlayer.delete(ws); break; }
    }

    this.room.onLeave(player);

    // Broadcast state after onLeave — e.g. ChessRoom resets status to "waiting"
    this.room.broadcastState();

    this.room.broadcast(GameEvent.PLAYER_LEAVE, { id: player.id, reason });

    // Close the departing player's WS from the server side.
    // This completes the TCP close handshake immediately so the client
    // doesn't have to wait for the server FIN — leave() feels instant.
    try { player.close(1000, reason); } catch { /* already closed */ }

    if (this.room.players.size === 0) {
      this.room.onDispose();
      this.initialized = false;
      this.state.storage.delete("_edgplay").catch(() => {});
    } else {
      this._persistState().catch(() => {});
    }

    this._notifyLobby();
  }

  // ─── Action pipeline ──────────────────────────────────────────────────────

  private async _handleAction(player: PlayerImpl, payload: unknown): Promise<void> {
    if (!this.room) return;

    const p = payload as { action?: string; payload?: unknown } | null;
    if (!p || typeof p.action !== "string") return;

    const handler = this.room.actions[p.action];
    if (!handler) return;

    handler(player, p.payload ?? null);
    await this._persistState();
    this.room.broadcastState();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private _playerForWs(ws: WebSocket): PlayerImpl | undefined {
    // Primary: O(1) reverse index (valid within the same DO instance lifetime)
    const id = this.wsByPlayer.get(ws);
    if (id) return this.connected.get(id);

    // Fallback: attachment survives hibernation — use it to find the player
    // This handles the case where the DO woke up and wsByPlayer was rebuilt
    // from getWebSockets() but the map entry is keyed to a different WS object reference
    const attachedId = ws.deserializeAttachment?.() as string | null;
    if (attachedId) {
      const player = this.connected.get(attachedId);
      if (player) {
        // Heal the map so future lookups are O(1) again
        this.wsByPlayer.set(ws, attachedId);
        return player;
      }
    }

    return undefined;
  }

  private _parseJoinOptions(req: Request): unknown {
    const opts = new URL(req.url).searchParams.get("options");
    if (!opts) return null;
    try { return JSON.parse(opts); } catch { return null; }
  }

  /** Merge global engine rate limits with per-room overrides */
  private _mergeRateLimits(roomOverrides?: RateLimitsConfig): RateLimitsConfig | null {
    const global = this._globalRateLimits;
    const hasGlobal = Object.keys(global).length > 0;
    if (!roomOverrides && !hasGlobal) return null;
    if (!roomOverrides) return global;
    return {
      global:  { ...global.global,  ...roomOverrides.global  },
      perType: { ...global.perType, ...roomOverrides.perType },
    };
  }

  /** Apply the violation action — drop, warn, or kick */
  private _handleViolation(player: PlayerImpl, violation: RateLimitViolation): void {
    switch (violation) {
      case RateLimitViolation.DROP:
        return; // silently discard
      case RateLimitViolation.WARN:
        player.send(GameEvent.ROOM_ERROR, { reason: "rate_limited" });
        return;
      case RateLimitViolation.KICK:
        this._removePlayer(player, DisconnectReason.RATE_LIMITED);
        return;
    }
  }

  private _notifyLobby(): void {
    if (!this.room || !this._gameName) return;

    const id   = this.env.LOBBY.idFromName(`lobby:${this._gameName}`);
    const stub = this.env.LOBBY.get(id);
    stub.fetch(new Request("https://internal/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: this._roomId_ ?? "unknown",
        listed: this.room.isListed(),
        data:   this.room.lobbyData(),
      }),
    })).catch(() => {});
  }

  // ─── Static factory ───────────────────────────────────────────────────────

  static for(
    RoomClass: GameRoomClass,
    makeAdapter?: (env: EdgplayEnv) => import("./persistence/D1Adapter.js").D1Adapter | null,
    onConnect?: ConnectMiddleware | null,
    schemas?: IdentitySchemas,
    rateLimits?: RateLimitsConfig
  ): new (state: DurableObjectState, env: EdgplayEnv) => GameRoomDO {
    return class extends GameRoomDO {
      constructor(state: DurableObjectState, env: EdgplayEnv) {
        super(state, env);
        this.RoomClass         = RoomClass;
        this.room              = new RoomClass();
        this._onConnect        = onConnect ?? null;
        this._schemas          = schemas ?? {};
        this._globalRateLimits = rateLimits ?? {};
        if (makeAdapter) this._adapter = makeAdapter(env);

        // Merge global config with per-room overrides now that room is instantiated
        const merged = this._mergeRateLimits(this.room?.rateLimits);
        if (merged) this._rateLimiter = new RateLimiter(merged);

        // Wire mute() so the GameRoom can call it and it delegates to the limiter
        if (this._rateLimiter) {
          const limiter = this._rateLimiter;
          this.room._muteFn = (playerId, type, durationMs) => {
            limiter.mute(playerId, type, durationMs);
          };
        }
      }
    };
  }
}
