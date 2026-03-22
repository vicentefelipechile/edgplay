import type { Player, DefaultIdentity, DefaultData } from "./Player.js";
import type { D1Adapter } from "./persistence/D1Adapter.js";
import { encode } from "./protocol/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodSchema = { safeParse: (data: unknown) => { success: boolean; error?: any; data?: any } };

interface IdentitySchemas {
  public?:  ZodSchema;
  private?: ZodSchema;
}

/**
 * Concrete Player implementation — wraps a WebSocket.
 *
 * The generic TIdentity flows from GameRoomDO → PlayerImpl so the
 * player object the developer receives in onJoin/actions is fully typed.
 */
export class PlayerImpl<
  TIdentity extends DefaultIdentity     = DefaultIdentity,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TData     extends Record<string, any> = DefaultData
> implements Player<TIdentity, TData>
{
  readonly id: string;

  identity: TIdentity = { public: {}, private: {} } as unknown as TIdentity;

  data: TData = {} as TData;

  /** Stable ID used as D1 row key — set during identify() */
  persistentId: string | null = null;

  rejected      = false;
  rejectReason  = "";

  constructor(
    id: string,
    private readonly ws: WebSocket,
    private readonly adapter: D1Adapter | null = null,
    private readonly schemas: IdentitySchemas  = {}
  ) {
    this.id = id;
  }

  // ─── Send ──────────────────────────────────────────────────────────────────

  sendRaw(buffer: ArrayBuffer): void {
    try {
      if (this.ws.readyState === 1) this.ws.send(buffer);
    } catch { /* already closed */ }
  }

  send(type: number, payload?: unknown): void {
    this.sendRaw(encode(type, payload ?? null));
  }

  // ─── Identity ─────────────────────────────────────────────────────────────

  async identify(input: Partial<TIdentity> & { id?: string }): Promise<void> {
    const persistentId  = input.id ?? this.id;
    this.persistentId   = persistentId;

    // 1. Load existing data from D1
    let stored: DefaultIdentity | null = null;
    if (this.adapter) {
      const raw = await this.adapter.loadPlayer(persistentId);
      if (raw) stored = raw as unknown as DefaultIdentity;
    }

    // 2. Merge: stored as defaults, developer-provided as override
    const merged: DefaultIdentity = {
      public:  { ...(stored?.public  ?? {}), ...(input.public  ?? {}) },
      private: { ...(stored?.private ?? {}), ...(input.private ?? {}) },
    };

    // 3. Validate with Zod if schemas provided
    if (this.schemas.public) {
      const result = this.schemas.public.safeParse(merged.public);
      if (!result.success) {
        this.reject(`Identity validation failed (public): ${result.error?.message ?? "invalid data"}`);
        return;
      }
      merged.public = result.data;
    }

    if (this.schemas.private) {
      const result = this.schemas.private.safeParse(merged.private);
      if (!result.success) {
        this.reject(`Identity validation failed (private): ${result.error?.message ?? "invalid data"}`);
        return;
      }
      merged.private = result.data;
    }

    this.identity = merged as unknown as TIdentity;
  }

  reject(reason: string): void {
    this.rejected     = true;
    this.rejectReason = reason;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  async save(): Promise<void> {
    if (!this.adapter) return;
    // Temporarily swap id to persistentId for the D1 row key
    const sessionId = this.id;
    (this as unknown as { id: string }).id = this.persistentId ?? sessionId;
    await this.adapter.savePlayer(this as unknown as Player<DefaultIdentity>);
    (this as unknown as { id: string }).id = sessionId;
  }

  close(code = 1000, reason = ""): void {
    try { this.ws.close(code, reason); } catch { /* already closed */ }
  }
}
