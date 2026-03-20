import type { GameRoom as GameRoomBase } from "./GameRoom.js";
import type { Player } from "./Player.js";
import type { RateLimitsConfig } from "./GameRoom.js";
import { GameRoomDO } from "./GameRoomDO.js";
import { LobbyDO } from "./LobbyDO.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GameRoomClass<TState extends object = any> = new () => GameRoomBase<TState>;

type ConnectMiddleware = (player: Player, req: Request) => void | Promise<void>;

interface EngineOptions {
  reconnectWindowMs?: number;
}

/**
 * The fixed env bindings contract.
 * These names must match class_name / binding values in wrangler.jsonc.
 */
export interface EdgplayEnv {
  /** Durable Object namespace for game rooms */
  GAME_ROOM: DurableObjectNamespace;
  /** Durable Object namespace for lobby coordination */
  LOBBY: DurableObjectNamespace;
  /** KV namespace for lobby snapshot cache (optional) */
  LOBBY_CACHE?: KVNamespace;
  /** D1 database for player persistence (optional) */
  DB?: D1Database;
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
  private _cfRateLimit: { binding: unknown; config: unknown } | null = null;
  private _db: unknown = null;
  private _identitySchema: unknown = null;
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

  withDatabase(db: unknown): this {
    this._db = db;
    return this;
  }

  defineIdentity(schema: unknown): this {
    this._identitySchema = schema;
    return this;
  }

  // ─── Rate limiting ────────────────────────────────────────────────────────

  withRateLimits(config: RateLimitsConfig): this {
    this._rateLimits = config;
    return this;
  }

  withCloudflareRateLimit(binding: unknown, config: unknown): this {
    this._cfRateLimit = { binding, config };
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
    // Capture builder state for use inside the handler
    const rooms = this._rooms;
    const connectMiddleware = this._connectMiddleware;

    return {
      async fetch(req: Request, env: EdgplayEnv, _ctx: ExecutionContext): Promise<Response> {
        // ── CORS preflight ──────────────────────────────────────────────────
        if (req.method === "OPTIONS") return corsPreFlight();

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
          if (!env.DB) {
            return withCors(err("Profile endpoint requires D1 — withDatabase() not configured", 404));
          }
          return withCors(err("GET /profile/:playerId — TODO: query D1", 501));
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
    // If only one game is registered, bind that class directly.
    // If multiple games are registered, the DO needs to look up the class
    // from the instance name — that dispatch is handled inside GameRoomDO.
    // For the PoC, single-game binding is sufficient.
    const firstRoom = [...this._rooms.values()][0];

    const GameRoom = firstRoom
      ? GameRoomDO.for(firstRoom)
      : GameRoomDO; // fallback — returns 501 until a room is registered

    return { GameRoom, LobbyDO };
  }
}

export function createEngine(): EngineBuilder {
  return new EngineBuilder();
}
