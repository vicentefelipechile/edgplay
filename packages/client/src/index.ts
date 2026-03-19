import { RoomConnection } from "./RoomConnection.js";
import { LobbyConnection } from "./LobbyConnection.js";
import type { ReconnectOptions } from "./RoomConnection.js";

export { RoomConnection } from "./RoomConnection.js";
export { LobbyConnection } from "./LobbyConnection.js";
export type { RoomSummary } from "./LobbyConnection.js";
export type { ReconnectOptions } from "./RoomConnection.js";

// Re-export enums so consumers only need one import
export { RoomEvent, LobbyEvent, DisconnectReason } from "edgplay";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JoinOptions {
  /** Arbitrary options forwarded to GameRoom.onJoin() as JSON query param */
  roomOptions?: unknown;
  /** Reconnect configuration */
  reconnect?: ReconnectOptions;
}

export interface CreateOptions {
  roomOptions?: unknown;
  reconnect?: ReconnectOptions;
}

// ─── createClient ─────────────────────────────────────────────────────────────

/**
 * Create a client pointed at an Edgplay Worker.
 *
 * @example — vanilla JS
 * const client = createClient("https://my-worker.dev");
 * const room = await client.game("chess").join("sala-123");
 * room.on(RoomEvent.STATE_CHANGE, (state) => renderBoard(state.board));
 *
 * @example — create a new room then join it
 * const room = await client.game("chess").create();
 *
 * @example — lobby
 * const lobby = client.game("chess").lobby();
 * lobby.on(LobbyEvent.ROOM_ADDED, (room) => addRoomToUI(room));
 */
export function createClient(workerUrl: string) {
  const base = workerUrl.replace(/\/$/, "");

  function toWs(url: string): string {
    return url.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  }

  return {
    game(name: string) {
      return {
        join(roomId: string, options: JoinOptions = {}): RoomConnection {
          const params = options.roomOptions
            ? `?options=${encodeURIComponent(JSON.stringify(options.roomOptions))}`
            : "";
          const url = `${toWs(base)}/room/${name}/${roomId}${params}`;
          return new RoomConnection(url, options.reconnect);
        },

        async create(options: CreateOptions = {}): Promise<RoomConnection> {
          const res = await fetch(`${base}/room/${name}`, { method: "POST" });
          if (!res.ok) throw new Error(`Failed to create room: ${res.status}`);
          const { roomId } = await res.json() as { roomId: string };
          return this.join(roomId, options);
        },

        lobby(): LobbyConnection {
          const url = `${toWs(base)}/lobby/${name}`;
          return new LobbyConnection(url);
        },
      };
    },
  };
}
