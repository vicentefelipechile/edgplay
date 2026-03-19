import { vi } from "vitest";
import { encode } from "edgplay";
import { GameEvent } from "edgplay";

// ─── Mock WebSocket ───────────────────────────────────────────────────────────
// Interceptable WebSocket that lets tests push frames into the client
// without a real network.

export class MockWebSocket extends EventTarget {
  static OPEN    = 1;
  static CLOSING = 2;
  static CLOSED  = 3;

  readyState = MockWebSocket.OPEN;
  binaryType = "arraybuffer";

  sent: Array<ArrayBuffer | string> = [];
  url: string;

  // The test injects frames by calling this
  _trigger(type: string, data?: unknown) {
    if (type === "message") {
      this.dispatchEvent(Object.assign(new Event("message"), { data }));
    } else if (type === "close") {
      const ev = Object.assign(new Event("close"), { code: (data as number) ?? 1000, reason: "" });
      this.readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(ev);
    } else if (type === "error") {
      this.dispatchEvent(new Event("error"));
    } else if (type === "open") {
      this.dispatchEvent(new Event("open"));
    }
  }

  send(data: ArrayBuffer | string) { this.sent.push(data); }
  close(code = 1000, _reason = "") { this._trigger("close", code); }

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket._instances.push(this);
  }

  static _instances: MockWebSocket[] = [];
  static _reset() { MockWebSocket._instances = []; }

  /** Latest created instance */
  static get latest(): MockWebSocket {
    return MockWebSocket._instances[MockWebSocket._instances.length - 1];
  }
}

// Install globally
// @ts-ignore
globalThis.WebSocket = MockWebSocket;

// ─── Mock fetch ───────────────────────────────────────────────────────────────

globalThis.fetch = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ roomId: "created-room" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
);

// ─── Helpers re-exported for tests ───────────────────────────────────────────

/** Push a binary frame into the latest mock WebSocket */
export function pushFrame(type: number, payload: unknown, ws = MockWebSocket.latest) {
  ws._trigger("message", encode(type, payload));
}

/** Push a corrupted frame (CRC flipped) */
export function pushBadFrame(ws = MockWebSocket.latest) {
  const buf = new Uint8Array(encode(GameEvent.PING, null));
  buf[buf.length - 1] ^= 0xff;
  ws._trigger("message", buf.buffer);
}

/** Simulate the server closing the connection */
export function serverClose(code = 1001, ws = MockWebSocket.latest) {
  ws._trigger("close", code);
}
