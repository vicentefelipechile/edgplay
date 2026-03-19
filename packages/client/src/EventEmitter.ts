type Listener<T> = (data: T) => void;

/**
 * Minimal typed event emitter.
 * Used internally by RoomConnection and LobbyConnection.
 */
export class EventEmitter<TEvents extends Record<string, unknown>> {
  private _listeners = new Map<keyof TEvents, Set<Listener<unknown>>>();

  on<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): this {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event)!.add(listener as Listener<unknown>);
    return this;
  }

  off<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): this {
    this._listeners.get(event)?.delete(listener as Listener<unknown>);
    return this;
  }

  once<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): this {
    const wrapper = (data: unknown) => {
      this.off(event, wrapper as Listener<TEvents[K]>);
      (listener as Listener<unknown>)(data);
    };
    return this.on(event, wrapper as Listener<TEvents[K]>);
  }

  emit<K extends keyof TEvents>(event: K, data: TEvents[K]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const listener of set) listener(data);
  }

  removeAllListeners(): void {
    this._listeners.clear();
  }
}
