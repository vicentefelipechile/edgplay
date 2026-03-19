/**
 * Vitest setup — polyfill Cloudflare Workers globals that don't exist in Node.
 */

// ─── WebSocketPair ────────────────────────────────────────────────────────────

class MockWebSocketHalf {
  readyState = 1;
  _other: MockWebSocketHalf | null = null;
  sent: ArrayBuffer[] = [];
  closed: { code: number; reason: string } | null = null;

  send(data: ArrayBuffer) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  deserializeAttachment() { return null; }
  serializeAttachment(_v: unknown) {}
}

class MockWebSocketPair {
  0: MockWebSocketHalf;
  1: MockWebSocketHalf;

  constructor() {
    const client = new MockWebSocketHalf();
    const server = new MockWebSocketHalf();
    client._other = server;
    server._other = client;
    this[0] = client;
    this[1] = server;
  }
}

// @ts-ignore
globalThis.WebSocketPair = MockWebSocketPair;

// ─── crypto.randomUUID ────────────────────────────────────────────────────────
// Node 19+ has this natively, but just in case:
if (!globalThis.crypto?.randomUUID) {
  const { webcrypto } = await import("node:crypto");
  // @ts-ignore
  globalThis.crypto = webcrypto;
}
