import { EventEmitter } from "./EventEmitter.js";
import { decode } from "edgplay";
import { GameEvent, LobbyEvent } from "edgplay";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RoomSummary {
  roomId: string;
  data: Record<string, unknown>;
}

type LobbyEventMap = {
  [LobbyEvent.ROOM_LIST]:    RoomSummary[];
  [LobbyEvent.ROOM_ADDED]:   RoomSummary;
  [LobbyEvent.ROOM_UPDATED]: RoomSummary;
  [LobbyEvent.ROOM_REMOVED]: { roomId: string };
};

type PatchPayload =
  | { op: "add";    roomId: string; data: Record<string, unknown> }
  | { op: "update"; roomId: string; data: Record<string, unknown> }
  | { op: "remove"; roomId: string };

// ─── LobbyConnection ──────────────────────────────────────────────────────────

/**
 * Manages the WebSocket connection to a LobbyDO.
 *
 * Maintains a local room list and keeps it in sync via incremental patches.
 * Translates GameEvent.LOBBY_LIST / LOBBY_PATCH into typed LobbyEvent emissions.
 */
export class LobbyConnection extends EventEmitter<LobbyEventMap> {
  private ws: WebSocket | null = null;

  /** Local copy of the room list — kept in sync with the server */
  private _rooms = new Map<string, RoomSummary>();

  constructor(private readonly url: string) {
    super();
    this._connect();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Current snapshot of all listed rooms */
  get rooms(): RoomSummary[] {
    return [...this._rooms.values()];
  }

  /** Disconnect from the lobby */
  disconnect(): void {
    this.ws?.close(1000, "left");
    this.removeAllListeners();
  }

  // ─── WebSocket lifecycle ──────────────────────────────────────────────────

  private _connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("message", (ev) => this._onMessage(ev));
    ws.addEventListener("error",   ()   => { /* close fires right after */ });
  }

  private _onMessage(ev: MessageEvent): void {
    if (!(ev.data instanceof ArrayBuffer)) return;

    const msg = decode(ev.data);
    if (!msg) return;

    switch (msg.type) {

      case GameEvent.LOBBY_LIST: {
        // Full snapshot — replace local state
        const list = msg.payload as RoomSummary[];
        this._rooms.clear();
        for (const room of list) this._rooms.set(room.roomId, room);
        this.emit(LobbyEvent.ROOM_LIST, list);
        return;
      }

      case GameEvent.LOBBY_PATCH: {
        this._applyPatch(msg.payload as PatchPayload);
        return;
      }

      case GameEvent.PONG:
        return; // keepalive — ignore

      default:
        return;
    }
  }

  // ─── Patch application ────────────────────────────────────────────────────

  private _applyPatch(patch: PatchPayload): void {
    switch (patch.op) {
      case "add": {
        const room: RoomSummary = { roomId: patch.roomId, data: patch.data };
        this._rooms.set(patch.roomId, room);
        this.emit(LobbyEvent.ROOM_ADDED, room);
        return;
      }

      case "update": {
        const existing = this._rooms.get(patch.roomId);
        const room: RoomSummary = { roomId: patch.roomId, data: patch.data };
        this._rooms.set(patch.roomId, room);
        // Only emit if we knew about this room — ignore phantom updates
        if (existing) this.emit(LobbyEvent.ROOM_UPDATED, room);
        return;
      }

      case "remove": {
        const existed = this._rooms.delete(patch.roomId);
        if (existed) this.emit(LobbyEvent.ROOM_REMOVED, { roomId: patch.roomId });
        return;
      }
    }
  }
}
