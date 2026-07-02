// WS Leg-1 receiver — module-scope, single-flight socket manager (072j/072k).
//
// Folded NEARLY VERBATIM from the live-validated coordinator POC
// (tools/steamedclaw-coordinator-poc/ws-receiver.mjs). Owns the two RECEIVE-ONLY
// SteamedClaw sockets:
//   /ws/agent           — match discovery push ({type:'match_found', matchId, …})
//   /ws/game/:matchId   — turn push ({type:'your_turn'|'game_over'|…})
// Submit stays HTTP in Leg-1 (072i §10); this module never carries actions.
//
// Why module scope + single-flight (072i §11 finding 1): service.start() fires
// more than once per boot (full-mode re-registration), and the server's
// /ws/agent second-socket policy is "close older, newer wins" (app.ts:566).
// Per-instance sockets therefore flap-war: each instance's reconnect kills the
// other's socket. All socket state lives here, at module scope — a second
// startReceiver() reuses the live socket and only refreshes the callbacks.
//
// Stale-socket fencing: every close/error handler first checks that its socket
// is still the CURRENT module-scope socket; a superseded socket's close never
// schedules a reconnect.
//
// Server constraints honored (verified packages/server/src/app.ts):
//   - min 1s between /ws/agent upgrades per agent (app.ts:236) → backoff floor 2s
//   - missed /ws/agent events buffer 60s and replay on reconnect (app.ts:211)
//   - ANY client send on /ws/agent closes it → this module NEVER sends
//   - /ws/game re-delivers a pending your_turn on (re)connect (app.ts:3902) →
//     a game-socket reconnect cannot lose the current turn
//
// WS client = Node global WebSocket with {headers:{Authorization}} — verified
// in-runtime by the leg1 probe (072i §11 finding 3); no `ws` dependency.
// makeWebSocket is injectable for tests only.

const AGENT_BACKOFF_MIN_MS = 2000; //  > server's 1s min upgrade interval
const AGENT_BACKOFF_MAX_MS = 30000;
const GAME_RECONNECT_DELAY_MS = 2000;

function defaultMakeWebSocket(url, headers) {
  return new globalThis.WebSocket(url, { headers });
}

// ── Module-scope receiver state (single resolved module ⇒ shared across all
// register() instances, the same guarantee coordinator.mjs relies on). ────────
const RECEIVER = {
  generation: 0, //  bumped per startReceiver(); fences stale sockets/timers
  cfg: null, //  { server, apiKey, makeWebSocket, logger }
  callbacks: null, //  { onMatchFound, onYourTurn, onGameOver }
  stopped: true, //  explicit stop — suppresses all reconnects
  agent: null, //  { sock, gen, ready }   ready = 'connected' frame seen
  agentBackoffMs: AGENT_BACKOFF_MIN_MS,
  agentReconnectTimer: null,
  game: null, //  { matchId, sock, gen, ready, terminal }
  gameReconnectTimer: null,
  gameReconnectMatchId: null, //  which match the pending reconnect is for (fence)
  terminalGames: new Set(), //  finished matches — openGame/reconnect refuse these
};

export function __resetReceiver() {
  stopReceiver();
  RECEIVER.generation = 0;
  RECEIVER.cfg = null;
  RECEIVER.callbacks = null;
  RECEIVER.agentBackoffMs = AGENT_BACKOFF_MIN_MS;
  RECEIVER.gameReconnectMatchId = null;
  RECEIVER.terminalGames.clear();
}

function log(level, msg) {
  RECEIVER.cfg?.logger?.[level]?.(msg);
}

function wsBase(server) {
  return String(server).replace(/^http/, 'ws').replace(/\/+$/, '');
}

function safeClose(sock) {
  try {
    sock?.close?.();
  } catch {
    /* already closed/failed — nothing to do */
  }
}

function parseFrame(ev) {
  const raw = ev?.data ?? ev;
  try {
    return JSON.parse(typeof raw === 'string' ? raw : (raw?.toString?.() ?? ''));
  } catch {
    return null;
  }
}

// ── /ws/agent — discovery socket ─────────────────────────────────────────────

function connectAgentSocket() {
  if (RECEIVER.stopped || !RECEIVER.cfg) return;
  const existing = RECEIVER.agent;
  if (existing?.sock && existing.gen === RECEIVER.generation) return; //  single-flight
  const { server, apiKey, makeWebSocket } = RECEIVER.cfg;
  const url = `${wsBase(server)}/ws/agent`;
  let sock;
  try {
    sock = makeWebSocket(url, { Authorization: `Bearer ${apiKey}` });
  } catch (err) {
    log('warn', `[ws] agent socket construct failed: ${err?.message ?? err}`);
    scheduleAgentReconnect();
    return;
  }
  const entry = { sock, gen: RECEIVER.generation, ready: false };
  RECEIVER.agent = entry;
  const isCurrent = () => RECEIVER.agent === entry && !RECEIVER.stopped;

  sock.addEventListener('message', (ev) => {
    if (!isCurrent()) return;
    const frame = parseFrame(ev);
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'connected') {
      entry.ready = true;
      RECEIVER.agentBackoffMs = AGENT_BACKOFF_MIN_MS; //  healthy — reset backoff
      log('info', '[ws] /ws/agent connected');
    } else if (frame.type === 'match_found') {
      log('info', `[ws] match_found matchId=${frame.matchId}`);
      RECEIVER.callbacks?.onMatchFound?.(frame);
    }
    //  NEVER reply — any client send closes /ws/agent (server contract).
  });
  sock.addEventListener('error', (ev) => {
    if (!isCurrent()) return;
    log('warn', `[ws] /ws/agent error: ${ev?.message ?? 'socket error'}`);
  });
  sock.addEventListener('close', (ev) => {
    if (!isCurrent()) return; //  stale-socket fencing — superseded close is inert
    entry.ready = false;
    RECEIVER.agent = null;
    log('info', `[ws] /ws/agent closed code=${ev?.code ?? '?'} — reconnect scheduled`);
    scheduleAgentReconnect();
  });
}

function scheduleAgentReconnect() {
  if (RECEIVER.stopped || RECEIVER.agentReconnectTimer) return;
  const delay = RECEIVER.agentBackoffMs;
  RECEIVER.agentBackoffMs = Math.min(RECEIVER.agentBackoffMs * 2, AGENT_BACKOFF_MAX_MS);
  const gen = RECEIVER.generation;
  RECEIVER.agentReconnectTimer = setTimeout(() => {
    RECEIVER.agentReconnectTimer = null;
    if (gen !== RECEIVER.generation) return; //  a newer start owns reconnects now
    connectAgentSocket();
  }, delay);
  RECEIVER.agentReconnectTimer.unref?.();
}

// ── /ws/game/:matchId — turn socket ──────────────────────────────────────────

export function openGame(matchId) {
  if (RECEIVER.stopped || !RECEIVER.cfg || !matchId) return;
  if (RECEIVER.terminalGames.has(matchId)) return; //  finished — never reopen
  const existing = RECEIVER.game;
  if (existing?.matchId === matchId && existing.sock && !existing.terminal) return; //  idempotent
  if (existing) closeGame(existing.matchId, { terminal: existing.terminal });
  const { server, apiKey, makeWebSocket } = RECEIVER.cfg;
  const url = `${wsBase(server)}/ws/game/${encodeURIComponent(matchId)}`;
  let sock;
  try {
    sock = makeWebSocket(url, { Authorization: `Bearer ${apiKey}` });
  } catch (err) {
    log('warn', `[ws] game socket construct failed: ${err?.message ?? err}`);
    scheduleGameReconnect(matchId);
    return;
  }
  const entry = { matchId, sock, gen: RECEIVER.generation, ready: false, terminal: false };
  RECEIVER.game = entry;
  const isCurrent = () => RECEIVER.game === entry && !RECEIVER.stopped;

  sock.addEventListener('message', (ev) => {
    if (!isCurrent()) return;
    const frame = parseFrame(ev);
    if (!frame || typeof frame !== 'object') return;
    switch (frame.type) {
      case 'connected':
        entry.ready = true;
        log('info', `[ws] /ws/game/${matchId} connected`);
        break;
      case 'your_turn':
        RECEIVER.callbacks?.onYourTurn?.(frame);
        break;
      case 'game_over':
        entry.terminal = true; //  set BEFORE the callback so close → no reconnect
        RECEIVER.terminalGames.add(matchId); //  and never reopen this match
        RECEIVER.callbacks?.onGameOver?.(frame);
        break;
      case 'error':
        log('warn', `[ws] /ws/game/${matchId} server error: ${frame.error ?? 'unknown'}`);
        break;
      default:
        break; //  'message' (in-game chat) — not used by the plugin
    }
  });
  sock.addEventListener('error', (ev) => {
    if (!isCurrent()) return;
    log('warn', `[ws] /ws/game/${matchId} error: ${ev?.message ?? 'socket error'}`);
  });
  sock.addEventListener('close', (ev) => {
    if (!isCurrent()) return; //  stale-socket fencing
    const wasTerminal = entry.terminal;
    RECEIVER.game = null;
    if (wasTerminal) return; //  game over — nothing to reconnect
    log('info', `[ws] /ws/game/${matchId} closed code=${ev?.code ?? '?'} — reconnect scheduled`);
    //  Server re-delivers a pending your_turn on reconnect (app.ts:3902), and the
    //  driver's HTTP fallback covers the gap meanwhile.
    scheduleGameReconnect(matchId);
  });
}

export function closeGame(matchId, { terminal = false } = {}) {
  if (!matchId) return;
  // Terminal marking + timer cancel must happen even when there is no LIVE
  // socket for the match: if the socket already dropped, its close handler has
  // scheduled a reconnect — without this, a game finishing while the socket is
  // down (exactly when the HTTP fallback detects game_over) leaves that timer
  // armed, and the receiver reconnect-storms a finished match forever.
  if (terminal) RECEIVER.terminalGames.add(matchId);
  if (RECEIVER.gameReconnectTimer && RECEIVER.gameReconnectMatchId === matchId) {
    clearTimeout(RECEIVER.gameReconnectTimer);
    RECEIVER.gameReconnectTimer = null;
    RECEIVER.gameReconnectMatchId = null;
  }
  const g = RECEIVER.game;
  if (!g || g.matchId !== matchId) return;
  if (terminal) g.terminal = true; //  suppress the close handler's reconnect
  RECEIVER.game = null; //  un-current FIRST so the close event is inert
  safeClose(g.sock);
}

function scheduleGameReconnect(matchId) {
  if (RECEIVER.stopped || RECEIVER.gameReconnectTimer) return;
  if (RECEIVER.terminalGames.has(matchId)) return; //  finished — never reopen
  const gen = RECEIVER.generation;
  RECEIVER.gameReconnectMatchId = matchId; //  match-fence the timer
  RECEIVER.gameReconnectTimer = setTimeout(() => {
    RECEIVER.gameReconnectTimer = null;
    RECEIVER.gameReconnectMatchId = null;
    if (gen !== RECEIVER.generation || RECEIVER.stopped) return;
    openGame(matchId);
  }, GAME_RECONNECT_DELAY_MS);
  RECEIVER.gameReconnectTimer.unref?.();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Start (or refresh) the receiver. SINGLE-FLIGHT: if an agent socket is already
// live, a repeat call only updates cfg/callbacks — it does NOT open a second
// socket (072i §11: service.start() fires more than once per boot; the server
// closes the older socket, so a second open here would flap-war).
export function startReceiver({
  server,
  apiKey,
  logger,
  makeWebSocket = defaultMakeWebSocket,
  onMatchFound,
  onYourTurn,
  onGameOver,
}) {
  RECEIVER.generation += 1;
  RECEIVER.cfg = { server, apiKey, makeWebSocket, logger };
  RECEIVER.callbacks = { onMatchFound, onYourTurn, onGameOver };
  RECEIVER.stopped = false;
  //  Adopt a live socket from the previous generation instead of replacing it.
  if (RECEIVER.agent?.sock) {
    RECEIVER.agent.gen = RECEIVER.generation;
  } else {
    connectAgentSocket();
  }
  if (RECEIVER.game?.sock) RECEIVER.game.gen = RECEIVER.generation;
}

export function stopReceiver() {
  RECEIVER.stopped = true;
  if (RECEIVER.agentReconnectTimer) {
    clearTimeout(RECEIVER.agentReconnectTimer);
    RECEIVER.agentReconnectTimer = null;
  }
  if (RECEIVER.gameReconnectTimer) {
    clearTimeout(RECEIVER.gameReconnectTimer);
    RECEIVER.gameReconnectTimer = null;
  }
  const a = RECEIVER.agent;
  const g = RECEIVER.game;
  RECEIVER.agent = null; //  un-current before closing → close handlers inert
  RECEIVER.game = null;
  safeClose(a?.sock);
  safeClose(g?.sock);
}

// Health snapshot for the driver (fallback gating) and the report.
export function receiverStatus() {
  return {
    agentReady: Boolean(RECEIVER.agent?.ready),
    gameReady: Boolean(RECEIVER.game?.ready && !RECEIVER.game.terminal),
    gameMatchId: RECEIVER.game?.matchId ?? null,
  };
}
