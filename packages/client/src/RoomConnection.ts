import { EventEmitter } from "./EventEmitter.js";
import { encode, decode } from "edgplay";
import { GameEvent, RoomEvent, DisconnectReason } from "edgplay";

// ─── Types ────────────────────────────────────────────────────────────────────

type RoomEventMap = {
  [RoomEvent.STATE_CHANGE]:      unknown;
  [RoomEvent.STATE_PATCH]:       unknown;
  [RoomEvent.PLAYER_JOIN]:       { id: string; identity: Record<string, unknown> };
  [RoomEvent.PLAYER_LEAVE]:      { id: string; reason: string };
  [RoomEvent.COUNTDOWN]:         { seconds: number };
  [RoomEvent.GAME_START]:        null;
  [RoomEvent.GAME_OVER]:         { winner: unknown; reason: string };
  [RoomEvent.CHAT]:              { text: string; system?: boolean };
  [RoomEvent.EMOTE]:             { emote: string };
  [RoomEvent.RECONNECTING]:      { attempt: number; maxAttempts: number };
  [RoomEvent.RECONNECTED]:       null;
  [RoomEvent.RECONNECT_FAILED]:  null;
  [RoomEvent.DISCONNECTED]:      DisconnectReason;
};

export interface ReconnectOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

// ─── RoomConnection ───────────────────────────────────────────────────────────

export class RoomConnection extends EventEmitter<RoomEventMap> {
  private ws: WebSocket | null = null;

  private _reconnectAttempt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _intentionalClose = false;
  private _hasListeners = false;

  /**
   * Events that arrived before any listener was registered are buffered here
   * and flushed the moment the first .on() call happens.
   * This prevents losing STATE_FULL / GAME_START that arrive immediately on connect.
   */
  private _eventBuffer: Array<{ event: RoomEvent; data: unknown }> = [];

  private readonly _maxAttempts: number;
  private readonly _baseDelayMs: number;
  private readonly _maxDelayMs: number;

  constructor(
    public readonly url: string,
    reconnect: ReconnectOptions = {}
  ) {
    super();
    this._maxAttempts = reconnect.maxAttempts ?? 5;
    this._baseDelayMs = reconnect.baseDelayMs ?? 1000;
    this._maxDelayMs  = reconnect.maxDelayMs  ?? 30_000;
    this._connect();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Override on() to flush buffered events on first listener registration.
   * This ensures events that arrived before the caller attached listeners
   * are not silently dropped.
   */
  on<K extends keyof RoomEventMap>(
    event: K,
    listener: (data: RoomEventMap[K]) => void
  ): this {
    super.on(event, listener);

    if (!this._hasListeners) {
      this._hasListeners = true;
      // Flush buffered events in the next microtask so all .on() calls in the
      // same synchronous block have a chance to register before we emit
      Promise.resolve().then(() => this._flushBuffer());
    }

    return this;
  }

  send(action: string, payload?: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode(GameEvent.ACTION, { action, payload: payload ?? null }));
  }

  sendRaw(type: number, payload?: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode(type, payload ?? null));
  }

  leave(): void {
    this._intentionalClose = true;
    this._cancelReconnect();
    // Emit DISCONNECTED immediately — don't wait for the WS close event.
    // This guarantees the caller always gets the event regardless of network
    // conditions or server response time.
    this._safeEmit(RoomEvent.DISCONNECTED, DisconnectReason.LEFT);
    this.removeAllListeners();
    this.ws?.close(1000, "left");
  }

  // ─── WebSocket lifecycle ──────────────────────────────────────────────────

  private _connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("message", (ev) => this._onMessage(ev));
    ws.addEventListener("close",   (ev) => this._onClose(ev));
    ws.addEventListener("error",   ()   => { /* close fires right after */ });
  }

  private _onMessage(ev: MessageEvent): void {
    if (!(ev.data instanceof ArrayBuffer)) return;

    const msg = decode(ev.data);
    if (!msg) return;

    switch (msg.type) {
      case GameEvent.PING:
        this.ws?.send(encode(GameEvent.PONG, null));
        return;

      case GameEvent.PONG:
        return;

      case GameEvent.STATE_FULL:
        this._reconnectAttempt = 0;
        this._safeEmit(RoomEvent.STATE_CHANGE, msg.payload);
        return;

      case GameEvent.STATE_PATCH:
        this._safeEmit(RoomEvent.STATE_PATCH, msg.payload);
        return;

      case GameEvent.PLAYER_JOIN:
        this._safeEmit(RoomEvent.PLAYER_JOIN, msg.payload as RoomEventMap[RoomEvent.PLAYER_JOIN]);
        return;

      case GameEvent.PLAYER_LEAVE:
        this._safeEmit(RoomEvent.PLAYER_LEAVE, msg.payload as RoomEventMap[RoomEvent.PLAYER_LEAVE]);
        return;

      case GameEvent.COUNTDOWN:
        this._safeEmit(RoomEvent.COUNTDOWN, msg.payload as RoomEventMap[RoomEvent.COUNTDOWN]);
        return;

      case GameEvent.GAME_START:
        this._safeEmit(RoomEvent.GAME_START, null);
        return;

      case GameEvent.GAME_OVER:
        this._safeEmit(RoomEvent.GAME_OVER, msg.payload as RoomEventMap[RoomEvent.GAME_OVER]);
        return;

      case GameEvent.CHAT:
      case GameEvent.CHAT_PRIVATE:
        this._safeEmit(RoomEvent.CHAT, msg.payload as RoomEventMap[RoomEvent.CHAT]);
        return;

      case GameEvent.EMOTE:
        this._safeEmit(RoomEvent.EMOTE, msg.payload as RoomEventMap[RoomEvent.EMOTE]);
        return;

      case GameEvent.ROOM_ERROR:
        console.warn("[edgplay] ROOM_ERROR:", msg.payload);
        return;

      default:
        return;
    }
  }

  private _onClose(ev: CloseEvent): void {
    const reason = this._closeCodeToReason(ev.code);

    if (this._intentionalClose || !this._shouldReconnect(ev.code)) {
      this._safeEmit(RoomEvent.DISCONNECTED, reason);
      this.removeAllListeners();
      return;
    }

    this._scheduleReconnect();
  }

  // ─── Event buffering ──────────────────────────────────────────────────────

  /**
   * If listeners are already registered, emit immediately.
   * Otherwise buffer the event until the first .on() call.
   */
  private _safeEmit<K extends RoomEvent>(event: K, data: RoomEventMap[K]): void {
    if (this._hasListeners) {
      this.emit(event, data);
    } else {
      this._eventBuffer.push({ event, data });
    }
  }

  private _flushBuffer(): void {
    const buf = this._eventBuffer.splice(0);
    for (const { event, data } of buf) {
      this.emit(event as RoomEvent, data as RoomEventMap[RoomEvent]);
    }
  }

  // ─── Reconnect logic ──────────────────────────────────────────────────────

  private _shouldReconnect(closeCode: number): boolean {
    const noReconnect = new Set([1000, 4000, 4001]);
    return !noReconnect.has(closeCode) && this._reconnectAttempt < this._maxAttempts;
  }

  private _scheduleReconnect(): void {
    this._reconnectAttempt++;

    const delay = Math.min(
      this._baseDelayMs * 2 ** (this._reconnectAttempt - 1),
      this._maxDelayMs
    );

    this._safeEmit(RoomEvent.RECONNECTING, {
      attempt: this._reconnectAttempt,
      maxAttempts: this._maxAttempts,
    });

    this._reconnectTimer = setTimeout(() => {
      if (this._reconnectAttempt > this._maxAttempts) {
        this._safeEmit(RoomEvent.RECONNECT_FAILED, null);
        this._safeEmit(RoomEvent.DISCONNECTED, DisconnectReason.LOST);
        this.removeAllListeners();
        return;
      }
      this._connect();
    }, delay);
  }

  private _cancelReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _closeCodeToReason(code: number): DisconnectReason {
    switch (code) {
      case 1000: return DisconnectReason.LEFT;
      case 1001: return DisconnectReason.LOST;
      case 4000: return DisconnectReason.KICKED;
      case 4001: return DisconnectReason.KICKED;
      case 4429: return DisconnectReason.RATE_LIMITED;
      default:   return code >= 4000
        ? DisconnectReason.SERVER_ERROR
        : DisconnectReason.LOST;
    }
  }
}
