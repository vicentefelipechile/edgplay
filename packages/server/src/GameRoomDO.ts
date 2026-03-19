import type { GameRoom } from "./GameRoom.js";
import type { EdgplayEnv } from "./createEngine.js";
import { PlayerImpl } from "./PlayerImpl.js";
import { decode, encode } from "./protocol/index.js";
import { GameEvent, DisconnectReason } from "./enums.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GameRoomClass = new () => GameRoom<any>;

/**
 * GameRoomDO — the Durable Object that backs every game room.
 *
 * Responsibilities:
 *  - Accept the WebSocket upgrade and manage connection lifecycle
 *  - Maintain the player registry (connect / disconnect / reconnect)
 *  - Decode incoming binary frames and route them:
 *      • GameEvent.ACTION  → actions pipeline (validate → call → broadcastState)
 *      • GameEvent.PING    → auto PONG (no room handler)
 *      • 0x50–0xFF         → raw messages map (bypass pipeline)
 *      • anything else     → built-in framework handlers
 *  - Enforce allowedMessages() whitelist
 *  - Notify LobbyDO when room state changes
 *
 * One instance of this class = one game room.
 * The developer never instantiates or subclasses this — they subclass GameRoom.
 */
export class GameRoomDO implements DurableObject {
  private room: GameRoom | null = null;
  private RoomClass: GameRoomClass | null = null;

  /** Game name extracted from the first request URL e.g. "chess" */
  private _gameName: string | null = null;
  /** Room ID extracted from the first request URL e.g. "sala-123" */
  private _roomId_: string | null = null;

  /** playerId → PlayerImpl for all currently connected players */
  private connected = new Map<string, PlayerImpl>();

  /** ws → playerId reverse index for O(1) lookup in message/close handlers */
  private wsByPlayer = new Map<WebSocket, string>();

  /** Whether onCreate() has already been called for this DO instance */
  private initialized = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: EdgplayEnv
  ) {}

  // ─── Public fetch entry point ─────────────────────────────────────────────

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // POST /init?game=chess&room=sala-123 — called by the Worker on room creation
    if (req.method === "POST" && url.pathname === "/init") {
      const game = url.searchParams.get("game");
      const room = url.searchParams.get("room");
      if (game) await this.state.storage.put("_game", game);
      if (room) await this.state.storage.put("_room", room);
      return new Response("ok");
    }

    // WebSocket upgrade — the main path
    // URL format: /room/:game/:roomId  (forwarded verbatim from the Worker)
    if (req.headers.get("Upgrade") === "websocket") {
      // Extract game + room from path if not yet stored (first connect may skip /init)
      const parts = url.pathname.replace(/^\//, "").split("/");
      // parts = ["room", "chess", "sala-123"]
      if (!this._gameName && parts[1]) this._gameName = parts[1];
      if (!this._roomId_  && parts[2]) this._roomId_  = parts[2];
      return this._handleUpgrade(req);
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── WebSocket upgrade ────────────────────────────────────────────────────

  private _handleUpgrade(req: Request): Response {
    const { 0: client, 1: server } = new WebSocketPair();

    this.state.acceptWebSocket(server);
    this._onOpen(server, req);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── WebSocket lifecycle (called by CF runtime via acceptWebSocket) ────────

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // We only accept binary frames
    if (!(message instanceof ArrayBuffer)) return;

    const player = this._playerForWs(ws);
    if (!player || !this.room) return;

    const msg = decode(message);
    if (!msg) return; // CRC failed or malformed — silently discard

    // ── maxPayloadBytes check (before any handler) ────────────────────────
    // TODO: check against rate limit config once rate limiting is implemented

    // ── allowedMessages() whitelist ───────────────────────────────────────
    const allowed = this.room.allowedMessages();
    if (allowed !== null && !allowed.includes(msg.type)) return;

    // ── Built-in framework handlers ───────────────────────────────────────
    switch (msg.type) {
      case GameEvent.PING:
        player.sendRaw(encode(GameEvent.PONG, null));
        return;

      case GameEvent.ACTION:
        await this._handleAction(player, msg.payload);
        return;
    }

    // ── Raw message handlers (developer-defined 0x50–0xFF) ────────────────
    if (msg.type >= 0x50) {
      const handler = this.room.messages[msg.type];
      if (handler) handler(player, message);
      return;
    }

    // Everything else is silently ignored (framework reserved range with no handler)
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string): Promise<void> {
    const player = this._playerForWs(ws);
    if (!player || !this.room) return;

    const reason = code === 1001
      ? DisconnectReason.LOST
      : DisconnectReason.LEFT;

    this._removePlayer(player, reason);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const player = this._playerForWs(ws);
    if (!player || !this.room) return;
    this._removePlayer(player, DisconnectReason.SERVER_ERROR);
  }

  // ─── Player connect / disconnect ──────────────────────────────────────────

  private _onOpen(ws: WebSocket, req: Request): void {
    if (!this.room) {
      // RoomClass not injected yet — this shouldn't happen in normal flow
      ws.close(1011, "room not initialized");
      return;
    }

    // Lazy init — onCreate fires only once per DO instance lifetime
    if (!this.initialized) {
      this.room.state = this.room.initialState();
      this.room.onCreate(null);
      this.initialized = true;
    }

    const playerId = crypto.randomUUID();
    const player = new PlayerImpl(playerId, ws);

    // Temporarily register so canJoin/onJoin can reference the player
    this.room.players.set(playerId, player);

    // Check join eligibility
    if (!this.room.canJoin(player)) {
      this.room.players.delete(playerId);
      ws.close(4000, "room full");
      return;
    }

    this.connected.set(playerId, player);
    this.wsByPlayer.set(ws, playerId);

    // Notify other players
    this.room.broadcastExcept(playerId, GameEvent.PLAYER_JOIN, {
      id: playerId,
      identity: player.identity.public,
    });

    // Fire onJoin — developer can reject the player inside this hook
    this.room.onJoin(player, this._parseJoinOptions(req));

    if (player.rejected) {
      this.room.players.delete(playerId);
      this.connected.delete(playerId);
      ws.close(4001, player.rejectReason || "rejected");
      return;
    }

    // Notify LobbyDO of the update (fire-and-forget)
    this._notifyLobby();
  }

  private _removePlayer(player: PlayerImpl, reason: DisconnectReason): void {
    if (!this.room) return;

    this.room.players.delete(player.id);
    this.connected.delete(player.id);
    // Clean up the reverse WS index
    for (const [ws, id] of this.wsByPlayer.entries()) {
      if (id === player.id) { this.wsByPlayer.delete(ws); break; }
    }

    this.room.onLeave(player);

    // Tell remaining players
    this.room.broadcast(GameEvent.PLAYER_LEAVE, {
      id: player.id,
      reason,
    });

    // Dispose room when last player leaves
    if (this.room.players.size === 0) {
      this.room.onDispose();
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

    // Call the developer's handler
    handler(player, p.payload ?? null);

    // Auto broadcastState after every action
    this.room.broadcastState();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Find the PlayerImpl whose WebSocket matches ws — O(1) via reverse index */
  private _playerForWs(ws: WebSocket): PlayerImpl | undefined {
    const id = this.wsByPlayer.get(ws);
    return id ? this.connected.get(id) : undefined;
  }

  private _parseJoinOptions(req: Request): unknown {
    const url = new URL(req.url);
    const opts = url.searchParams.get("options");
    if (!opts) return null;
    try { return JSON.parse(opts); } catch { return null; }
  }

  /** Tell the LobbyDO that this room's data has changed */
  private _notifyLobby(): void {
    if (!this.room) return;

    const lobbyKey = this._lobbyKey();
    if (!lobbyKey) return;

    const id = this.env.LOBBY.idFromName(lobbyKey);
    const stub = this.env.LOBBY.get(id);

    const update = {
      roomId: this._roomId(),
      listed: this.room.isListed(),
      data: this.room.lobbyData(),
    };

    // Fire-and-forget — we don't await this
    stub.fetch(new Request("https://internal/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    })).catch(() => {
      // LobbyDO unreachable — non-fatal
    });
  }

  /**
   * Derive the lobby DO name from the game name.
   * DO name format: "chess:sala-123"  →  lobby key: "lobby:chess"
   */
  private _lobbyKey(): string | null {
    return this._gameName ? `lobby:${this._gameName}` : null;
  }

  private _roomId(): string {
    return this._roomId_ ?? "unknown";
  }

  // ─── Static factory — used by createEngine to inject the RoomClass ────────

  /**
   * Produce a concrete DO class bound to a specific GameRoom subclass.
   * This is what createEngine uses to generate the static DO exports.
   */
  static for(RoomClass: GameRoomClass): new (state: DurableObjectState, env: EdgplayEnv) => GameRoomDO {
    return class extends GameRoomDO {
      constructor(state: DurableObjectState, env: EdgplayEnv) {
        super(state, env);
        this.RoomClass = RoomClass;
        this.room = new RoomClass();
      }
    };
  }
}
