import { GameRoom, GameEvent } from "edgplay";
import type { Player } from "edgplay";

// ─── State ────────────────────────────────────────────────────────────────────

export interface ChessState {
  /** FEN string representing the board */
  board: string;
  turn: "white" | "black";
  status: "waiting" | "playing" | "finished";
  winner: "white" | "black" | "draw" | null;
}

// ─── Developer-defined events (0x50–0xFF range) ───────────────────────────────

export const ChessEvent = {
  /** Server → client: invalid move attempted */
  INVALID_MOVE: 0x50,
} as const;

// ─── Room ─────────────────────────────────────────────────────────────────────

export class ChessRoom extends GameRoom<ChessState> {
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

  onJoin(player: Player, _options: unknown): void {
    // Assign color based on join order
    const color = this.players.size === 1 ? "white" : "black";
    player.data.color = color;

    console.log(`[ChessRoom] ${player.id} joined as ${color}`);

    // Start game when both players are present
    if (this.players.size === 2) {
      this.state.status = "playing";
      this.broadcast(GameEvent.GAME_START, null);
    }

    // Send full state to the joining player
    player.send(GameEvent.STATE_FULL, this.stateFor(player));
  }

  onLeave(player: Player): void {
    console.log(`[ChessRoom] ${player.id} left`);

    if (this.state.status === "playing") {
      // Opponent wins on disconnect
      const winner = player.data.color === "white" ? "black" : "white";
      this.state.status = "finished";
      this.state.winner = winner;
      this.broadcast(GameEvent.GAME_OVER, { winner, reason: "disconnect" });
    }
  }

  onDispose(): void {
    console.log("[ChessRoom] disposed");
  }

  // ─── Lobby ─────────────────────────────────────────────────────────────────

  lobbyData() {
    return {
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      status: this.state.status,
    };
  }

  isListed(): boolean {
    return this.state.status === "waiting";
  }

  canJoin(player: Player): boolean {
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
    /**
     * A chess move: { from: "e2", to: "e4" }
     * NOTE: move validation is intentionally minimal for the PoC.
     * The goal is to validate the framework, not implement a chess engine.
     */
    move: (player: Player, payload: { from: string; to: string }) => {
      if (this.state.status !== "playing") return;
      if (this.state.turn !== player.data.color) {
        player.send(ChessEvent.INVALID_MOVE, { reason: "not your turn" });
        return;
      }
      if (!payload?.from || !payload?.to) {
        player.send(ChessEvent.INVALID_MOVE, { reason: "missing from/to" });
        return;
      }

      // TODO: validate the move against the board state (chess engine)
      // For the PoC we trust the client and just record the move

      // Apply move to FEN (simplified — just toggle turn for now)
      this.state.turn = this.state.turn === "white" ? "black" : "white";

      // broadcastState is called automatically by the framework after actions
      // (stateFor used per-player, but chess has no hidden state)
    },

    resign: (player: Player, _payload: unknown) => {
      if (this.state.status !== "playing") return;

      const winner = player.data.color === "white" ? "black" : "white";
      this.state.status = "finished";
      this.state.winner = winner;
      this.broadcast(GameEvent.GAME_OVER, { winner, reason: "resign" });
    },

    offerDraw: (player: Player, _payload: unknown) => {
      if (this.state.status !== "playing") return;
      // Broadcast the draw offer to the opponent
      this.broadcastExcept(player.id, GameEvent.CHAT, {
        system: true,
        text: `${player.data.color} offered a draw`,
      });
    },

    acceptDraw: (_player: Player, _payload: unknown) => {
      if (this.state.status !== "playing") return;
      this.state.status = "finished";
      this.state.winner = "draw";
      this.broadcast(GameEvent.GAME_OVER, { winner: "draw", reason: "agreement" });
    },
  };
}
