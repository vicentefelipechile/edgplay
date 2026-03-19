/**
 * Binary message protocol
 *
 * Frame layout:
 *   Byte 0:    Message type  (uint8)
 *   Byte 1:    Flags         (uint8)  — reserved, e.g. compression hint
 *   Byte 2-3:  Payload size  (uint16, big-endian)
 *   Byte 4+:   Payload       (JSON-encoded UTF-8 or raw binary)
 *   Byte N:    CRC-8         (uint8)  — covers all previous bytes
 *
 * Total overhead: 5 bytes per message (4 header + 1 CRC).
 */

const HEADER_SIZE = 4;
const CRC_SIZE = 1;

// CRC-8 (Dallas/Maxim polynomial 0x07)
export function crc8(data: Uint8Array): number {
  let crc = 0x00;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? (crc << 1) ^ 0x07 : crc << 1;
      crc &= 0xff;
    }
  }
  return crc;
}

export interface MessageHeader {
  type: number;   // GameEvent or developer-defined (0x50–0xFF)
  flags: number;  // reserved
}

/**
 * Encode a message into a binary ArrayBuffer.
 * @param type  GameEvent byte value
 * @param payload  Any JSON-serializable value, or null for no payload
 * @param flags  Reserved flags byte (default 0)
 */
export function encode(type: number, payload: unknown, flags = 0): ArrayBuffer {
  const payloadBytes =
    payload !== null && payload !== undefined
      ? new TextEncoder().encode(JSON.stringify(payload))
      : new Uint8Array(0);

  const totalSize = HEADER_SIZE + payloadBytes.byteLength + CRC_SIZE;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, type);
  view.setUint8(1, flags);
  view.setUint16(2, payloadBytes.byteLength, false); // big-endian

  bytes.set(payloadBytes, HEADER_SIZE);

  // CRC covers everything except the CRC byte itself
  const crc = crc8(bytes.subarray(0, HEADER_SIZE + payloadBytes.byteLength));
  view.setUint8(HEADER_SIZE + payloadBytes.byteLength, crc);

  return buffer;
}

export interface DecodedMessage {
  type: number;
  flags: number;
  payload: unknown;  // parsed JSON, or null if no payload
}

/**
 * Decode a binary ArrayBuffer into a message.
 * Returns null if the frame is malformed or the CRC check fails.
 */
export function decode(buffer: ArrayBuffer): DecodedMessage | null {
  const bytes = new Uint8Array(buffer);

  // Minimum valid frame: 4 header + 1 CRC (zero-length payload)
  if (bytes.byteLength < HEADER_SIZE + CRC_SIZE) return null;

  const view = new DataView(buffer);
  const type = view.getUint8(0);
  const flags = view.getUint8(1);
  const payloadSize = view.getUint16(2, false); // big-endian

  const expectedTotal = HEADER_SIZE + payloadSize + CRC_SIZE;
  if (bytes.byteLength !== expectedTotal) return null;

  // CRC check — covers all bytes except the CRC byte itself
  const receivedCrc = view.getUint8(HEADER_SIZE + payloadSize);
  const computedCrc = crc8(bytes.subarray(0, HEADER_SIZE + payloadSize));
  if (receivedCrc !== computedCrc) return null;

  let payload: unknown = null;
  if (payloadSize > 0) {
    try {
      const text = new TextDecoder().decode(
        bytes.subarray(HEADER_SIZE, HEADER_SIZE + payloadSize)
      );
      payload = JSON.parse(text);
    } catch {
      return null; // malformed JSON — discard
    }
  }

  return { type, flags, payload };
}
