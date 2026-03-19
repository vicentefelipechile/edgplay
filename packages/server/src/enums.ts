// ─── Binary protocol layer (travels in every WebSocket frame) ───────────────
export enum GameEvent {
  // State & lobby (0x01–0x0F)
  STATE_FULL    = 0x01,
  STATE_PATCH   = 0x02,
  PLAYER_JOIN   = 0x03,
  PLAYER_LEAVE  = 0x04,
  ROOM_ERROR    = 0x05,
  LOBBY_LIST    = 0x06,
  LOBBY_PATCH   = 0x07,

  // Actions & input (0x10–0x1F)
  ACTION        = 0x10,
  INPUT         = 0x11,
  PING          = 0x12,
  PONG          = 0x13,

  // Social (0x20–0x2F)
  CHAT          = 0x20,
  CHAT_PRIVATE  = 0x21,
  EMOTE         = 0x22,

  // Game lifecycle (0x30–0x3F)
  PLAYER_READY   = 0x30,
  PLAYER_UNREADY = 0x31,
  COUNTDOWN      = 0x32,
  GAME_START     = 0x33,
  GAME_OVER      = 0x34,

  // Room administration (0x40–0x4F)
  KICK           = 0x40,
  HOST_TRANSFER  = 0x41,

  // Developer-defined: 0x50–0xFF (176 values available)
}

// ─── Client SDK layer (events the developer listens to with room.on()) ───────
export enum RoomEvent {
  STATE_CHANGE     = "stateChange",
  STATE_PATCH      = "statePatch",
  PLAYER_JOIN      = "playerJoin",
  PLAYER_LEAVE     = "playerLeave",
  COUNTDOWN        = "countdown",
  GAME_START       = "gameStart",
  GAME_OVER        = "gameOver",
  CHAT             = "chat",
  EMOTE            = "emote",
  RECONNECTING     = "reconnecting",
  RECONNECTED      = "reconnected",
  RECONNECT_FAILED = "reconnectFailed",
  DISCONNECTED     = "disconnected",
}

// ─── Lobby SDK events (listened to with lobby.on()) ──────────────────────────
export enum LobbyEvent {
  ROOM_LIST    = "roomList",
  ROOM_ADDED   = "roomAdded",
  ROOM_UPDATED = "roomUpdated",
  ROOM_REMOVED = "roomRemoved",
}

// ─── Why a player's connection ended ─────────────────────────────────────────
export enum DisconnectReason {
  LEFT         = "left",
  TIMEOUT      = "timeout",
  LOST         = "lost",
  KICKED       = "kicked",
  ROOM_CLOSED  = "room_closed",
  SERVER_ERROR = "server_error",
  UNAUTHORIZED = "unauthorized",
  RATE_LIMITED = "rate_limited",
}

// ─── What to do when a rate limit is exceeded ────────────────────────────────
export enum RateLimitViolation {
  DROP = "drop",  // silently discard the message, keep player connected
  WARN = "warn",  // send ROOM_ERROR to the client, keep player connected
  KICK = "kick",  // disconnect with DisconnectReason.RATE_LIMITED
}
