// SteamedClaw — loadable OpenClaw plugin entry.
//
// A standalone WS Leg-1 plugin (Shape A): a module-scope coordinator + turn
// coordinator that folds the live-validated WS receiver into a credentials-based,
// agent-initiated tool surface. Defaults to production (https://steamedclaw.com),
// overridable via the `server` config.
//
// Play path: the agent calls register_agent (identity → credentials), queue_match
// (binds ctx.sessionKey + enters matchmaking), then loops get_turn (BLOCKING
// pull) / take_turn (token-validated submit) to game-over.
//
// Speed path: match_found + your_turn arrive over WebSocket (ws-receiver.mjs);
// each turn is PARKED via coordinator.enqueueTurn, which resolves a blocked
// get_turn mid-call — or, if the agent has yielded, the supervisor fires a
// content-carrying heartbeat wake (enqueueSystemEvent + requestHeartbeat, spaced
// ≥~64s under OpenClaw's flood guard). Submit stays HTTP. HTTP polling is the
// fallback floor whenever a socket is down.
//
// Mechanics live in tool descriptions/results, never in agent SOUL/persona.

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import {
  register as registerCoordinator,
  getOwnerCoordinator,
  captureUndeliveredOutcome,
  takeCarryover,
  carryoverGuidance,
  matchFoundBlock,
  storeMatchFound,
  takeMatchFound,
} from './coordinator.mjs';
import { makeClient, TERMINAL_MATCH_STATUSES } from './transport.mjs';
import { readCredentials, writeCredentials, writeClaimIfAbsent } from './state.mjs';
import {
  startReceiver,
  stopReceiver,
  openGame,
  closeGame,
  receiverStatus,
  __resetReceiver,
} from './ws-receiver.mjs';

// Production server. Used when no `server` config is set; overridable to any
// value the operator provides.
export const DEFAULT_SERVER = 'https://steamedclaw.com';

export const LANES = ['fast', 'standard'];
// Default lane: 'fast' (short per-turn window). The plugin is WS push-driven and
// wakes the agent on-arrival (reason:'wake'), so the short window has ample
// headroom for responsive play. An agent on a slow heartbeat/poll cadence can
// pass lane:'standard' (long per-turn window) on a queue call; an operator can
// set configSchema.defaultLane.
export const DEFAULT_LANE = 'fast';
// v1 supports exactly one simultaneous game. >1 is rejected.
export const MAX_SIMULTANEOUS_GAMES = 1;

const DEFAULT_TICK_MS = 4000; //  supervisor cadence; WS events do the fast path
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 3000; //  floor backoff on a 429
// Registration 429 without a usable retry-after header (#715): the server's
// registration limit is per IP per hour, so a short floor would just invite the
// next wasted call — wait a full window.
const DEFAULT_REGISTER_BLOCK_MS = 60 * 60 * 1000;

function rateLimitedRegisterResult(waitMs) {
  const secs = Math.ceil(waitMs / 1000);
  return {
    ok: false,
    error: 'rate_limited',
    retryAfterMs: waitMs,
    message:
      waitMs > 0
        ? `Registration is rate-limited per IP. Wait ${secs}s (retryAfterMs) before calling register_agent again — calls before then cannot succeed and are answered locally without contacting the server.`
        : 'Registration was rate-limited but the server allows an immediate retry (retryAfterMs 0). Call register_agent again.',
  };
}
// tournament_status 429 backoff cap: the wait is retry-after-honoring but
// bounded — a tool call must return in seconds, not sit on a huge Retry-After.
const TOURNAMENT_RETRY_CAP_MS = 15000;
const DEFAULT_NEXT_TURN_BLOCK_MS = 20000; //  blocking get_turn budget
// HTTP safety-net cadence while the WS path is healthy: every Nth tick still
// runs discovery/state polling to catch events lost outside the 60s missed-event
// buffer (agent socket down >60s, lost game_over).
const SAFETY_NET_EVERY_TICKS = 15; //  ≈60s at the 4s tick
// Re-wake schedule while a parked turn sits unconsumed. A single park-time wake
// is lossy (absorbed when the agent is mid-turn), so we retry — but every
// re-wake is a full-context model call the operator pays for, and an agent that
// is ignoring wakes (#707: 61 wakes over 65 min, one a minute until the server
// timed the match out) must not cost a call a minute. So the retries back off:
// the first re-wake fires REWAKE_BASE_MS after the park, each later one waits
// twice as long, capped at REWAKE_MAX_MS; the schedule resets when a new turn
// is parked and stops when the turn is consumed or the match ends. Standard
// lane (65 min window): ~7 wakes instead of ~61. Fast lane (15 min): 4 instead
// of ~14. The base must stay ≥ ~64s: faster trips OpenClaw's heartbeat FLOOD
// GUARD (≥5 runs within 60s defers further wakes — verified in
// heartbeat-runner source). The wake text itself is unchanged: it is a
// general surface for every operator's agent, not a place for instructions
// aimed at any one deployment's heartbeat rules.
const REWAKE_BASE_MS = 64_000;
const REWAKE_MAX_MS = 1_024_000; //  ≈17 min between re-wakes once backed off

// Injectable clock for every time-gated decision in this module — the re-wake
// schedule, the 429 polling backoff, the registration block (tests drive it;
// prod = Date.now).
let clock = () => Date.now();
export function __setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

const TURN_INSTRUCTIONS =
  'You have a SteamedClaw turn. Call take_turn with this turnToken and a single legal action for the view shown.';

const NOT_REGISTERED_MESSAGE =
  'No credentials yet. Call register_agent({name, model?}) before queueing or playing.';

// ── Module-scope supervisor state (single resolved module ⇒ shared across all
// register() instances, the same guarantee the coordinator relies on). ────────
const DRIVER = {
  boundSessionKey: null,
  boundAgentId: null, //  OpenClaw agent id from queue ctx — the heartbeat target
  gameId: null,
  lane: null,
  matchId: null,
  matchGameId: null,
  phase: 'idle', //  idle → queued → in_match → terminal
  paused: false, //  leave_queue flag — suppresses NEW match pickups
  lastParkedSeq: -1,
  turnsParked: 0,
  parkedVia: { ws: 0, http: 0 },
  wakesFired: 0,
  backoffUntil: 0,
  tickCount: 0,
  //  Re-wake schedule for the currently parked turn (#707): which sequence it
  //  is for, how many re-wakes have fired for it, and when the next one is due.
  rewakeSeq: -1,
  rewakeCount: 0,
  rewakeNextAt: 0,
  receiverStarted: false,
  registerInFlight: null,
  //  Registration rate-limit block (#715): until this clock time, register_agent
  //  answers locally with the remaining wait instead of re-hitting the server.
  registerBlockedUntil: 0,
};

// Test-only view of the supervisor state (assertions only — never used by logic).
export function __peekDriver() {
  return DRIVER;
}

export function __resetDriver() {
  DRIVER.boundSessionKey = null;
  DRIVER.boundAgentId = null;
  DRIVER.gameId = null;
  DRIVER.lane = null;
  DRIVER.matchId = null;
  DRIVER.matchGameId = null;
  DRIVER.phase = 'idle';
  DRIVER.paused = false;
  DRIVER.lastParkedSeq = -1;
  DRIVER.turnsParked = 0;
  DRIVER.parkedVia = { ws: 0, http: 0 };
  DRIVER.wakesFired = 0;
  DRIVER.backoffUntil = 0;
  DRIVER.tickCount = 0;
  DRIVER.rewakeSeq = -1;
  DRIVER.rewakeCount = 0;
  DRIVER.rewakeNextAt = 0;
  DRIVER.receiverStarted = false;
  DRIVER.registerInFlight = null;
  DRIVER.registerBlockedUntil = 0;
  clock = () => Date.now();
  __resetReceiver();
}

// Start (or restart) the re-wake schedule for a freshly parked turn (#707).
function scheduleRewake(sequence, now) {
  DRIVER.rewakeSeq = sequence;
  DRIVER.rewakeCount = 0;
  DRIVER.rewakeNextAt = now + REWAKE_BASE_MS;
}

function toolText(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// On a 429, pause the supervisor's polling so it stops adding rate-limit
// pressure. Honors retryAfterMs, floored at DEFAULT_RATE_LIMIT_BACKOFF_MS.
function rateLimited(res, logger) {
  if (res && res.httpStatus === 429) {
    const wait = Math.max(res.retryAfterMs ?? 0, DEFAULT_RATE_LIMIT_BACKOFF_MS);
    DRIVER.backoffUntil = clock() + wait;
    logger.info?.(`[steamedclaw-plugin] 429 rate-limited — backing off ${wait}ms`);
    return true;
  }
  return false;
}

// Wake the agent's session — the speed path when a turn arrives while the agent
// has yielded. Two-part, because a bare heartbeat carries NO content and the
// agent demonstrably shrugs at it:
//   1. enqueueSystemEvent(text) — queues an ACTIONABLE instruction the next
//      heartbeat run surfaces into the agent's context (same channel as
//      exec-completion notices). Callable post-register (runtime.system).
//   2. requestHeartbeat — triggers that run. Returns undefined live; success is
//      the agent waking. Targets the OpenClaw agent/session captured at queue.
function wakeAgent(api, reason, logger, text) {
  if (!api || !DRIVER.boundSessionKey) return;
  try {
    if (text) {
      api.runtime?.system?.enqueueSystemEvent?.(text, { sessionKey: DRIVER.boundSessionKey });
    }
    api.runtime?.system?.requestHeartbeat?.({
      source: 'background-task',
      intent: 'immediate',
      agentId: DRIVER.boundAgentId ?? undefined,
      sessionKey: DRIVER.boundSessionKey,
      // MUST be literal 'wake': OpenClaw's heartbeat runner only treats a wake as
      // a "wake payload" (isWakePayload) when source is hook/acp-spawn OR
      // reason === 'wake'. With source 'background-task' and any other reason, an
      // empty HEARTBEAT.md makes the runner skip with skipReason 'empty-heartbeat-file'
      // BEFORE it runs the agent — the enqueued turn survives as context but no run
      // fires, so the agent never plays until an unrelated prompt wakes it. Verified
      // in OpenClaw 2026.5.28 + live-validated against Cyd 2026-06-26 (planning/072k).
      reason: 'wake',
    });
    DRIVER.wakesFired += 1;
    logger?.info?.(`[steamedclaw-plugin] heartbeat wake fired (${reason})${text ? ' +event' : ''}`);
  } catch (err) {
    logger?.warn?.(`[steamedclaw-plugin] heartbeat wake failed: ${err?.message ?? err}`);
  }
}

// 1.0.15: a wake line is a system event, text the agent reads as an
// instruction, and the match id in it comes from the server. The server issues
// match ids as UUIDs, so the id rides in a wake line only in that form; any
// other value (extra text, a line break, a non-string) leaves the line without
// one. The id is there so the agent knows which match the wake is about; no
// tool takes it, so a line without it plays the same.
const WAKE_MATCH_ID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function wakeMatchId() {
  const id = DRIVER.matchId;
  return typeof id === 'string' && WAKE_MATCH_ID_FORM.test(id) ? id : null;
}

function turnEventText(sequence) {
  const id = wakeMatchId();
  const which = id ? `match ${id}, sequence ${sequence}` : `sequence ${sequence}`;
  return `SteamedClaw: it is YOUR TURN (${which}). Call get_turn now to get the turn, then take_turn with the returned turnToken.`;
}

function matchEndedEventText() {
  const id = wakeMatchId();
  return `SteamedClaw: the match${id ? ` (${id})` : ''} has ended. Call get_turn to confirm, then stop.`;
}

// Park one turn (from either path) exactly once, then wake the agent unless a
// blocked get_turn already consumed the notify (woken > 0 ⇒ agent is awake,
// mid-tool-call). The sequence is CLAIMED synchronously (so a concurrent WS/HTTP
// park of the same turn dedupes) but ROLLED BACK if the park fails — otherwise a
// failed enqueue would suppress every redelivery of that turn and lose it.
// `turnEndsAt` (#739) is the server's per-turn deadline (#455): both surfaces
// this is fed from — the WS your_turn frame and the /state your_turn body —
// carry it when known, and it rides through verbatim so the agent can pace
// against the lane's turn timeout. Absent on the input ⇒ absent on the packet.
async function parkTurn(owner, { sequence, view, turnEndsAt }, via, { api, logger }) {
  if (typeof sequence !== 'number' || sequence <= DRIVER.lastParkedSeq) return false;
  const prevSeq = DRIVER.lastParkedSeq;
  DRIVER.lastParkedSeq = sequence; //  claim before the await — concurrent parks dedupe here
  try {
    const { woken } = await owner.enqueueTurn({
      matchId: DRIVER.matchId,
      sequence,
      view,
      turnEndsAt,
      instructions: TURN_INSTRUCTIONS,
    });
    DRIVER.turnsParked += 1;
    DRIVER.parkedVia[via] += 1;
    logger?.info?.(`[steamedclaw-plugin] parked turn seq=${sequence} via=${via} woken=${woken}`);
    if (!woken) wakeAgent(api, 'steamedclaw-turn', logger, turnEventText(sequence));
    scheduleRewake(sequence, clock()); //  the supervisor re-wakes on this schedule while unconsumed
    return true;
  } catch (err) {
    if (DRIVER.lastParkedSeq === sequence) DRIVER.lastParkedSeq = prevSeq;
    logger?.warn?.(
      `[steamedclaw-plugin] park failed seq=${sequence} via=${via}: ${err?.message ?? err}`,
    );
    return false;
  }
}

function finishMatch(owner, receiver, { api, logger }, how, outcome) {
  if (DRIVER.phase === 'terminal') return; //  WS + HTTP can both detect game_over — finish once
  const { woken } = owner.markTerminal(DRIVER.matchId, outcome); //  outcome → #510 get_turn context
  receiver?.closeGame?.(DRIVER.matchId, { terminal: true });
  DRIVER.phase = 'terminal';
  if (!woken) {
    wakeAgent(api, 'steamedclaw-game-over', logger, matchEndedEventText());
  }
  logger?.info?.(`[steamedclaw-plugin] GAME OVER (${how}) — ${JSON.stringify(buildReport())}`);
}

// Delivery report for diagnostics/logging. Not an agent-facing tool.
function buildReport() {
  return {
    boundSessionKey: DRIVER.boundSessionKey,
    matchId: DRIVER.matchId,
    phase: DRIVER.phase,
    turnsParked: DRIVER.turnsParked,
    lastParkedSeq: DRIVER.lastParkedSeq,
    parkedVia: { ...DRIVER.parkedVia },
    wakesFired: DRIVER.wakesFired,
    delivery: DRIVER.parkedVia.ws > 0 ? 'ws-pull' : 'http-pull',
    ws: receiverStatus(),
  };
}

// Adopt a server-created match as the tracked match (#663). Tournament matches
// bypass matchmaking — the tournament service creates them directly and pushes
// match_found — and a Bo-N series delivers game 2..N (and each later round's
// game) as a fresh match with NO queue_match call in between. Adoption runs the
// same per-match reset the queue tool's fresh-queue block performs; the
// lastParkedSeq/parkedVia/matchGameId reset is load-bearing — without it,
// parkTurn's sequence dedupe silently drops the new game's low sequences.
// Phase moves to 'queued' so the supervisor's attach block (or the WS handler's
// inline attach) completes the attach + game-socket open.
function adoptMatch(matchId, gameId) {
  // #663 carryover: adoption replaces a TERMINAL match. If the agent has not
  // yet fetched that match's final state, the reset below would silently lose
  // its end-of-game envelope (results + the server messaging envelope,
  // #514/#517) — capture it (coordinator-side, consume-once) so the adopted
  // match's first agent-facing response delivers it verbatim as
  // previousMatchResult. Delivered/absent outcomes are no-ops inside.
  captureUndeliveredOutcome(DRIVER.matchId);
  DRIVER.matchId = matchId;
  DRIVER.matchGameId = gameId ?? null;
  DRIVER.lastParkedSeq = -1;
  DRIVER.parkedVia = { ws: 0, http: 0 };
  DRIVER.phase = 'queued';
}

// #856: a match discovered through the agent's match list (the HTTP floor's
// activeMatch read, and post-terminal adoption) carries none of the
// match-found fields; the status route's `matched` answer does, for a pending
// or a live match (#678). One read, best-effort: a 429, a `queued` answer (the
// agent is also queued for that game, ADR-018) or a different match stores
// nothing, and nothing here can delay the attach.
async function fetchMatchFoundViaStatus(client, matchId, gameId, logger) {
  if (!matchId || !gameId || typeof client?.matchmakingStatus !== 'function') return;
  try {
    const s = await client.matchmakingStatus(gameId);
    if (rateLimited(s, logger)) return; //  #715: a 429 here backs the poll loop off like any other
    if (s?.ok && s.status === 'matched' && s.matchId === matchId) {
      storeMatchFound(matchId, matchFoundBlock(s));
    }
  } catch (err) {
    logger?.warn?.(`[steamedclaw-plugin] match-found read failed: ${err?.message ?? err}`);
  }
}

// Build the WS receiver adapter with the supervisor's event handlers bound in.
// makeWebSocket is injectable for tests.
export function makeWsReceiver({ api, server, logger, makeWebSocket }) {
  function handleMatchFound(frame) {
    try {
      // leave_queue: ignore NEW pairings, unless the server may still hold
      // this plugin's own queue entry (a withdraw not yet confirmed, a
      // formation in flight): then the pairing is the agent's and is attached
      // rather than orphaned (1.0.13).
      if (DRIVER.paused && !(DRIVER.phase === 'queued' && !DRIVER.matchId)) return;
      if (!frame?.matchId) return;
      if (frame.matchId === DRIVER.matchId) return; //  duplicate push for the tracked match
      // Single-match v1: only a LIVE match occupies the slot. A terminal one
      // does not (#663): a tournament Bo-N series delivers game 2 (and the
      // next round's game) as a fresh match_found with no re-queue — accept it
      // and reset the per-match state, exactly as a fresh queue_match would.
      if (DRIVER.matchId && DRIVER.phase !== 'terminal') return; //  live match — ignore extras
      adoptMatch(frame.matchId, frame.gameId ?? DRIVER.gameId);
      // #856: the frame's match-found fields (gameName, watchUrl,
      // opponentDetails, messaging.toAgent) wait for the agent's first read.
      storeMatchFound(frame.matchId, matchFoundBlock(frame));
      const owner = getOwnerCoordinator();
      if (owner && DRIVER.boundSessionKey) {
        owner.attachMatch(DRIVER.boundSessionKey, DRIVER.matchId, DRIVER.matchGameId);
        DRIVER.phase = 'in_match';
        openGame(DRIVER.matchId);
        logger.info?.(`[steamedclaw-plugin] matched via WS matchId=${DRIVER.matchId}`);
      }
      //  else: matchId is set — the next tick attaches and opens the game socket.
    } catch (err) {
      logger.warn?.(`[steamedclaw-plugin] match_found handler error: ${err?.message ?? err}`);
    }
  }

  function handleYourTurn(frame) {
    void (async () => {
      try {
        const owner = getOwnerCoordinator();
        if (!owner || !DRIVER.matchId || DRIVER.phase === 'terminal') return;
        await parkTurn(owner, frame, 'ws', { api, logger });
      } catch (err) {
        logger.warn?.(`[steamedclaw-plugin] your_turn handler error: ${err?.message ?? err}`);
      }
    })();
  }

  function handleMessage(frame) {
    try {
      const owner = getOwnerCoordinator();
      if (!owner || !DRIVER.matchId || DRIVER.phase === 'terminal') return;
      owner.appendMessages(DRIVER.matchId, [frame]);
    } catch (err) {
      logger.warn?.(`[steamedclaw-plugin] message handler error: ${err?.message ?? err}`);
    }
  }

  function handleGameOver(frame) {
    try {
      const owner = getOwnerCoordinator();
      if (!owner || !DRIVER.matchId || DRIVER.phase === 'terminal') return;
      // The WS game_over frame IS the server's end-of-game envelope (results,
      // reason, rating, newBadges, shareText, replay URLs, messaging #514/#517,
      // nextGameAssigned #663, ...). FULL PASSTHROUGH (#724): hand the whole
      // frame to the coordinator — cleanOutcome strips only the plugin-owned
      // keys (type/status/ok/via) — so get_turn surfaces everything the server
      // said, verbatim.
      finishMatch(owner, { closeGame }, { api, logger }, 'ws', frame);
    } catch (err) {
      logger.warn?.(`[steamedclaw-plugin] game_over handler error: ${err?.message ?? err}`);
    }
  }

  return {
    ensureStarted() {
      if (DRIVER.receiverStarted) return;
      const creds = readCredentials();
      if (!creds?.apiKey) return; //  can't open authenticated sockets yet
      DRIVER.receiverStarted = true;
      startReceiver({
        server,
        apiKey: creds.apiKey,
        logger,
        makeWebSocket,
        onMatchFound: handleMatchFound,
        onYourTurn: handleYourTurn,
        onGameOver: handleGameOver,
        onMessage: handleMessage,
      });
    },
    status: receiverStatus,
    openGame,
    closeGame,
    stop: stopReceiver,
  };
}

// One supervisor step. The config-driven register/queue die — register is the
// register_agent tool, queue is queue_match. The supervisor only: brings up the
// receiver once credentials exist, resolves the bound session, drives the
// queued→matched transition over the HTTP fallback when WS is down, parks
// HTTP-fallback turns, re-wakes an unconsumed turn, and finalizes on game_over.
// The supervisor runs for the plugin lifetime: after a game it IDLES on the
// terminal phase — it does not stop — until the agent re-queues OR the
// post-terminal safety-cadence discovery (#663) adopts the next server-created
// match (tournament series game / next round), so both "play again" and an
// unattended tournament series are serviced. `receiver`/`api` optional ⇒ pure
// HTTP pull floor (the tested path).
export async function supervisorTick({ client, server, cfg, logger, receiver, api }) {
  try {
    DRIVER.tickCount += 1;
    const safety = DRIVER.tickCount % SAFETY_NET_EVERY_TICKS === 0;
    // The same discovery serves a bound IDLE phase (#922): an entered agent
    // whose tournament_status call bound its session before any match
    // existed. Its match is created server-side with no queue entry; with the
    // agent socket up the match_found push finds it, so idle spends nothing
    // then, and on the HTTP floor (wsEnabled:false, or the socket not yet up)
    // this read is the only path that finds it. Unbound idle costs nothing.
    const agentSocketUp = Boolean(receiver && receiver.status().agentReady);
    if (
      DRIVER.phase === 'terminal' ||
      (DRIVER.phase === 'idle' && DRIVER.boundSessionKey && !agentSocketUp)
    ) {
      const phaseAtRead = DRIVER.phase;
      // Game over — idle, but do NOT go blind (#663): a tournament Bo-N series
      // (or the next round) creates this agent's next match server-side with
      // no re-queue, and its match_found push can even race the game_over
      // frame (observed live: game 2's push landed 1ms before game 1's
      // game_over) — in that order handleMatchFound's terminal-aware guard
      // never sees it, and /ws/agent replays only frames that were never
      // delivered. On the safety cadence, discover an unfinished match over
      // HTTP and adopt it; the attach block below opens it this same tick.
      if (!safety || DRIVER.paused || !DRIVER.boundSessionKey) return 'idle';
      if (DRIVER.backoffUntil && clock() < DRIVER.backoffUntil) return 'idle';
      if (typeof client.activeMatch !== 'function') return 'idle';
      const terminalCreds = readCredentials();
      if (!terminalCreds?.apiKey) return 'idle';
      client.setApiKey(terminalCreds.apiKey);
      // No gameId filter: the next tournament game is not tied to whatever the
      // agent last QUEUED (it may never have queued this game at all).
      const am = await client.activeMatch(terminalCreds.agentId);
      if (rateLimited(am, logger)) return 'idle';
      // Re-check after the await: a WS match_found may have adopted first.
      if (DRIVER.phase !== phaseAtRead || DRIVER.paused) return 'continue';
      if (!am.ok || !am.matchId || am.matchId === DRIVER.matchId) return 'idle';
      adoptMatch(am.matchId, am.gameId ?? null);
      await fetchMatchFoundViaStatus(client, am.matchId, am.gameId ?? null, logger);
      logger.info?.(
        `[steamedclaw-plugin] ${phaseAtRead === 'idle' ? 'idle' : 'post-terminal'} discovery adopted matchId=${DRIVER.matchId}`,
      );
      //  fall through — the attach block below binds + opens the game socket now
    }

    const owner = getOwnerCoordinator();
    if (!owner) return 'continue'; //  no full-mode owner yet
    if (DRIVER.backoffUntil && clock() < DRIVER.backoffUntil) return 'continue';

    // Credentials gate: the register tool writes them. No creds ⇒ idle.
    const creds = readCredentials();
    if (!creds?.apiKey) return 'continue';
    client.setApiKey(creds.apiKey);

    // Creds exist → bring up the WS receiver (idempotent, single-flight).
    receiver?.ensureStarted?.();

    // Resolve the bound session (the queue tool binds it). Until the agent has
    // queued there is nothing to discover or wake.
    if (!DRIVER.boundSessionKey) {
      const bound = owner.boundSessions();
      if (bound.length === 0) return 'continue';
      DRIVER.boundSessionKey = bound[0].sessionKey;
      DRIVER.boundAgentId = bound[0].agentId ?? null;
    }

    const resolvedGameId = DRIVER.gameId;

    // Resolve the matchId for an outstanding queue entry. Primary discovery is
    // the /ws/agent match_found push (handled in makeWsReceiver); the HTTP polls
    // here run only when that socket is down, or on the safety cadence.
    // 1.0.13: this block runs while paused too. leave_queue withdraws the
    // server entry and moves the phase to idle on a confirmed withdraw, so a
    // paused plugin reaches this block only while the server may still hold
    // or be forming a pairing (an unconfirmed withdraw, a formation in
    // flight). A match the server commits is the agent's and is attached
    // rather than orphaned; a not_queued answer then settles to idle without
    // the re-queue wake, since the agent asked to leave.
    if (!DRIVER.matchId && DRIVER.phase === 'queued') {
      // No client-side queue timeout. Queued is queued — the server owns the TTL
      // (standard 65 min / fast 20 min, see lane-timeouts.ts) and is the single
      // source of truth for "still queued". A local timer once fired a false
      // "aged out, re-queue" after 60s while the server held the entry for ~65 min
      // (Cyd live finding, 2026-06-24; see planning/072k). The plugin queues once
      // and WAITS for the match via the /ws/agent push + the discovery polls
      // below. The only legitimate re-queue trigger is the server reporting the
      // entry gone (matchmakingStatus → not_queued), handled below.
      const wsDiscovery = Boolean(receiver && receiver.status().agentReady);
      if (!wsDiscovery || safety) {
        let activeId = null;
        if (typeof client.activeMatch === 'function') {
          const am = await client.activeMatch(creds.agentId, resolvedGameId);
          if (rateLimited(am, logger)) return 'continue';
          if (am.ok && am.matchId) activeId = am.matchId;
        }
        if (activeId) {
          DRIVER.matchId = activeId;
          await fetchMatchFoundViaStatus(client, activeId, resolvedGameId, logger);
        } else {
          const s = await client.matchmakingStatus(resolvedGameId);
          if (rateLimited(s, logger)) return 'continue';
          if (s.ok && s.status === 'matched' && s.matchId) {
            DRIVER.matchId = s.matchId;
            storeMatchFound(s.matchId, matchFoundBlock(s)); //  #856: who you are playing, once
          } else if (s.ok && s.status === 'not_queued' && DRIVER.paused) {
            // The agent asked to leave and the server holds nothing: settle
            // without the re-queue wake below.
            logger.info?.('[steamedclaw-plugin] no longer queued after leave_queue');
            DRIVER.phase = 'idle';
          } else if (s.ok && s.status === 'not_queued') {
            // Server dropped/consumed our entry without a match (a rare ~65-min
            // event at the server TTL). This is the ONE legitimate re-queue
            // trigger. Requeue is agent-initiated — wake the agent to re-queue,
            // do not auto-re-POST.
            logger.info?.('[steamedclaw-plugin] no longer queued — waking agent to re-queue');
            DRIVER.phase = 'idle';
            wakeAgent(
              api,
              'steamedclaw-requeue',
              logger,
              'SteamedClaw: your queue entry expired before a match formed. Call queue_match again to keep playing.',
            );
          }
        }
      }
    }

    // Attach + open the game socket once matchId is known (covers both the WS
    // match_found that landed before bind, and the queue tool's immediate match).
    if (DRIVER.matchId && DRIVER.phase !== 'in_match' && DRIVER.phase !== 'terminal') {
      owner.attachMatch(
        DRIVER.boundSessionKey,
        DRIVER.matchId,
        DRIVER.matchGameId ?? resolvedGameId,
      );
      DRIVER.phase = 'in_match';
      receiver?.openGame?.(DRIVER.matchId);
      logger.info?.(`[steamedclaw-plugin] matched matchId=${DRIVER.matchId}`);
    }
    if (!DRIVER.matchId) return 'continue';

    // Re-wake: while a parked turn sits unconsumed, re-fire the wake on the
    // backed-off schedule (#707; see REWAKE_BASE_MS). The park-time wake is
    // lost if the agent was mid-turn. Stops on its own: a SUBMIT marks the token
    // used (status leaves your_turn) — merely reading the turn does not, an
    // agent that read it and idled still owes the move — and game-over flips
    // the phase.
    if (DRIVER.phase === 'in_match' && api) {
      const cur = owner.nextTurn(DRIVER.boundSessionKey);
      if (cur.status === 'your_turn') {
        const now = clock();
        if (DRIVER.rewakeSeq !== cur.sequence) scheduleRewake(cur.sequence, now); //  defensive: unscheduled park
        if (now >= DRIVER.rewakeNextAt) {
          wakeAgent(api, 'steamedclaw-turn-rewake', logger, turnEventText(cur.sequence));
          DRIVER.rewakeCount += 1;
          DRIVER.rewakeNextAt =
            now + Math.min(REWAKE_BASE_MS * 2 ** DRIVER.rewakeCount, REWAKE_MAX_MS);
        }
      }
    }

    // Turn delivery. Primary: /ws/game your_turn push. Fallback + safety net:
    // poll match state, PARK each new your_turn, finalize on game_over.
    const gameWsReady = Boolean(receiver && receiver.status().gameReady);
    if (gameWsReady && !safety) return 'continue';
    const polledMatchId = DRIVER.matchId;
    const st = await client.getState(polledMatchId);
    if (rateLimited(st, logger)) return 'continue';
    if (!st.ok) return 'continue';
    // Discard a stale response (#663): adoption can swap the tracked match
    // WHILE this poll is in flight (game_over + the next series game's
    // match_found land between request and response — observed 1ms apart
    // live). finishMatch/parkTurn below act on the CURRENT DRIVER.matchId, so
    // applying the old match's state would mark the NEW match terminal with
    // the OLD outcome (bricking it — terminalGames never reopens) or park a
    // phantom high-sequence turn that dedupes the new game's real turns away.
    if (DRIVER.matchId !== polledMatchId) return 'continue';
    if (typeof st.status === 'string' && TERMINAL_MATCH_STATUSES.has(st.status)) {
      // getState already fetched the terminal /state body — the server's whole
      // end-of-game envelope. FULL PASSTHROUGH (#724): hand it to the
      // coordinator as-is (cleanOutcome strips only the plugin-owned keys,
      // type/status/ok/via) so the opponent-ended get_turn surfaces everything
      // the server said (#510/#517/#663 and whatever comes next). reason is WS-only.
      finishMatch(owner, receiver, { api, logger }, 'http', st);
      return 'idle'; //  game over — the supervisor keeps ticking for a re-queue
    }
    if (st.status === 'discussion') {
      if (Array.isArray(st.messages) && st.messages.length > 0) {
        // HTTP backfill of the discussion receive buffer (WS 'message' frames
        // are the primary source; the state response repeats the table talk).
        owner.appendMessages(DRIVER.matchId, st.messages);
      }
      // Park as a deliverable turn ONLY on the server's explicit awaiting-action
      // signal (#541): bare 'discussion' reports for committed and even dead
      // players (with a table-max fallback sequence), so parking on the status
      // alone would mint phantom turns — the #538 Phase-2 finding that kept
      // delivery WS-only in 1.0.2. awaitingAction=true carries the per-agent
      // pending sequence, so parkTurn's seq dedupe absorbs healthy-WS safety
      // ticks that re-report a turn the WS push already parked. Strict === true
      // keeps backfill-only behavior against servers without the field (#552).
      if (st.awaitingAction === true) {
        await parkTurn(owner, st, 'http', { api, logger });
      }
    }
    if (st.status === 'your_turn') {
      await parkTurn(owner, st, 'http', { api, logger });
    }
    return 'continue';
  } catch (err) {
    logger.warn?.(`[steamedclaw-plugin] tick error: ${err?.message ?? err}`);
    return 'continue';
  }
}

function makeSupervisorService(api, client, server, cfg, logger, receiver) {
  let timer = null;
  let stopped = false;
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  return {
    id: 'steamedclaw-supervisor',
    async start() {
      if (api.registrationMode !== 'full') return;
      stopped = false;
      if (timer) return; //  already ticking — start() can fire twice per boot
      // The supervisor runs for the plugin lifetime. It is NOT stopped after a
      // game — supervisorTick idles on the terminal phase and resumes on a
      // re-queue or on post-terminal match discovery (#663 — tournament series
      // games arrive with no re-queue), so play-again and unattended series
      // play both work. Only the service lifecycle stop() (plugin unload)
      // clears the interval.
      timer = setInterval(() => {
        if (stopped) return;
        void supervisorTick({ client, server, cfg, logger, receiver, api });
      }, cfg.tickMs ?? DEFAULT_TICK_MS);
    },
    async stop() {
      stopped = true;
      stop();
    },
  };
}

// ── Agent-facing tools (entry side): register, queue, leave_queue, info ───────
// All are factory tools (ctx)=>tool: queue needs ctx.sessionKey/agentId for the
// session bind; the rest are factories for surface consistency.

function makeRegisterTool({ client, server, logger, receiver }) {
  return () => ({
    name: 'register_agent',
    description: `Register this agent with the SteamedClaw server. Pass {name, model?} — name is your agent identity (1-64 chars, letters/numbers/hyphens/spaces/underscores, immutable, unique across SteamedClaw); model is optional (your LLM model id for stats). Use your SOUL-defined identity for name. Returns {ok, id?, name?, claimUrl?, verificationCode?, messaging?, guidance?, error?, message?, retryAfterMs?}. On ok:true relay messaging.forOperator to your operator in your next message so they can claim this agent (it carries the claim link); messaging.toAgent is the server's welcome written for you, and the plugin has already stored your API key for you. On error='already_registered' credentials exist — skip and call queue_match. On error='name_taken' pick a different name (message says so). On error='rate_limited' registration is limited per IP: wait the returned retryAfterMs before calling again — never retry sooner, repeated calls cannot succeed until the window passes. After registering, call queue_match to play.`,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Agent name (1-64 chars; letters/numbers/hyphens/spaces/underscores).',
        },
        model: {
          type: 'string',
          description: 'Optional LLM model identifier (e.g. "claude-opus-4-8").',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(_callId, args) {
      const { name, model } = args ?? {};
      if (typeof name !== 'string' || name.length === 0) {
        return toolText({
          ok: false,
          error: 'invalid_name',
          message: 'name is required (1-64 chars).',
        });
      }
      const existing = readCredentials();
      if (existing) {
        receiver?.ensureStarted?.();
        return toolText({
          ok: false,
          error: 'already_registered',
          name: existing.name ?? null,
          message: existing.name
            ? `Already registered as "${existing.name}". Use queue_match, get_turn, etc.`
            : 'Already registered. Use queue_match.',
        });
      }
      // Rate-limit block (#715): registration is limited per IP on the server.
      // Once a 429 lands, answer locally with the remaining wait until it
      // passes — the sweep saw a model hot-loop 11 registrations in 40 s, each
      // a wasted HTTP round trip that could never succeed inside the window.
      const remainingBlockMs = DRIVER.registerBlockedUntil - clock();
      if (remainingBlockMs > 0) {
        return toolText(rateLimitedRegisterResult(remainingBlockMs));
      }
      // Memoize an in-flight register so two parallel calls settle on one POST.
      if (!DRIVER.registerInFlight) {
        DRIVER.registerInFlight = (async () => {
          try {
            const r = await client.register(name, model);
            if (!r.ok) return r;
            try {
              writeCredentials(server, r.id, r.apiKey, name);
            } catch (err) {
              return {
                ok: false,
                error: 'persist_failed',
                serverSideRegistered: true,
                message: `Server registered the agent but local credentials persist failed: ${err?.message ?? err}.`,
              };
            }
            if (r.claimUrl) {
              try {
                writeClaimIfAbsent(r.claimUrl, r.verificationCode);
              } catch (err) {
                logger.warn?.(`[steamedclaw-plugin] claim.md write failed: ${err?.message ?? err}`);
              }
            }
            client.setApiKey(r.apiKey);
            receiver?.ensureStarted?.();
            logger.info?.(`[steamedclaw-plugin] registered agent "${name}" id=${r.id}`);
            return {
              ok: true,
              id: r.id,
              name,
              model: typeof model === 'string' && model.length > 0 ? model : null,
              // H1 (087 security review): the raw apiKey is deliberately NOT returned
              // into the LLM tool result. The plugin already persisted it
              // (writeCredentials) and set it on the client (setApiKey) above, so the
              // agent never needs it in-context. claimUrl/verificationCode are the
              // operator-claim surface (non-secret).
              claimUrl: r.claimUrl || null,
              verificationCode: r.verificationCode || null,
              // #856 (planning/132 T1): the server's welcome, whole. toAgent is
              // written for the agent; forOperator is the claim line written
              // for its human and replaces the plugin's old operatorNotice, so
              // every play path hands the operator the same words. The plugin
              // adds one structural line: the welcome tells the agent to store
              // its API key, and here the plugin has already done that.
              ...(r.messaging && typeof r.messaging === 'object' ? { messaging: r.messaging } : {}),
              guidance:
                'Relay messaging.forOperator to your operator so they can claim this agent; messaging.toAgent is written for you. The plugin has already stored your API key and sends it on every call, so you never need it.',
            };
          } finally {
            DRIVER.registerInFlight = null;
          }
        })();
      }
      const payload = await DRIVER.registerInFlight;
      // Normalize transport error codes the LLM can act on.
      if (payload.ok === false && payload.error === 'name_taken') {
        payload.message =
          payload.message ?? `"${name}" is taken. Pick a different name and call again.`;
      }
      if (payload.ok === false && payload.httpStatus === 429) {
        // #715: honor the server's retry-after; only a MISSING header falls
        // back to the full-window default. Remember the block locally and tell
        // the model exactly how long to wait.
        const waitMs =
          typeof payload.retryAfterMs === 'number' && payload.retryAfterMs >= 0
            ? payload.retryAfterMs //  0 = "retry now" (a proxy can say so): no local block
            : DEFAULT_REGISTER_BLOCK_MS;
        DRIVER.registerBlockedUntil = clock() + waitMs;
        return toolText(rateLimitedRegisterResult(waitMs));
      }
      return toolText(payload);
    },
  });
}

function makeQueueTool({ client, server, cfg, logger, receiver, coordinator }) {
  const allowedGames = Array.isArray(cfg.allowedGames) ? cfg.allowedGames : null;
  const maxGames = cfg.maxSimultaneousGames ?? MAX_SIMULTANEOUS_GAMES;
  return (ctx) => ({
    name: 'queue_match',
    description: `Enter SteamedClaw matchmaking for a game. Pass {gameId, lane?} — gameId is a SteamedClaw game id (call list_games to discover ids); optional lane selects the per-turn time budget — "fast" (the default: short per-turn window, best for responsive WebSocket play) or "standard" (long per-turn window, for agents on a slow heartbeat/poll cadence) — omit for the default ("${DEFAULT_LANE}"). This binds your session and holds the queue. Returns {ok, status, matchId?, game?, position?, messaging?, error?, message?}. messaging.toAgent is the server's line for you about what happens next. On status="matched" a match formed and the result also carries gameName, opponentDetails (each opponent's name and, when rated, rating) and watchUrl (a link your operator can watch at); call get_turn (it blocks until your turn). On status="matched" with recovered:true a match of yours was already live on the server (for example because this gateway restarted mid-match) and was picked up again instead of queueing; call get_turn. On status="queued" no pairing yet — call get_turn and it will wake/resolve when a match is found; do NOT spam queue. On error="rate_limited" the server throttled the live-match check that runs before queueing: wait retryAfterMs when it is given, then call queue_match again. On status="already_queued" you are already in queue. On error="already_in_match" finish the current match first. On error="game_not_allowed" the operator restricted which games this plugin may play. On error="not_registered" call register_agent first. On error="game_limit_reached" you have used your games for the rolling window: the result carries the server's message, limit, windowHours, retryAfterSeconds and retryAfterMs; wait that long before queueing again, and if messaging.forOperator is present relay it to your operator (it carries the claim link that raises the limit). After a match, loop get_turn / take_turn to game-over.`,
    parameters: {
      type: 'object',
      properties: {
        gameId: {
          type: 'string',
          description: 'Game id to queue for. Call list_games to discover ids.',
        },
        lane: {
          type: 'string',
          enum: LANES,
          description:
            'Optional match lane (per-turn time budget). "fast" (default): short per-turn window — best for responsive play, since the plugin wakes you over WebSocket the moment it is your turn. "standard": long per-turn window — choose this only if your agent runs on a slow heartbeat/poll cadence and may not act for many minutes. On either lane, exceeding the per-turn window forfeits the match. Omit to use the default (fast).',
        },
      },
      required: ['gameId'],
      additionalProperties: false,
    },
    async execute(_callId, args) {
      const { gameId, lane } = args ?? {};
      if (typeof gameId !== 'string' || gameId.length === 0) {
        return toolText({ ok: false, error: 'invalid_game', message: 'gameId is required.' });
      }
      if (lane !== undefined && !LANES.includes(lane)) {
        return toolText({
          ok: false,
          error: 'invalid_lane',
          message: `lane must be one of ${LANES.join(', ')}`,
        });
      }
      // v1 supports exactly one simultaneous game.
      if (maxGames !== MAX_SIMULTANEOUS_GAMES) {
        return toolText({
          ok: false,
          error: 'max_simultaneous_unsupported',
          message: `SteamedClaw v1 supports maxSimultaneousGames=${MAX_SIMULTANEOUS_GAMES} only; configured ${maxGames} is not accepted.`,
        });
      }
      if (allowedGames && !allowedGames.includes(gameId)) {
        return toolText({
          ok: false,
          error: 'game_not_allowed',
          message: `The operator restricted this plugin to: ${allowedGames.join(', ')}. "${gameId}" is not allowed.`,
        });
      }
      const creds = readCredentials();
      if (!creds)
        return toolText({ ok: false, error: 'not_registered', message: NOT_REGISTERED_MESSAGE });
      // Slot check at cap=1: an active match occupies the only slot.
      if (DRIVER.matchId && DRIVER.phase !== 'terminal') {
        if (DRIVER.phase === 'in_match') {
          return toolText({
            ok: false,
            error: 'already_in_match',
            matchId: DRIVER.matchId,
            game: DRIVER.gameId,
          });
        }
        // #663: a match is tracked but NOT attached. Tournament matches bypass
        // matchmaking, so their match_found can land before any session is
        // bound (this may be the agent's first queue_match this process) — and
        // dead-ending that as already_in_match left NO tool-level recovery via
        // the one tool that binds a session. Bind this call's ctx and adopt
        // the pending match instead; the supervisor's attach block completes
        // the join on the next tick.
        client.setApiKey(creds.apiKey);
        bindCallerForMatch(ctx, { coordinator, receiver, rebind: true });
        DRIVER.phase = 'queued'; //  the attach block completes the join
        DRIVER.paused = false;
        const adopted = {
          ok: true,
          status: 'matched',
          matchId: DRIVER.matchId,
          game: DRIVER.matchGameId ?? DRIVER.gameId,
        };
        // #663 carryover: this 'matched' result is the adopted match's first
        // agent-facing response on the C path — deliver a displaced terminal
        // envelope here, verbatim, exactly once.
        const carried = takeCarryover(DRIVER.matchId);
        if (carried) {
          adopted.previousMatchResult = carried;
          adopted.guidance = carryoverGuidance(carried);
        }
        // #856: this is the adopted match's first agent-facing result, so the
        // stored match-found block rides it (and is consumed) here.
        const matchFound = takeMatchFound(DRIVER.matchId);
        if (matchFound) adopted.matchFound = matchFound;
        return toolText(adopted);
      }

      const resolvedLane = lane ?? cfg.defaultLane ?? DEFAULT_LANE;
      client.setApiKey(creds.apiKey);

      // #828: the plugin's match state is in memory. After the agent's own
      // gateway restarts mid-match nothing is tracked here while the server
      // still holds a live match for this agent; enqueueing now would leave a
      // stale queue entry behind once the supervisor re-discovers that match,
      // and the matchmaker would later pair it into a game the agent never
      // asked for. So before a fresh queue the server is asked (the same
      // active-match read the supervisor uses, with no game filter: any live
      // match occupies the single slot) and a live match is adopted instead.
      // A 429 on that read answers rate_limited (never enqueue blind, never
      // hot-loop, #715); any other failure falls through to the queue POST.
      if (typeof client.activeMatch === 'function') {
        let am = null;
        try {
          am = await client.activeMatch(creds.agentId);
        } catch (err) {
          logger.warn?.(`[steamedclaw-plugin] live-match read failed: ${err?.message ?? err}`);
        }
        if (am && !am.ok && am.httpStatus === 429) {
          const wait =
            typeof am.retryAfterMs === 'number'
              ? `Wait retryAfterMs (${Math.ceil(am.retryAfterMs / 1000)}s) before calling queue_match again.`
              : 'Wait a few seconds before calling queue_match again.';
          return toolText({
            ...am,
            ok: false,
            error: 'rate_limited',
            httpStatus: 429,
            guidance: `The server is rate-limiting this agent. ${wait}`,
          });
        }
        if (am?.ok && am.matchId) {
          adoptMatch(am.matchId, am.gameId ?? null);
          bindCallerForMatch(ctx, { coordinator, receiver, rebind: true });
          DRIVER.paused = false;
          await fetchMatchFoundViaStatus(client, am.matchId, am.gameId ?? null, logger);
          const recovered = {
            ok: true,
            status: 'matched',
            matchId: DRIVER.matchId,
            game: DRIVER.matchGameId ?? gameId,
            recovered: true,
            guidance:
              'A match of yours was already live on the server (for example because this gateway restarted mid-match), so it was picked up again instead of queueing. Call get_turn; it blocks until your turn.',
          };
          const carried = takeCarryover(DRIVER.matchId);
          if (carried) {
            recovered.previousMatchResult = carried;
            recovered.guidance = `${carryoverGuidance(carried)} ${recovered.guidance}`;
          }
          const matchFound = takeMatchFound(DRIVER.matchId);
          if (matchFound) recovered.matchFound = matchFound;
          logger.info?.(
            `[steamedclaw-plugin] queue_match recovered live matchId=${DRIVER.matchId}`,
          );
          return toolText(recovered);
        }
      }

      // Fresh queue: the slot check above guaranteed no ACTIVE match, so clear any
      // prior (terminal) match — both the supervisor's per-match state and the
      // coordinator binding — so discovery + match_found pick up the NEW match and
      // get_turn reports no_match (not the finished game). This is what makes a
      // second sequential game ("play again") work.
      DRIVER.matchId = null;
      DRIVER.matchGameId = null;
      DRIVER.lastParkedSeq = -1;
      DRIVER.parkedVia = { ws: 0, http: 0 };
      // Bind the session (queue binds; no separate join tool) and clear any
      // leave_queue pause (symmetric resume). bindSession writes module-scope
      // state, so it does not require ownership — the binding is visible to the
      // owner's supervisor regardless of which instance binds.
      bindCallerForMatch(ctx, { coordinator, receiver, rebind: true });
      DRIVER.gameId = gameId;
      DRIVER.lane = resolvedLane;
      DRIVER.paused = false;

      let q;
      try {
        q = await client.queue(gameId, resolvedLane);
      } catch (err) {
        return toolText({ ok: false, error: 'queue_failed', message: String(err?.message ?? err) });
      }
      // #856: every server body rides the result whole. On a rejection that is
      // the server's hint and, on the game_limit_reached 429, the limit, the
      // window, the real wait and the claim line for the operator; the plugin
      // adds only a `guidance` line (never `message`, which is the server's).
      if (!q.ok) {
        const guidance = [];
        if (typeof q.retryAfterMs === 'number' && q.retryAfterMs > 0) {
          guidance.push(
            `Wait retryAfterMs (${Math.ceil(q.retryAfterMs / 1000)}s) before calling queue_match again.`,
          );
        }
        if (typeof q.messaging?.forOperator === 'string') {
          guidance.push(
            'Relay messaging.forOperator to your operator; messaging.toAgent is written for you.',
          );
        }
        return toolText(guidance.length > 0 ? { ...q, guidance: guidance.join(' ') } : q);
      }
      // A `matched` answer is already this match's first agent-facing result:
      // its match-found fields ride here, whole, and are NOT stored for a
      // second delivery on get_turn. The server pushes match_found over
      // /ws/agent while it forms the match, so that frame can land BEFORE this
      // reply and the WS handler will already have stored the same block for
      // the then-untracked match: drop that copy, or the next get_turn would
      // repeat what this result carries.
      if (q.status === 'matched' && q.matchId) {
        takeMatchFound(q.matchId);
        DRIVER.matchId = q.matchId;
        DRIVER.matchGameId = gameId;
        DRIVER.phase = 'queued'; //  supervisor's attach block opens the game socket
        return toolText({ ...q, ok: true, status: 'matched', matchId: q.matchId, game: gameId });
      }
      DRIVER.phase = 'queued';
      const status = q.status === 'already_queued' ? 'already_queued' : 'queued';
      return toolText({ ...q, ok: true, status, game: gameId });
    },
  });
}

// 1.0.13: leave_queue withdraws the agent's queue entry on the server as well
// as pausing the plugin. The pause alone left the server entry open, so the
// matchmaker could still pair the agent and the HTTP floor attached the match
// (reproduced by the registry's audit of 1.0.12). The server's answer rides
// whole under `queue`; a match that had already formed is recorded here the
// way the queued-phase discovery records one, and the supervisor attaches it.
const LEAVE_WITHDRAWN_GUIDANCE =
  'No queue entry is open for you on the server and no new match is picked up by this plugin. Call queue_match to play again.';
const LEAVE_ALREADY_MATCHED_GUIDANCE =
  'A match had already formed before the withdraw reached the server. It is attached and plays out: call get_turn. No new match is picked up after it until queue_match.';
const LEAVE_UNCONFIRMED_TAIL =
  'No new match is picked up by this plugin meanwhile; a match the server forms is still attached and played, since it is yours.';
const LEAVE_FORMING_GUIDANCE =
  'Your queue entry is withdrawn, but the server was forming a pairing as the withdraw landed. If that match completes it is attached and a heartbeat wakes you: call get_turn then. Otherwise nothing is queued and no new match is picked up until queue_match.';
const LEAVE_LOCAL_GUIDANCE =
  'Nothing was sent to the server (this plugin holds no registration). No new match is picked up by this plugin until queue_match.';
const LEAVE_NOTHING_QUEUED_GUIDANCE =
  'Nothing was queued. Your current match plays out with get_turn and take_turn; no new match is picked up after it until queue_match.';
const LEAVE_UNCONFIRMED_GUIDANCE =
  'The server did not confirm the withdraw, so your queue entry may still be open there. Call leave_queue again. ' +
  LEAVE_UNCONFIRMED_TAIL;

function makeLeaveQueueTool({ client, coordinator, logger }) {
  return (ctx) => ({
    name: 'leave_queue',
    description:
      'Stop SteamedClaw matchmaking. Withdraws your queue entry on the server (the game you queued for, or every entry when this plugin tracks none) and pauses pickups of new pairings in this plugin; an active match plays out to game_over normally. If a match had already formed, the result says so and that match is attached: call get_turn. Returns {ok, status:"queue_paused"|"already_paused", queue, guidance}: ok:true with queue the server\'s answer ({status:"left"|"not_queued"|"already_matched", removed?, matchId?}) or null when nothing could be sent; ok:false with error "leave_failed" when the server did not confirm the withdraw (the pause is in effect; call leave_queue again, after retryAfterMs when it is given). The pause itself is in-memory (a gateway restart resets to accepting). Resume by calling queue_match, which clears the pause. Example: leave_queue().',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const status = DRIVER.paused ? 'already_paused' : 'queue_paused';
      DRIVER.paused = true; //  first, so a push landing during the withdraw is not picked up
      const wasQueued = DRIVER.phase === 'queued' && !DRIVER.matchId;
      // A match in play, or one tracked and about to attach; the terminal
      // phase keeps the ended match's id and holds nothing.
      const holdsMatch =
        DRIVER.phase === 'in_match' || (DRIVER.phase === 'queued' && Boolean(DRIVER.matchId));
      const creds = readCredentials();
      if (!creds?.apiKey || typeof client.leaveQueue !== 'function') {
        return toolText({ ok: true, status, queue: null, guidance: LEAVE_LOCAL_GUIDANCE });
      }
      client.setApiKey(creds.apiKey);
      const scopedGame = wasQueued ? (DRIVER.gameId ?? undefined) : undefined;
      let queue;
      try {
        queue = await client.leaveQueue(scopedGame);
      } catch (err) {
        queue = { ok: false, error: 'leave_failed', message: String(err?.message ?? err) };
      }
      if (!queue?.ok) {
        // The entry may still be open on the server: a top-level failure, as
        // queue_match reports a failed queue call, with the pause noted. The
        // phase stays queued so the supervisor's discovery (and a push) keeps
        // watching: a pairing that forms is attached rather than orphaned,
        // and not_queued settles to idle.
        rateLimited(queue, logger);
        logger?.warn?.(`[steamedclaw-plugin] leave_queue: server withdraw failed: ${queue?.error}`);
        const guidance =
          queue?.httpStatus === 429
            ? `Wait retryAfterMs (${Math.ceil((queue.retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS) / 1000)}s) before calling leave_queue again. ${LEAVE_UNCONFIRMED_TAIL}`
            : LEAVE_UNCONFIRMED_GUIDANCE;
        return toolText({
          ok: false,
          error: 'leave_failed',
          ...(queue?.retryAfterMs !== undefined ? { retryAfterMs: queue.retryAfterMs } : {}),
          status,
          queue,
          guidance,
        });
      }
      // `left` proves no formation involves the entry (the server pulls a
      // reserved entry out of the live queue before counting). After a scoped
      // `not_queued`, GET /status is the server's source of truth for a match
      // that committed in the formation window: one read tells whether a
      // pairing beat the withdraw. A failed read leaves the phase queued; the
      // supervisor's discovery settles it.
      let matchId = queue.status === 'already_matched' ? (queue.matchId ?? null) : null;
      let statusRead = true;
      if (
        !matchId &&
        wasQueued &&
        scopedGame &&
        queue.status === 'not_queued' &&
        typeof client.matchmakingStatus === 'function'
      ) {
        let s = null;
        try {
          s = await client.matchmakingStatus(scopedGame);
        } catch (err) {
          logger?.warn?.(
            `[steamedclaw-plugin] leave_queue: status read failed: ${err?.message ?? err}`,
          );
        }
        if (rateLimited(s, logger) || !s?.ok) {
          statusRead = false;
        } else if (s.status === 'matched' && s.matchId) {
          matchId = s.matchId;
          storeMatchFound(s.matchId, matchFoundBlock(s));
        }
      }
      if (matchId) {
        // Only a scoped withdraw (nothing tracked) can answer this; the match
        // is recorded as the queued-phase discovery records one.
        DRIVER.matchId = matchId;
        if (queue.status === 'already_matched') {
          await fetchMatchFoundViaStatus(client, matchId, DRIVER.gameId ?? null, logger);
        }
        return toolText({
          ok: true,
          status,
          queue,
          matchId,
          guidance: LEAVE_ALREADY_MATCHED_GUIDANCE,
        });
      }
      if (!wasQueued) {
        return toolText({
          ok: true,
          status,
          queue,
          ...(holdsMatch ? { matchId: DRIVER.matchId } : {}),
          guidance: holdsMatch ? LEAVE_NOTHING_QUEUED_GUIDANCE : LEAVE_WITHDRAWN_GUIDANCE,
        });
      }
      if (queue.formationPending === true || !statusRead) {
        // The server was forming a pairing when the withdraw landed (or the
        // status read did not complete): the phase stays queued so the
        // supervisor's discovery attaches the match if it commits, or settles
        // to idle without a re-queue wake if it does not.
        return toolText({ ok: true, status, queue, guidance: LEAVE_FORMING_GUIDANCE });
      }
      // The queue entry is gone: the plugin tracks nothing, and the sessions
      // that waited for a match wait for nothing (get_turn answers not_joined,
      // not "still matchmaking"): the caller's and the one that queued.
      DRIVER.phase = 'idle';
      if (coordinator) {
        for (const key of new Set([ctx?.sessionKey, DRIVER.boundSessionKey])) {
          if (key) coordinator.clearSessionMatch(key);
        }
      }
      return toolText({ ok: true, status, queue, guidance: LEAVE_WITHDRAWN_GUIDANCE });
    },
  });
}

function makeInfoTools({ client }) {
  function requireReady() {
    const creds = readCredentials();
    if (!creds) return { ok: false, error: 'not_registered', message: NOT_REGISTERED_MESSAGE };
    client.setApiKey(creds.apiKey);
    return null;
  }
  return [
    () => ({
      name: 'list_games',
      description:
        'List the SteamedClaw game catalog. Returns {ok, games:[{id, name, description, ...}], error?}. Call once after registering to discover gameIds for queue_match / get_rules.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return toolText(await client.listGames());
      },
    }),
    () => ({
      name: 'get_rules',
      description:
        'Fetch the mechanical rules (action shapes, phases, edge cases) for a SteamedClaw game. Pass {gameId}. Returns {ok, gameId, version, content, error?}. Call once per game before your first turn — without the rules, SteamedClaw-specific games (werewolf-7, liars-dice) will reject every action.',
      parameters: {
        type: 'object',
        properties: { gameId: { type: 'string', description: 'Game id to fetch rules for.' } },
        required: ['gameId'],
        additionalProperties: false,
      },
      async execute(_callId, args) {
        const guard = requireReady();
        if (guard) return toolText(guard);
        return toolText(await client.getRules(args?.gameId));
      },
    }),
    () => ({
      name: 'get_strategy',
      description:
        'Optional — fetch human-curated strategy hints for a SteamedClaw game. Safe to skip; rules + your turn view are enough to play. Pass {gameId}. Returns {ok, gameId, version, content, error?}.',
      parameters: {
        type: 'object',
        properties: {
          gameId: { type: 'string', description: 'Game id to fetch strategy hints for.' },
        },
        required: ['gameId'],
        additionalProperties: false,
      },
      async execute(_callId, args) {
        const guard = requireReady();
        if (guard) return toolText(guard);
        return toolText(await client.getStrategy(args?.gameId));
      },
    }),
  ];
}

// ── tournament_status (#426): read-only tournament awareness ─────────────────
// Entry is deliberately NOT exposed: registration is an owner act on the portal
// (planning/063 §9.3 re-scope, 2026-08-05). The tool only reads. The list
// (#945) is the entry point and carries the agent's standing per card; the
// entered view adds the agent's own schedule (/my-schedule) and the
// standings. Every server shape passes through verbatim. Unregistered agents
// still get discovery: the list is public.

// A card in one of these statuses is over for everyone; the list is read
// for the rest (#945).
const TOURNAMENT_FINISHED_STATUSES = new Set(['completed', 'cancelled']);
// At most this many unfinished tournaments are reported per call (newest
// first), so one tool call cannot fan out into a request storm; the result
// says when more existed.
const TOURNAMENT_LIST_READ_CAP = 8;
// Before play starts there are no standings to read.
const TOURNAMENT_PRE_PLAY_STATUSES = new Set(['announced', 'registration']);

// Bind the caller's session for a match that is coming (queued, or adopted
// from a push or a server read): the coordinator binding (readable from any
// instance), the expectation flag that keeps get_turn on no_match until the
// attach, the driver's wake target, and the receive path. Every path that
// queues or adopts goes through here, so the bind contract lives in one
// place. `rebind` moves the wake target to the caller even when another
// session is bound; the queue tool always does, and so does an adoption
// (nothing is live at that moment, and the session told "a match is
// attached to this session" must be the one that gets the turns).
function bindCallerForMatch(ctx, { coordinator, receiver, rebind }) {
  const sessionKey = ctx?.sessionKey;
  coordinator.bindSession(sessionKey, ctx?.agentId);
  coordinator.clearSessionMatch(sessionKey); //  drop any finished-match binding
  coordinator.expectMatch(sessionKey); //  #922: a match is coming, get_turn says no_match
  if (sessionKey && (rebind || !DRIVER.boundSessionKey)) {
    DRIVER.boundSessionKey = sessionKey;
    DRIVER.boundAgentId = ctx?.agentId ?? DRIVER.boundAgentId;
  }
  if (DRIVER.matchGameId) DRIVER.gameId = DRIVER.matchGameId;
  receiver?.ensureStarted?.();
}

// #922: the guidance lines the status tool adds about the match it attached
// (mechanics only; who may enter is the server's `messaging`).
const TOURNAMENT_ADOPTED_GUIDANCE =
  'A match is now attached to this session. Call get_turn; it blocks until your turn.';
const TOURNAMENT_ADOPTED_CASUAL_GUIDANCE =
  'A casual match of yours was live on the server and is now attached to this session. Call get_turn; it blocks until your turn. A tournament match created while it is in progress is picked up when it ends.';
const TOURNAMENT_NO_MATCH_GUIDANCE =
  'No match is waiting for this session. Stop; the plugin wakes you when your tournament match is created. After a wake, call get_turn; after a gateway restart, call tournament_status again.';
const TOURNAMENT_ATTACHED_GUIDANCE =
  'A match is already attached to this session; play it with get_turn and take_turn. A tournament match created while it is in progress is picked up when it ends.';
const TOURNAMENT_ATTACHED_PAUSED_GUIDANCE =
  'A match is already attached to this session; play it with get_turn and take_turn. leave_queue is in effect, so the next match is not picked up until queue_match lifts the pause.';
const TOURNAMENT_ATTACHED_ELSEWHERE_GUIDANCE =
  'A match is attached to another session of this agent; its turns and wakes go there. Play it from that session, or call tournament_status again after it ends.';
const TOURNAMENT_PAUSED_GUIDANCE =
  'leave_queue is in effect, so no new match is picked up. Call queue_match to lift the pause; a tournament match that is waiting is then attached instead of queueing.';
const TOURNAMENT_QUEUED_GUIDANCE =
  'You are queued for a casual game; this call changed nothing. A tournament match that forms is picked up by the plugin as it arrives.';
const TOURNAMENT_ELIMINATED_GUIDANCE =
  'You are out of this tournament; it creates no further match for you.';
const TOURNAMENT_WAITLISTED_GUIDANCE =
  'You hold a waiting place in this tournament, not a seat. tournament_status shows your place; when you hold a seat the status reads entered.';
const TOURNAMENT_CLOSED_OUT_GUIDANCE =
  'The waitlist closed without a seat for you; this tournament creates no match for you.';
const TOURNAMENT_UNCHECKED_GUIDANCE =
  'The check for a waiting match did not complete. Call tournament_status again to attach one.';

// The agent's status in a tournament, from the /me body. Since the waitlist
// the server answers 200 for every visible tournament with {status, position,
// waitlistLength, entry, eliminatedStage, messaging}; a server from before it
// answered 404 for "not entered" (the transport maps that to null) and the
// bare entry record otherwise. Both shapes read into one status.
function entryStatusOf(body) {
  const none = {
    status: 'not_entered',
    entry: null,
    position: null,
    waitlistLength: null,
    eliminatedStage: null,
    messaging: null,
  };
  if (!body || typeof body !== 'object') return none;
  if (typeof body.status === 'string') {
    return {
      status: body.status,
      entry: body.entry && typeof body.entry === 'object' ? body.entry : null,
      position: body.position ?? null,
      waitlistLength: body.waitlistLength ?? null,
      eliminatedStage: body.eliminatedStage ?? null,
      messaging: body.messaging && typeof body.messaging === 'object' ? body.messaging : null,
    };
  }
  if (body.entryId) {
    return {
      ...none,
      status: body.withdrawnAt != null ? 'withdrawn' : 'entered',
      entry: body,
    };
  }
  return none;
}

function makeTournamentStatusTool({ client, server, sleep, coordinator, receiver, logger }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  // #922: attach the entered agent's pending tournament match to THIS session.
  // Tournament matches are created by the server with no queue request, and
  // the plugin can wake the model only through the OpenClaw session a tool
  // call ran in; until now only queue_match recorded one, so a fresh process
  // sent an entered agent to "queue". The decision table, in order:
  //   in_match            -> leave the live match alone (casual or tournament);
  //   paused (leave_queue) -> nothing: the pause's scope is "no new match";
  //   queued, no match     -> nothing: a casual queue is open on the server
  //                          and adopting over it would strand that entry (#828);
  //   queued, match tracked (a push landed before any bind, the #663 C state)
  //                        -> complete the adoption: the attach block joins
  //                          on the next tick;
  //   idle / terminal      -> read the agent's live match from the server
  //                          (the same read the supervisor's post-terminal
  //                          discovery uses, no game filter) and adopt it.
  // Best effort throughout: a failed or rate-limited read answers
  // `match: null` and never fails the status read. Repeated calls are no-ops.
  // The match-found block (#856) and the #663 carryover are left for the
  // agent's first get_turn, exactly as a WS or supervisor adoption leaves them.
  // Bind the caller for the tracked match and attach it NOW when a full-mode
  // owner exists (the WS handler's inline form), so "a match is attached to
  // this session" is true when the result is read and get_turn never spends
  // a tick on no_match. Without an owner (a non-full registration) the
  // supervisor's attach block completes it, as queue_match's adoption does.
  function completeAdoption(ctx, matchId, gameId, lane) {
    bindCallerForMatch(ctx, { coordinator, receiver, rebind: true });
    const owner = getOwnerCoordinator();
    if (owner && DRIVER.matchId === matchId && DRIVER.phase === 'queued') {
      owner.attachMatch(ctx.sessionKey, matchId, DRIVER.matchGameId ?? gameId ?? undefined);
      DRIVER.phase = 'in_match';
      receiver?.openGame?.(matchId);
    }
    logger?.info?.(`[steamedclaw-plugin] tournament_status attached matchId=${matchId}`);
    return {
      match: {
        matchId,
        gameId: gameId ?? null,
        ...(lane !== undefined ? { lane: lane ?? null } : {}),
        status: 'adopted',
      },
      guidance:
        lane && lane !== 'tournament'
          ? TOURNAMENT_ADOPTED_CASUAL_GUIDANCE
          : TOURNAMENT_ADOPTED_GUIDANCE,
    };
  }
  // The live match, as it stands: attached to this session (with the pause
  // caveat when leave_queue is in effect) or to another session of this
  // agent, in which case the caller is told where its turns go.
  function attachedResult(ctx) {
    const here = !DRIVER.boundSessionKey || DRIVER.boundSessionKey === ctx?.sessionKey;
    return {
      match: {
        matchId: DRIVER.matchId,
        gameId: DRIVER.matchGameId ?? DRIVER.gameId ?? null,
        status: 'attached',
        boundToThisSession: here,
      },
      guidance: !here
        ? TOURNAMENT_ATTACHED_ELSEWHERE_GUIDANCE
        : DRIVER.paused
          ? TOURNAMENT_ATTACHED_PAUSED_GUIDANCE
          : TOURNAMENT_ATTACHED_GUIDANCE,
    };
  }
  function noMatchWaiting(ctx) {
    DRIVER.boundSessionKey = ctx.sessionKey;
    DRIVER.boundAgentId = ctx.agentId ?? DRIVER.boundAgentId;
    return { match: null, guidance: TOURNAMENT_NO_MATCH_GUIDANCE };
  }
  async function adoptPendingTournamentMatch(ctx, creds, readWithRetry) {
    const sessionKey = ctx?.sessionKey;
    if (DRIVER.phase === 'in_match' && DRIVER.matchId) return attachedResult(ctx);
    if (!sessionKey || !coordinator) return { match: null };
    // A push that landed before any bind (the #663 C state) would be attached
    // by the supervisor's next tick regardless of a pause, so complete it and
    // say so; the pause check below applies only to a match not yet tracked.
    if (DRIVER.matchId && DRIVER.phase === 'queued') {
      return completeAdoption(ctx, DRIVER.matchId, DRIVER.matchGameId);
    }
    if (DRIVER.paused) return { match: null, guidance: TOURNAMENT_PAUSED_GUIDANCE };
    if (DRIVER.phase === 'queued' && !DRIVER.matchId) {
      return { match: null, guidance: TOURNAMENT_QUEUED_GUIDANCE };
    }
    // The read is not gated on an open round: a match created inside the
    // round window can still be live after the window closes, and an agent
    // restarting then must still find it.
    if (typeof client.activeMatch !== 'function') return { match: null };
    let am = null;
    try {
      am = await readWithRetry(() => client.activeMatch(creds.agentId));
    } catch (err) {
      logger?.warn?.(`[steamedclaw-plugin] live-match read failed: ${err?.message ?? err}`);
    }
    if (!am?.ok) return { match: null, guidance: TOURNAMENT_UNCHECKED_GUIDANCE };
    // Re-check after the await: a WS push may have adopted (or attached) first.
    if (DRIVER.phase === 'in_match' && DRIVER.matchId) return attachedResult(ctx);
    if (!am.matchId) return noMatchWaiting(ctx);
    if (DRIVER.matchId === am.matchId) {
      // Still tracked as queued: a WS adoption won the race; complete it.
      // Terminal: the server list still shows the match that just ended;
      // never re-adopt it (the supervisor's post-terminal discovery skips it
      // the same way).
      return DRIVER.phase === 'queued'
        ? completeAdoption(ctx, DRIVER.matchId, DRIVER.matchGameId)
        : noMatchWaiting(ctx);
    }
    adoptMatch(am.matchId, am.gameId ?? null);
    await fetchMatchFoundViaStatus(client, am.matchId, am.gameId ?? null, logger);
    return completeAdoption(ctx, am.matchId, am.gameId ?? null, am.lane);
  }

  function readFailure(res) {
    if (res.httpStatus === 429) {
      return {
        ok: false,
        error: 'rate_limited',
        retryAfterMs: res.retryAfterMs,
        message:
          'SteamedClaw is rate-limiting requests. Wait a few seconds, then call tournament_status again.',
      };
    }
    return { ok: false, error: 'tournament_lookup_failed', httpStatus: res.httpStatus };
  }

  return (ctx) => ({
    name: 'tournament_status',
    description: `Check SteamedClaw tournament status. Read-only: this tool does NOT enter or withdraw you from a tournament and does not play matches. No parameters; example call: tournament_status(). Reads every tournament that is not finished and your status in each. The result is the list under tournaments, in the server's order (newest first), one item per tournament: tournament (the card), state, messaging, and the fields for that state; the newest eight when more are unfinished, with listTruncated true and unfinishedCount. Nothing is summarized at the top: read each item. You may hold places in several tournaments at once (the server enforces its cap). A top-level state appears only for "none_active" (no unfinished tournament; the list is empty) or "not_registered" (you have no SteamedClaw registration; the list follows with the server's general messaging per tournament). An item's state is one of: "not_entered" (plus enterUrl, the portal entry page); "waitlisted" (you hold a waiting place: position and waitlistLength; this tournament attaches nothing); "entered" (entry (the record when /me was the source, null when the list card was), round (the open round holding your series: stage, roundNumber, window times; null when none is open for you), series (your series in that round, read from your own schedule: seriesId, opponent id and name, bestOfN, matchIds, outcome, bye, game wins; empty when none), next (your series in the next scheduled round, when drawn), nextPlanned, pool, and standing (your rank row)); "withdrawn"; "forfeited" (withdrawn after a forfeit); "eliminated" (a knockout stamped on your entry: eliminated {stage, at}; this tournament attaches nothing); "closed_out" (the waitlist closed without a seat for you). When the server sends messaging, messaging.toAgent is written for you and says how entry works for that tournament in your situation, and messaging.forOperator is written for your operator: relay it to them as is. The server decides eligibility and its messaging says what applies. Calling this tool connects your session to the plugin, and if you are entered anywhere and your tournament match exists it is attached: the result carries, at the top level, match (matchId, gameId, status "adopted" or "attached", or null) and a guidance line: stop and wait for the wake when no match is waiting, otherwise what to do next; then call get_turn and take_turn as usual, and the plugin wakes you when a round opens or the next game of your series is created. A match already in progress is left alone. Repeated calls are safe. Rounds are assigned by the server; do not call queue_match for tournament play. On error "rate_limited", wait a few seconds and call again.`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      // #922: record the session this call ran in. The coordinator binding is
      // recorded for every caller; the driver's wake target is taken only when
      // nothing is bound yet, so a read-only call never moves where wakes go
      // mid-match. Inert without credentials: the supervisor gates on them.
      const sessionKey = ctx?.sessionKey;
      if (sessionKey && coordinator) {
        coordinator.bindSession(sessionKey, ctx?.agentId);
        if (!DRIVER.boundSessionKey) {
          DRIVER.boundSessionKey = sessionKey;
          DRIVER.boundAgentId = ctx?.agentId ?? null;
        }
      }
      // Bounded 429 handling (feedback_http_client_handle_429): ONE floored,
      // capped wait + ONE retry PER TOOL CALL — never a loop, and waits never
      // stack across the up-to-many sub-reads (a second 429 after the budget is
      // spent surfaces immediately as a structured rate_limited result).
      let backoffSpent = false;
      const readWithRetry = async (fn) => {
        const first = await fn();
        if (first.ok || first.httpStatus !== 429 || backoffSpent) return first;
        backoffSpent = true;
        const ms = Math.min(
          Math.max(first.retryAfterMs ?? 0, DEFAULT_RATE_LIMIT_BACKOFF_MS),
          TOURNAMENT_RETRY_CAP_MS,
        );
        await wait(ms);
        return fn();
      };

      try {
        const creds = readCredentials();
        if (creds) {
          client.setApiKey(creds.apiKey);
          // #922: "connect this session" includes the receive path, so a
          // tournament push that arrives after this call can attach inline
          // and wake this session. Idempotent, single-flight.
          receiver?.ensureStarted?.();
        }

        // #945: the list is the entry point (several tournaments can be open at
        // once). Each card carries the caller's own standing (`me`, the #943
        // status) and the #903 messaging written for this caller, so the
        // agent's status needs no per-tournament read; a server from before
        // #945 carries neither, and its /me (either shape) is read per
        // unfinished tournament instead.
        const list = await readWithRetry(() => client.tournamentList('all'));
        if (!list.ok) return toolText(readFailure(list));
        const allUnfinished = (Array.isArray(list.tournaments) ? list.tournaments : []).filter(
          (c) => c && typeof c === 'object' && !TOURNAMENT_FINISHED_STATUSES.has(c.status),
        );
        const unfinished = allUnfinished.slice(0, TOURNAMENT_LIST_READ_CAP);
        const truncation =
          allUnfinished.length > unfinished.length
            ? { listTruncated: true, unfinishedCount: allUnfinished.length }
            : {};
        if (unfinished.length === 0) {
          return toolText({
            ok: true,
            state: 'none_active',
            tournaments: [],
            message: 'No SteamedClaw tournament is currently active or announced.',
          });
        }
        const cardMessaging = (c) =>
          c?.messaging && typeof c.messaging === 'object' ? { messaging: c.messaging } : {};
        if (!creds) {
          return toolText({
            ok: true,
            state: 'not_registered',
            tournaments: unfinished.map((c) => ({
              tournament: c,
              state: 'not_registered',
              ...cardMessaging(c),
            })),
            ...truncation,
          });
        }

        // The agent's own schedule (#927, #943): elimination stamp and its
        // current and next series. A 404 (a server without the route) reads
        // as null; a failed read degrades to null.
        const readMySchedule = async (id) =>
          typeof client.tournamentMySchedule === 'function'
            ? readWithRetry(() => client.tournamentMySchedule(id))
            : { ok: true, schedule: null };
        const eliminatedItem = (item, st, eliminated) => ({
          ...item,
          state: 'eliminated',
          entry: st.entry,
          eliminated,
          guidance: TOURNAMENT_ELIMINATED_GUIDANCE,
        });

        // One tournament's item: its card, the agent's state in it and, for an
        // entered agent, its round, series and standing. A rate-limited read
        // answers `{ failure }` so the whole call surfaces rate_limited, as
        // the single-tournament reads did.
        const statusItem = async (t) => {
          let st;
          if (t.me && typeof t.me === 'object' && typeof t.me.status === 'string') {
            st = entryStatusOf(t.me); //  the card's standing is the /me status shape minus the record
          } else {
            const me = await readWithRetry(() => client.tournamentMe(t.id));
            if (!me.ok) return { failure: readFailure(me) };
            st = entryStatusOf(me.entry);
          }
          // #943: a messaging block written for the agent's status (on /me)
          // beats the card's line for this caller, which beats nothing.
          const messaging = st.messaging ? { messaging: st.messaging } : cardMessaging(t);
          const item = { tournament: t, state: st.status, ...messaging };
          switch (st.status) {
            case 'not_entered':
              return { ...item, enterUrl: `${server}/tournaments/${t.number}/enter` };
            case 'waitlisted':
              // A waiting place, no entry: nothing to attach and no round
              // lookups (a waiting agent has no series).
              return {
                ...item,
                entry: null,
                position: st.position,
                waitlistLength: st.waitlistLength,
                guidance: TOURNAMENT_WAITLISTED_GUIDANCE,
              };
            case 'eliminated': {
              // Stamped by a pool cut or a bracket loss (#923): /me carries
              // the stage, the own schedule the stamp with its time. Report
              // and stop: no match is coming.
              const mine = await readMySchedule(t.id);
              if (!mine.ok && mine.httpStatus === 429) return { failure: readFailure(mine) };
              return eliminatedItem(
                item,
                st,
                mine.ok && mine.schedule?.eliminated
                  ? mine.schedule.eliminated
                  : { stage: st.eliminatedStage, at: null },
              );
            }
            case 'entered': {
              // The agent's own schedule is the source for its round and
              // series (#938 review): `current` is its series in an open
              // round, `next` its series in the next scheduled round, both
              // chosen by the server among the rounds that seat this agent. A
              // global timetable scan picked the wrong round once pool groups
              // opened at different times. Best-effort: a failed read nulls
              // these fields rather than failing the status (429s surface).
              const mine = await readMySchedule(t.id);
              if (!mine.ok && mine.httpStatus === 429) return { failure: readFailure(mine) };
              const sched =
                mine.ok && mine.schedule && typeof mine.schedule === 'object'
                  ? mine.schedule
                  : null;
              // A server from before the waitlist stamps elimination only here.
              if (sched?.eliminated) return eliminatedItem(item, st, sched.eliminated);
              const current =
                sched?.current && typeof sched.current === 'object' ? sched.current : null;
              let round = current
                ? {
                    stage: current.stage,
                    roundNumber: current.roundNumber,
                    status: 'open',
                    windowOpensAt: current.windowOpensAt ?? null,
                    windowClosesAt: current.windowClosesAt ?? null,
                  }
                : null;
              if (
                !current &&
                t.format === 'shootout' &&
                typeof client.tournamentSchedule === 'function'
              ) {
                // A table format seats players in tables, never in a series,
                // so the own schedule has no `current`; its rounds are
                // poolless, so the timetable's single open shootout round is
                // every entrant's round, with its window.
                const timetable = await readWithRetry(() => client.tournamentSchedule(t.id));
                if (!timetable.ok && timetable.httpStatus === 429) {
                  return { failure: readFailure(timetable) };
                }
                const open =
                  timetable.ok && Array.isArray(timetable.rounds)
                    ? timetable.rounds.filter((r) => r?.status === 'open' && r.stage === 'shootout')
                    : [];
                if (open.length === 1) {
                  round = {
                    stage: open[0].stage,
                    roundNumber: open[0].roundNumber,
                    status: 'open',
                    windowOpensAt: open[0].windowOpensAt ?? null,
                    windowClosesAt: open[0].windowClosesAt ?? null,
                  };
                }
              }
              const series = current
                ? [
                    {
                      seriesId: current.seriesId,
                      opponentAgentId: current.opponentAgentId ?? null,
                      opponentName: current.opponentAgentName ?? null,
                      bestOfN: current.bestOfN,
                      matchIds: Array.isArray(current.matchIds) ? current.matchIds : [],
                      outcome: current.outcome ?? null,
                      bye: current.bye === true,
                      myGameWins: current.myGameWins ?? null,
                      opponentGameWins: current.opponentGameWins ?? null,
                    },
                  ]
                : [];
              const stand = TOURNAMENT_PRE_PLAY_STATUSES.has(t.status)
                ? { ok: true, standings: [] }
                : await readWithRetry(() => client.tournamentStandings(t.id));
              if (!stand.ok && stand.httpStatus === 429) return { failure: readFailure(stand) };
              const rows = stand.ok ? stand.standings : [];
              const standing = rows.find((row) => row?.agentId === creds.agentId) ?? null;
              return {
                ...item,
                entry: st.entry,
                round,
                series,
                next: sched?.next ?? null,
                nextPlanned: sched?.nextPlanned ?? null,
                pool: sched?.pool ?? null,
                standing,
              };
            }
            case 'closed_out':
              return { ...item, entry: st.entry, guidance: TOURNAMENT_CLOSED_OUT_GUIDANCE };
            default:
              // withdrawn, forfeited, or a status this version does not know:
              // the agent no longer plays here (or nothing says it does), so
              // report and stop.
              return { ...item, entry: st.entry };
          }
        };

        const items = [];
        for (const t of unfinished) {
          const item = await statusItem(t);
          if (item.failure) return toolText(item.failure);
          items.push(item);
        }
        // #922: attach the pending tournament match to this session, if any.
        // Last, after every read that can return rate_limited early, so an
        // adoption is never performed and then dropped from the result. Only
        // an entered agent has a match coming; the match itself is the
        // agent's, whichever tournament created it.
        const adoption = items.some((it) => it.state === 'entered')
          ? await adoptPendingTournamentMatch(ctx, creds, readWithRetry)
          : {};

        // The list in the server's order, one item per unfinished tournament,
        // each with its own state and messaging (owner, #948: no main
        // tournament is picked, ranked or summarized at the top).
        return toolText({
          ok: true,
          tournaments: items,
          ...truncation,
          ...adoption,
        });
      } catch (err) {
        // A transport-level failure (timeout, connection refused) rejects the
        // underlying request — surface it structured instead of throwing raw.
        return toolText({
          ok: false,
          error: 'tournament_status_failed',
          message: String(err?.message ?? err),
        });
      }
    },
  });
}

// ── Plugin registration ──────────────────────────────────────────────────────
export function registerPlugin(api, opts = {}) {
  const cfg = { ...(api.pluginConfig ?? {}) }; //  local copy — never mutate api.pluginConfig
  const logger = api.logger ?? { info() {}, warn() {}, error() {} };

  // Server resolution: default to production, overridable to any operator value.
  const server =
    typeof cfg.server === 'string' && cfg.server.length > 0 ? cfg.server : DEFAULT_SERVER;

  // opts.client lets tests inject a stub transport; production builds the real one.
  const client = opts.client ?? makeClient({ server, apiKey: readCredentials()?.apiKey });

  // Coordinator owns get_turn + take_turn + module-scope match state. httpSubmit
  // threaded via opts — NEVER stashed on `api` (Proxy-shadowed; 072i).
  const httpSubmit = ({ matchId, sequence, action }) =>
    client.submitAction(matchId, sequence, action);
  const { coordinator } = registerCoordinator(api, {
    httpSubmit,
    nextTurnBlockMs: cfg.nextTurnBlockMs ?? DEFAULT_NEXT_TURN_BLOCK_MS,
  });

  // WS Leg-1 receiver (072j). wsEnabled:false forces the pure HTTP pull floor.
  const wsEnabled = cfg.wsEnabled !== false && opts.wsEnabled !== false;
  const receiver = wsEnabled
    ? makeWsReceiver({ api, server, logger, makeWebSocket: opts.makeWebSocket })
    : null;

  api.registerTool(makeRegisterTool({ client, server, logger, receiver }), {
    name: 'register_agent',
  });
  api.registerTool(makeQueueTool({ client, server, cfg, logger, receiver, coordinator }), {
    name: 'queue_match',
  });
  api.registerTool(makeLeaveQueueTool({ client, coordinator, logger }), { name: 'leave_queue' });
  const infoFactories = makeInfoTools({ client });
  api.registerTool(infoFactories[0], { name: 'list_games' });
  api.registerTool(infoFactories[1], { name: 'get_rules' });
  api.registerTool(infoFactories[2], { name: 'get_strategy' });
  // opts.sleep lets tests observe the 429 backoff without real delays.
  api.registerTool(
    makeTournamentStatusTool({ client, server, sleep: opts.sleep, coordinator, receiver, logger }),
    { name: 'tournament_status' },
  );

  // Supervisor service — full mode only.
  if (api.registrationMode === 'full') {
    api.registerService(makeSupervisorService(api, client, server, cfg, logger, receiver));
  }
  return { client, receiver, server };
}

export default definePluginEntry({
  id: 'steamedclaw-plugin',
  name: 'SteamedClaw',
  description:
    'SteamedClaw: a standalone WS Leg-1 plugin. The agent calls register_agent → queue_match → get_turn (blocking pull) / take_turn (submit) to play hands-free. Defaults to production (https://steamedclaw.com).',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      server: {
        type: 'string',
        description:
          'SteamedClaw server base URL. Defaults to production (https://steamedclaw.com). Operators may override it with another server URL.',
        default: DEFAULT_SERVER,
      },
      defaultLane: {
        type: 'string',
        enum: LANES,
        default: DEFAULT_LANE,
        description:
          'Default match lane for queue calls when none is passed. "fast" (the default: short per-turn window, responsive WS play) or "standard" (long per-turn window; for heartbeat-paced agents).',
      },
      maxSimultaneousGames: {
        type: 'number',
        default: MAX_SIMULTANEOUS_GAMES,
        description:
          'Concurrent games allowed. v1 accepts 1 only; any other value rejects queue calls.',
      },
      allowedGames: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional allowlist of gameIds this plugin may queue for. Omit to allow all published games.',
      },
      nextTurnBlockMs: {
        type: 'number',
        description:
          'How long get_turn blocks for a turn, and how long take_turn waits for a simultaneous round to resolve (ms). Default 20000, capped at 25000; 0 disables both waits.',
      },
      wsEnabled: {
        type: 'boolean',
        description:
          'WS Leg-1 receive path (/ws/agent + /ws/game). Default true; false forces the HTTP polling fallback.',
      },
      tickMs: { type: 'number', description: 'Supervisor poll interval (ms). Default 4000.' },
    },
  },
  register(api) {
    registerPlugin(api);
  },
});
