import type { Player, PlayerIdentity } from "./Player.js";
import { encode } from "./protocol/index.js";

/**
 * Concrete Player implementation.
 * Wraps a WebSocket connection and exposes the Player interface
 * used by GameRoom lifecycle hooks and actions.
 */
export class PlayerImpl implements Player {
  readonly id: string;

  identity: PlayerIdentity = {
    public: {},
    private: {},
  };

  data: Record<string, unknown> = {};

  /** Whether player.reject() has been called — prevents room entry */
  rejected = false;

  /** Reason passed to reject(), forwarded to the client */
  rejectReason = "";

  constructor(
    id: string,
    private readonly ws: WebSocket,
    private readonly persistFn: (player: Player) => Promise<void> = async () => {}
  ) {
    this.id = id;
  }

  sendRaw(buffer: ArrayBuffer): void {
    try {
      // readyState 1 = OPEN
      if (this.ws.readyState === 1) {
        this.ws.send(buffer);
      }
    } catch {
      // WebSocket already closed — swallow silently
    }
  }

  send(type: number, payload?: unknown): void {
    this.sendRaw(encode(type, payload ?? null));
  }

  identify(identity: PlayerIdentity): void {
    this.identity = identity;
  }

  reject(reason: string): void {
    this.rejected = true;
    this.rejectReason = reason;
  }

  async save(): Promise<void> {
    await this.persistFn(this);
  }

  /** Close the underlying WebSocket with an optional reason */
  close(code = 1000, reason = ""): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}
