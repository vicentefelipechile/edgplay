import { createClient, RoomEvent, DisconnectReason } from "../../packages/client/src/index.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;

function log(msg: string, cls = "log-sys") {
  const el = $("log");
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function setConnected(yes: boolean) {
  ($("btnJoin")   as HTMLButtonElement).disabled = yes;
  ($("btnCreate") as HTMLButtonElement).disabled = yes;
  ($("btnLeave")  as HTMLButtonElement).disabled = !yes;
  ($("btnMove")   as HTMLButtonElement).disabled = !yes;
  ($("btnResign") as HTMLButtonElement).disabled = !yes;
}

function renderState(state: Record<string, unknown>) {
  $("board").textContent  = (state.board as string) ?? "—";
  $("status").textContent =
    `status: ${state.status} | turn: ${state.turn} | winner: ${state.winner ?? "—"}`;
}

// ── state ─────────────────────────────────────────────────────────────────────

let room: ReturnType<ReturnType<ReturnType<typeof createClient>["game"]>["join"]> | null = null;

function attachRoom(r: typeof room) {
  room = r;
  setConnected(true);
  log("Connected to room", "log-in");

  room!.on(RoomEvent.STATE_CHANGE, (s) => {
    renderState(s as Record<string, unknown>);
    log(`STATE: ${JSON.stringify(s)}`, "log-in");
  });
  room!.on(RoomEvent.PLAYER_JOIN,  (p) => log(`PLAYER_JOIN: ${JSON.stringify(p)}`, "log-in"));
  room!.on(RoomEvent.PLAYER_LEAVE, (p) => log(`PLAYER_LEAVE: ${JSON.stringify(p)}`, "log-sys"));
  room!.on(RoomEvent.GAME_START,   ()  => log("GAME_START 🎮", "log-in"));
  room!.on(RoomEvent.GAME_OVER,    (d) => log(`GAME_OVER: ${JSON.stringify(d)}`, "log-in"));
  room!.on(RoomEvent.CHAT,         (m: unknown) => log(`CHAT: ${(m as { text: string }).text}`, "log-sys"));

  room!.on(RoomEvent.RECONNECTING, ({ attempt, maxAttempts }) =>
    log(`Reconnecting… (${attempt}/${maxAttempts})`, "log-err"));
  room!.on(RoomEvent.RECONNECTED,  ()  => log("Reconnected ✓", "log-in"));
  room!.on(RoomEvent.RECONNECT_FAILED, () => {
    log("Reconnect failed", "log-err");
    setConnected(false);
  });
  room!.on(RoomEvent.DISCONNECTED, (reason) => {
    log(`Disconnected: ${reason}`, "log-err");
    $("status").textContent = `Disconnected (${reason as DisconnectReason})`;
    setConnected(false);
    room = null;
  });
}

// ── event listeners ───────────────────────────────────────────────────────────

$("btnJoin").addEventListener("click", () => {
  const workerUrl = ($("url")    as HTMLInputElement).value.trim();
  const roomId    = ($("roomId") as HTMLInputElement).value.trim();
  if (!roomId) return log("Enter a room ID", "log-err");

  log(`Joining ${workerUrl}/room/chess/${roomId}…`);
  attachRoom(createClient(workerUrl).game("chess").join(roomId));
});

$("btnCreate").addEventListener("click", async () => {
  const workerUrl = ($("url") as HTMLInputElement).value.trim();
  log(`Creating new room at ${workerUrl}…`);
  try {
    const r = await createClient(workerUrl).game("chess").create();
    // Show the generated roomId in the input so the second player can copy it
    const roomId = r.url?.split("/").pop() ?? "?";
    ($("roomId") as HTMLInputElement).value = roomId;
    log(`Room created! ID: ${roomId} — share this with the other player`, "log-in");
    attachRoom(r);
  } catch (e) {
    log(`Create failed: ${(e as Error).message}`, "log-err");
  }
});

$("btnLeave").addEventListener("click", () => {
  room?.leave();
});

$("btnMove").addEventListener("click", () => {
  const from = ($("from") as HTMLInputElement).value.trim();
  const to   = ($("to")   as HTMLInputElement).value.trim();
  if (!from || !to) return log("Fill in from/to", "log-err");
  log(`→ move ${from}→${to}`, "log-out");
  room?.send("move", { from, to });
});

$("btnResign").addEventListener("click", () => {
  log("→ resign", "log-out");
  room?.send("resign");
});
