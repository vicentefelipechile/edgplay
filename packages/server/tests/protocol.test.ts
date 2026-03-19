import { describe, it, expect } from "vitest";
import { encode, decode, crc8 } from "../src/protocol/index.js";
import { GameEvent } from "../src/enums.js";

describe("crc8", () => {
  it("returns 0 for empty input", () => {
    expect(crc8(new Uint8Array([]))).toBe(0);
  });

  it("is deterministic", () => {
    const data = new Uint8Array([0x01, 0x00, 0x00, 0x03, 0x41, 0x42, 0x43]);
    expect(crc8(data)).toBe(crc8(data));
  });

  it("produces different values for different inputs", () => {
    const a = new Uint8Array([0x01, 0x02]);
    const b = new Uint8Array([0x02, 0x01]);
    expect(crc8(a)).not.toBe(crc8(b));
  });
});

describe("encode / decode round-trip", () => {
  it("round-trips a simple payload", () => {
    const payload = { from: "e2", to: "e4" };
    const buffer = encode(GameEvent.ACTION, payload);
    const msg = decode(buffer);

    expect(msg).not.toBeNull();
    expect(msg!.type).toBe(GameEvent.ACTION);
    expect(msg!.flags).toBe(0);
    expect(msg!.payload).toEqual(payload);
  });

  it("round-trips a null payload", () => {
    const buffer = encode(GameEvent.PING, null);
    const msg = decode(buffer);

    expect(msg).not.toBeNull();
    expect(msg!.type).toBe(GameEvent.PING);
    expect(msg!.payload).toBeNull();
  });

  it("round-trips nested objects", () => {
    const payload = { players: [{ id: "abc", color: "white" }], status: "playing" };
    const buffer = encode(GameEvent.STATE_FULL, payload);
    const msg = decode(buffer);

    expect(msg).not.toBeNull();
    expect(msg!.payload).toEqual(payload);
  });

  it("encodes flags correctly", () => {
    const buffer = encode(GameEvent.ACTION, null, 0x42);
    const msg = decode(buffer);
    expect(msg!.flags).toBe(0x42);
  });
});

describe("decode — malformed inputs", () => {
  it("returns null for a buffer that is too short", () => {
    expect(decode(new ArrayBuffer(3))).toBeNull();
  });

  it("returns null when payload size doesn't match buffer length", () => {
    const buffer = encode(GameEvent.ACTION, { x: 1 });
    // Truncate by 2 bytes
    const truncated = buffer.slice(0, buffer.byteLength - 2);
    expect(decode(truncated)).toBeNull();
  });

  it("returns null when CRC is corrupted", () => {
    const buffer = encode(GameEvent.ACTION, { x: 1 });
    const bytes = new Uint8Array(buffer);
    // Flip the last byte (CRC)
    bytes[bytes.length - 1] ^= 0xff;
    expect(decode(bytes.buffer)).toBeNull();
  });

  it("returns null when payload is not valid JSON", () => {
    // Manually build a frame with invalid JSON payload
    const payload = new TextEncoder().encode("{broken json");
    const total = 4 + payload.byteLength + 1;
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    view.setUint8(0, GameEvent.ACTION);
    view.setUint8(1, 0);
    view.setUint16(2, payload.byteLength, false);
    bytes.set(payload, 4);

    // Write correct CRC so it passes the CRC check and fails on JSON.parse
    const validCrc = crc8(bytes.subarray(0, 4 + payload.byteLength));
    view.setUint8(4 + payload.byteLength, validCrc);

    expect(decode(buf)).toBeNull();
  });
});

describe("frame size", () => {
  it("has 5 bytes overhead for empty payload", () => {
    const buffer = encode(GameEvent.PING, null);
    expect(buffer.byteLength).toBe(5); // 4 header + 0 payload + 1 CRC
  });

  it("total size = 5 + payload bytes", () => {
    const payload = { x: 1 };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    const buffer = encode(GameEvent.ACTION, payload);
    expect(buffer.byteLength).toBe(5 + payloadBytes);
  });
});
