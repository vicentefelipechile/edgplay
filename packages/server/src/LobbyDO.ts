import type { EdgplayEnv } from "./createEngine.js";
import { encode } from "./protocol/index.js";
import { GameEvent } from "./enums.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RoomEntry {
  roomId: string;
  listed: boolean;
  data: Record<string, unknown>;
}

type LobbyPatchOp =
  | { op: "add";    roomId: string; data: Record<string, unknown> }
  | { op: "update"; roomId: string; data: Record<string, unknown> }
  | { op: "remove"; roomId: string };

// ─── LobbyDO ─────────────────────────────────────────────────────────────────

/**
 * LobbyDO — Durable Object acting as room index for a single game type.
 *
 * One instance per game type: "lobby:chess", "lobby:poker", etc.
 *
 * Responsibilities:
 *  - Maintain an in-memory map of active, listed rooms
 *  - Accept WebSocket subscriptions from clients wanting a live room list
 *  - Send LOBBY_LIST (full snapshot) on subscribe
 *  - Receive POST /notify from GameRoom DOs when room state changes
 *  - Broadcast LOBBY_PATCH (incremental update) to all subscribers
 *  - Write a KV snapshot after every change for fast HTTP reads
 *  - Respond to GET /list with current listed rooms (HTTP fallback)
 */
export class LobbyDO implements DurableObject {
  /** All rooms we know about, keyed by roomId — includes unlisted rooms */
  private rooms = new Map<string, RoomEntry>();

  /** WebSocket subscribers wanting live updates, keyed by a random sub ID */
  private subscribers = new Map<string, WebSocket>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: EdgplayEnv
  ) {}

  // ─── fetch entry point ────────────────────────────────────────────────────

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // WebSocket upgrade — client wants live lobby updates
    if (req.headers.get("Upgrade") === "websocket") {
      return this._handleSubscribe();
    }

    // POST /notify — a GameRoom DO is reporting a state change
    if (req.method === "POST" && url.pathname === "/notify") {
      return this._handleNotify(req);
    }

    // GET /list — HTTP fallback, returns current listed rooms as JSON
    if (req.method === "GET" && url.pathname === "/list") {
      return Response.json(this._listedRooms());
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── WebSocket subscription ───────────────────────────────────────────────

  private _handleSubscribe(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    this._subscribeWs(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Register a WebSocket as a lobby subscriber and send the initial snapshot.
   *  Separated from _handleSubscribe so tests can inject a mock WS directly. */
  _subscribeWs(ws: WebSocket): void {
    const subId = crypto.randomUUID();
    ws.serializeAttachment(subId);
    this.subscribers.set(subId, ws);
    ws.send(encode(GameEvent.LOBBY_LIST, this._listedRooms()));
  }

  // ─── CF WebSocket lifecycle (called by runtime via acceptWebSocket) ────────

  webSocketClose(ws: WebSocket): void {
    const subId = ws.deserializeAttachment() as string | null;
    if (subId) this.subscribers.delete(subId);
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  // Clients aren't expected to send anything to the lobby WS,
  // but we handle any frame gracefully so the connection stays alive.
  webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string): void {
    // Intentionally empty — lobby is server-push only.
    // PING/PONG is handled automatically by CF's WebSocket hibernation API.
  }

  // ─── Room notify ──────────────────────────────────────────────────────────

  private async _handleNotify(req: Request): Promise<Response> {
    let body: RoomEntry;
    try {
      body = await req.json() as RoomEntry;
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    if (!body.roomId || typeof body.roomId !== "string") {
      return new Response("Missing roomId", { status: 400 });
    }

    const prev = this.rooms.get(body.roomId);
    const patch = this._applyUpdate(prev, body);

    if (patch) {
      this._broadcastPatch(patch);
      await this._writeKvSnapshot();
    }

    return new Response("ok");
  }

  // ─── Room index logic ─────────────────────────────────────────────────────

  /**
   * Apply an incoming room update to our index.
   * Returns the patch op to broadcast, or null if nothing changed.
   */
  private _applyUpdate(prev: RoomEntry | undefined, next: RoomEntry): LobbyPatchOp | null {
    if (!next.listed) {
      // Room is delisted or closed — remove it if we knew about it
      if (prev) {
        this.rooms.delete(next.roomId);
        return { op: "remove", roomId: next.roomId };
      }
      return null; // never knew about it — nothing to do
    }

    // Room is listed
    this.rooms.set(next.roomId, next);

    if (!prev || !prev.listed) {
      // New room appearing in the lobby
      return { op: "add", roomId: next.roomId, data: next.data };
    }

    // Existing room — only broadcast if data actually changed
    if (JSON.stringify(prev.data) === JSON.stringify(next.data)) return null;

    return { op: "update", roomId: next.roomId, data: next.data };
  }

  // ─── Broadcast ────────────────────────────────────────────────────────────

  private _broadcastPatch(patch: LobbyPatchOp): void {
    if (this.subscribers.size === 0) return;

    const frame = encode(GameEvent.LOBBY_PATCH, patch);
    const dead: string[] = [];

    for (const [subId, ws] of this.subscribers.entries()) {
      try {
        ws.send(frame);
      } catch {
        // Subscriber disconnected without a clean close — collect for cleanup
        dead.push(subId);
      }
    }

    for (const id of dead) this.subscribers.delete(id);
  }

  // ─── KV snapshot ─────────────────────────────────────────────────────────

  /**
   * Write the current listed room list to KV so the Worker can serve
   * fast HTTP reads without hitting the DO.
   * No-op if LOBBY_CACHE is not configured.
   */
  private async _writeKvSnapshot(): Promise<void> {
    if (!this.env.LOBBY_CACHE) return;

    const snapshot = this._listedRooms();
    const key = this._kvKey();

    try {
      await this.env.LOBBY_CACHE.put(key, JSON.stringify(snapshot), {
        expirationTtl: 60, // 1-minute TTL — stale data evicts itself
      });
    } catch {
      // KV write failure is non-fatal — the DO is still authoritative
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Returns only listed rooms as a plain array, suitable for JSON */
  private _listedRooms(): Array<{ roomId: string; data: Record<string, unknown> }> {
    return [...this.rooms.values()]
      .filter(r => r.listed)
      .map(({ roomId, data }) => ({ roomId, data }));
  }

  /**
   * KV key for this lobby's snapshot.
   * The Worker sets and reads KV keys as "lobby:<game>" — we use the same pattern.
   * TODO: store the game name via a bootstrap POST (same pattern as GameRoomDO /init)
   */
  private _kvKey(): string {
    return (this.state as unknown as { id: { name?: string } }).id?.name ?? "lobby:unknown";
  }
}
