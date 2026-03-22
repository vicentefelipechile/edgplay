import { GameRoom, GameEvent } from "edgplay";
import type { identitySchema } from "../edgplay.config.js";

// ─── State ────────────────────────────────────────────────────────────────────

export interface ChessState {
  board: string;
  turn: "white" | "black";
  status: "waiting" | "playing" | "finished";
  winner: "white" | "black" | "draw" | null;
}

// ─── Per-session player data ──────────────────────────────────────────────────

/**
 * Data attached to each player for the duration of their session.
 * Not persisted, not visible to other players.
 */
interface ChessPlayerData {
  color: "white" | "black";
}

// ─── Developer-defined events (0x50–0xFF range) ───────────────────────────────

export const ChessEvent = {
  INVALID_MOVE: 0x50,
} as const;

// ─── Room ─────────────────────────────────────────────────────────────────────

export class ChessRoom extends GameRoom<ChessState, typeof identitySchema, ChessPlayerData> {
  maxPlayers = 2;

  initialState(): ChessState {
    return {
      board: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
      turn: "white",
      status: "waiting",
      winner: null,
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  onCreate(_options: unknown): void {
    console.log("[ChessRoom] created");
  }

  onJoin(player: this["Player"], _options: unknown): void {
    // player.data is typed as ChessPlayerData ✅
    player.data.color = this.players.size === 1 ? "white" : "black";

    console.log(`[ChessRoom] ${player.identity.public.name} joined as ${player.data.color}`);

    if (this.players.size === 2) {
      this.state.status = "playing";
      this.broadcast(GameEvent.GAME_START, null);
    }
  }

  onLeave(player: this["Player"]): void {
    console.log(`[ChessRoom] ${player.identity.public.name} left`);

    if (this.state.status === "playing") {
      // player.data.color is "white" | "black" — no cast needed ✅
      const winner = player.data.color === "white" ? "black" : "white";
      this.state.winner = winner;
      this.broadcast(GameEvent.GAME_OVER, { winner, reason: "disconnect" });
    }

    this.state.status = "waiting";
    this.state.winner = null;
  }

  onDispose(): void {
    console.log("[ChessRoom] disposed");
  }

  // ─── Lobby ─────────────────────────────────────────────────────────────────

  lobbyData() {
    return {
      players:    this.players.size,
      maxPlayers: this.maxPlayers,
      status:     this.state.status,
    };
  }

  isListed(): boolean {
    return this.state.status === "waiting";
  }

  canJoin(_player: this["Player"]): boolean {
    return this.players.size < this.maxPlayers && this.state.status === "waiting";
  }

  // ─── Message whitelist ─────────────────────────────────────────────────────

  allowedMessages(): number[] {
    switch (this.state.status) {
      case "waiting":  return [GameEvent.PLAYER_READY, GameEvent.CHAT, GameEvent.PING];
      case "playing":  return [GameEvent.ACTION, GameEvent.CHAT, GameEvent.EMOTE, GameEvent.PING];
      case "finished": return [GameEvent.PING];
      default:         return [GameEvent.PING];
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  actions = {
    move: (player: this["Player"], payload: { from: string; to: string }) => {
      if (this.state.status !== "playing") return;

      // player.data.color is "white" | "black" — direct comparison ✅
      if (this.state.turn !== player.data.color) {
        player.send(ChessEvent.INVALID_MOVE, { reason: "not your turn" });
        return;
      }
      if (!payload?.from || !payload?.to) {
        player.send(ChessEvent.INVALID_MOVE, { reason: "missing from/to" });
        return;
      }
      this.state.turn = this.state.turn === "white" ? "black" : "white";
    },

    resign: (player: this["Player"], _payload: unknown) => {
      if (this.state.status !== "playing") return;
      // No cast — color is already "white" | "black" ✅
      const winner = player.data.color === "white" ? "black" : "white";
      this.state.status = "finished";
      this.state.winner = winner;
      this.broadcast(GameEvent.GAME_OVER, { winner, reason: "resign" });
    },

    offerDraw: (player: this["Player"], _payload: unknown) => {
      if (this.state.status !== "playing") return;
      this.broadcastExcept(player.id, GameEvent.CHAT, {
        system: true,
        text: `${player.identity.public.name} offered a draw`,
      });
    },

    acceptDraw: (_player: this["Player"], _payload: unknown) => {
      if (this.state.status !== "playing") return;
      this.state.status = "finished";
      this.state.winner = "draw";
      this.broadcast(GameEvent.GAME_OVER, { winner: "draw", reason: "agreement" });
    },

    chat: (player: this["Player"], payload: { text: string }) => {
      if (!payload?.text?.trim()) return;
      const name = player.identity.public.name.toUpperCase();
      this.broadcast(GameEvent.CHAT, {
        from: name,
        text: payload.text.trim().slice(0, 200),
      });
    },
  };
}
