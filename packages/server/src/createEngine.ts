import type { GameRoom as GameRoomBase } from "./GameRoom.js";
import type { Player } from "./Player.js";
import type { RateLimitsConfig } from "./GameRoom.js";
import { GameRoomDO } from "./GameRoomDO.js";
import { LobbyDO } from "./LobbyDO.js";
import { D1Adapter } from "./persistence/D1Adapter.js";
import { schemaToColumns } from "./persistence/schema.js";
import type { ColumnDef } from "./persistence/schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConnectMiddleware = (player: Player<any>, req: Request) => void | Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GameRoomClass = new () => GameRoomBase<any, any, any>;

interface EngineOptions {
  reconnectWindowMs?: number;
}

/**
 * The required env bindings for Edgplay.
 * These names must match class_name / binding values in wrangler.jsonc.
 *
 * D1 is NOT included here — the developer passes their own D1 binding
 * explicitly via withDatabase(env.MY_DB), choosing any binding name they want.
 */
export interface EdgplayEnv {
  /** Durable Object namespace for game rooms */
  GAME_ROOM: DurableObjectNamespace;
  /** Durable Object namespace for lobby coordination */
  LOBBY: DurableObjectNamespace;
  /** KV namespace for lobby snapshot cache (optional) */
  LOBBY_CACHE?: KVNamespace;
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Upgrade, Connection",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function corsPreFlight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ─── Routing helpers ──────────────────────────────────────────────────────────

/**
 * Forward an incoming Request to a Durable Object identified by name.
 * The DO name is derived from the game + room identifiers so each
 * room gets its own isolated DO instance.
 */
function forwardToDO(
  namespace: DurableObjectNamespace,
  name: string,
  req: Request
): Promise<Response> {
  const id = namespace.idFromName(name);
  const stub = namespace.get(id);
  return stub.fetch(req);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ─── EngineBuilder ────────────────────────────────────────────────────────────

/**
 * The engine builder — collects configuration via a fluent API and
 * produces the Worker fetch handler + static DO exports.
 *
 * @example
 * const engine = createEngine()
 *   .register("chess", ChessRoom)
 *   .register("poker", PokerRoom)
 *   .onConnect((player) => {
 *     if (!player.token) return player.reject("unauthorized");
 *   });
 *
 * export default engine.worker;
 * export const { GameRoom, LobbyDO } = engine.durableObjects;
 */
class EngineBuilder {
  private _rooms = new Map<string, GameRoomClass>();
  private _connectMiddleware: ConnectMiddleware | null = null;
  private _rateLimits: RateLimitsConfig | null = null;
  private _cfRateLimit: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getBinding: (env: any) => { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
    key: (req: Request) => string;
    onViolation?: "drop" | "reject";
  } | null = null;
  private _db: D1Database | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _dbFromEnv: ((env: any) => D1Database) | null = null;
  private _identitySchema: unknown = null;
  private _columns: ColumnDef[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _zodSchemas: { public?: any; private?: any } = {};
  private _options: EngineOptions = {};

  // ─── Registration ─────────────────────────────────────────────────────────

  register(name: string, Room: GameRoomClass): this {
    this._rooms.set(name, Room);
    return this;
  }

  // ─── Middleware ───────────────────────────────────────────────────────────

  onConnect(fn: ConnectMiddleware): this {
    this._connectMiddleware = fn;
    return this;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /**
   * Configure D1 persistence. Pass a function that selects the binding from env:
   *
   * @example
   * createEngine().withDatabase(env => env.CHESS_DB)
   *
   * This way the developer chooses the binding name — the framework never
   * assumes a fixed name like "DB".
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withDatabase(selector: (env: any) => D1Database): this {
    this._dbFromEnv = selector;
    return this;
  }

  defineIdentity(schema: unknown): this {
    this._identitySchema = schema;
    // Compute SQL columns for the CLI
    try {
      this._columns = schemaToColumns(schema as { public: unknown; private: unknown });
    } catch {
      this._columns = [];
    }
    // Extract Zod schemas for runtime validation in PlayerImpl
    // A Zod schema has a _def property — plain string objects don't
    const s = schema as { public?: unknown; private?: unknown };
    if (s?.public  && typeof s.public  === "object" && "_def" in (s.public  as object))
      this._zodSchemas.public  = s.public;
    if (s?.private && typeof s.private === "object" && "_def" in (s.private as object))
      this._zodSchemas.private = s.private;
    return this;
  }

  // ─── Rate limiting ────────────────────────────────────────────────────────

  withRateLimits(config: RateLimitsConfig): this {
    this._rateLimits = config;
    return this;
  }

  /**
   * Enable Cloudflare's native rate limiting binding (Layer 1 — connection level).
   * Runs in the Worker before the request reaches the DO.
   *
   * @param getBinding  Function that selects the rate limit binding from env
   * @param key         Function that derives the rate limit key from the request
   *                    (default: client IP via CF-Connecting-IP header)
   *
   * @example
   * createEngine()
   *   .withCloudflareRateLimit(
   *     env => env.RATE_LIMITER,
   *     req => req.headers.get("CF-Connecting-IP") ?? "unknown"
   *   )
   */
  withCloudflareRateLimit(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getBinding: (env: any) => { limit: (opts: { key: string }) => Promise<{ success: boolean }> },
    key: (req: Request) => string = (req) => req.headers.get("CF-Connecting-IP") ?? "unknown"
  ): this {
    this._cfRateLimit = { getBinding, key };
    return this;
  }

  // ─── Options ──────────────────────────────────────────────────────────────

  withOptions(options: EngineOptions): this {
    this._options = { ...this._options, ...options };
    return this;
  }

  // ─── Worker fetch handler ─────────────────────────────────────────────────

  /**
   * The Worker default export.
   * Handles all routing — WebSocket upgrades, lobby reads, room creation.
   *
   * Routes:
   *   WS  /room/:game/:roomId   → GameRoom DO  (game session)
   *   WS  /lobby/:game          → LobbyDO      (live room list)
   *   GET /lobby/:game          → KV snapshot  (initial room list, HTTP)
   *   POST /room/:game          → create room  (returns roomId)
   *   GET /profile/:playerId    → player profile (from D1, if configured)
   *   GET /                     → health check
   */
  get worker(): ExportedHandler<EdgplayEnv> {
    const rooms      = this._rooms;
    const connectMiddleware = this._connectMiddleware;
    const columns    = this._columns;
    const dbFromEnv  = this._dbFromEnv;
    const cfRateLimit = this._cfRateLimit;

    return {
      async fetch(req: Request, env: EdgplayEnv, _ctx: ExecutionContext): Promise<Response> {
        // ── CORS preflight ──────────────────────────────────────────────────
        if (req.method === "OPTIONS") return corsPreFlight();

        // ── Cloudflare Rate Limit (Layer 1 — connection level) ───────────────
        if (cfRateLimit) {
          const binding = cfRateLimit.getBinding(env);
          const key     = cfRateLimit.key(req);
          const result  = await binding.limit({ key });
          if (!result.success) {
            return withCors(err("Too many requests", 429));
          }
        }

        // Resolve D1 binding from env using the developer's selector
        const db = dbFromEnv ? dbFromEnv(env) : null;

        const url = new URL(req.url);
        const segments = url.pathname.replace(/^\//, "").split("/");
        const [route, param1, param2] = segments;

        // ── Health check ────────────────────────────────────────────────────
        if (!route || route === "") {
          return withCors(json({ ok: true, games: [...rooms.keys()] }));
        }

        // ── /room/:game/:roomId — WebSocket upgrade to GameRoom DO ──────────
        if (route === "room" && param1 && param2) {
          if (!rooms.has(param1)) {
            return withCors(err(`Unknown game: "${param1}"`, 404));
          }

          // WebSocket upgrades don't need CORS — they use the WS handshake
          if (req.headers.get("Upgrade") !== "websocket") {
            return withCors(err("Expected WebSocket upgrade", 426));
          }

          void connectMiddleware;
          return forwardToDO(env.GAME_ROOM, `${param1}:${param2}`, req);
        }

        // ── POST /room/:game — create a new room, return roomId ─────────────
        if (route === "room" && param1 && !param2 && req.method === "POST") {
          if (!rooms.has(param1)) {
            return withCors(err(`Unknown game: "${param1}"`, 404));
          }

          const roomId = crypto.randomUUID().slice(0, 8);

          try {
            const id = env.GAME_ROOM.idFromName(`${param1}:${roomId}`);
            const stub = env.GAME_ROOM.get(id);
            await stub.fetch(new Request(
              `${url.origin}/init?game=${param1}&room=${roomId}`,
              { method: "POST" }
            ));
          } catch {
            // non-fatal — room still works
          }

          return withCors(json({ roomId }));
        }

        // ── /lobby/:game — WebSocket upgrade to LobbyDO ─────────────────────
        if (route === "lobby" && param1) {
          if (!rooms.has(param1)) {
            return withCors(err(`Unknown game: "${param1}"`, 404));
          }

          if (req.headers.get("Upgrade") === "websocket") {
            return forwardToDO(env.LOBBY, `lobby:${param1}`, req);
          }

          if (req.method === "GET") {
            if (env.LOBBY_CACHE) {
              const cached = await env.LOBBY_CACHE.get(`lobby:${param1}`, "json");
              if (cached) return withCors(json(cached));
            }
            return forwardToDO(env.LOBBY, `lobby:${param1}`,
              new Request(`${url.origin}/list`));
          }
        }

        // ── GET /profile/:playerId ───────────────────────────────────────────
        if (route === "profile" && param1 && req.method === "GET") {
          if (!db) {
            return withCors(err("Profile endpoint requires D1 — call withDatabase(env.YOUR_DB) in createEngine()", 404));
          }

          const adapter = new D1Adapter(db, columns);
          const profile = await adapter.getPublicProfile(param1);

          if (!profile) {
            return withCors(err(`Player '${param1}' not found`, 404));
          }

          return withCors(json(profile));
        }

        return withCors(err("Not found", 404));
      },
    };
  }

  // ─── Durable Object exports ───────────────────────────────────────────────

  /**
   * Static DO class exports required by Cloudflare.
   * Names must match class_name values in wrangler.jsonc.
   *
   * When multiple games are registered, all of their rooms share the same
   * GAME_ROOM DO namespace — the game name is encoded in the DO instance name
   * (e.g. "chess:sala-123"), so each room is still fully isolated.
   *
   * The developer re-exports these from their index.ts:
   *   export const { GameRoom, LobbyDO } = engine.durableObjects;
   */
  get durableObjects() {
    const firstRoom   = [...this._rooms.values()][0];
    const columns     = this._columns;
    const dbFromEnv   = this._dbFromEnv;
    const middleware  = this._connectMiddleware;
    const schemas     = this._zodSchemas;
    const rateLimits  = this._rateLimits ?? undefined;

    const makeAdapter = (env: EdgplayEnv): D1Adapter | null => {
      const db = dbFromEnv ? dbFromEnv(env) : null;
      return db ? new D1Adapter(db, columns) : null;
    };

    const GameRoom = firstRoom
      ? GameRoomDO.for(firstRoom, makeAdapter, middleware, schemas, rateLimits)
      : GameRoomDO;

    return { GameRoom, LobbyDO };
  }
}

export function createEngine(): EngineBuilder {
  return new EngineBuilder();
}
