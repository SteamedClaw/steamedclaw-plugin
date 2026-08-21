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
// tournament_status 429 backoff cap: the wait is retry-after-honoring but
// bounded — a tool call must return in seconds, not sit on a huge Retry-After.
const TOURNAMENT_RETRY_CAP_MS = 15000;
const DEFAULT_NEXT_TURN_BLOCK_MS = 20000; //  blocking get_turn budget
// HTTP safety-net cadence while the WS path is healthy: every Nth tick still
// runs discovery/state polling to catch events lost outside the 60s missed-event
// buffer (agent socket down >60s, lost game_over).
const SAFETY_NET_EVERY_TICKS = 15; //  ≈60s at the 4s tick
// Re-wake cadence while a parked turn sits unconsumed. A single park-time wake is
// lossy (absorbed when the agent is mid-turn), so we retry; but retrying faster
// than ~64s trips OpenClaw's heartbeat FLOOD GUARD (≥5 runs within 60s defers
// further wakes — verified in heartbeat-runner source).
const REWAKE_EVERY_TICKS = 16; //  ≈64s at the 4s tick

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
  receiverStarted: false,
  registerInFlight: null,
};

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
  DRIVER.receiverStarted = false;
  DRIVER.registerInFlight = null;
  __resetReceiver();
}

function toolText(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// On a 429, pause the supervisor's polling so it stops adding rate-limit
// pressure. Honors retryAfterMs, floored at DEFAULT_RATE_LIMIT_BACKOFF_MS.
function rateLimited(res, logger) {
  if (res && res.httpStatus === 429) {
    const wait = Math.max(res.retryAfterMs ?? 0, DEFAULT_RATE_LIMIT_BACKOFF_MS);
    DRIVER.backoffUntil = Date.now() + wait;
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

function turnEventText(sequence) {
  return `SteamedClaw: it is YOUR TURN (match ${DRIVER.matchId}, sequence ${sequence}). Call get_turn now to get the turn, then take_turn with the returned turnToken.`;
}

// Park one turn (from either path) exactly once, then wake the agent unless a
// blocked get_turn already consumed the notify (woken > 0 ⇒ agent is awake,
// mid-tool-call). The sequence is CLAIMED synchronously (so a concurrent WS/HTTP
// park of the same turn dedupes) but ROLLED BACK if the park fails — otherwise a
// failed enqueue would suppress every redelivery of that turn and lose it.
async function parkTurn(owner, { sequence, view }, via, { api, logger }) {
  if (typeof sequence !== 'number' || sequence <= DRIVER.lastParkedSeq) return false;
  const prevSeq = DRIVER.lastParkedSeq;
  DRIVER.lastParkedSeq = sequence; //  claim before the await — concurrent parks dedupe here
  try {
    const { woken } = await owner.enqueueTurn({
      matchId: DRIVER.matchId,
      sequence,
      view,
      phase: 'play',
      instructions: TURN_INSTRUCTIONS,
    });
    DRIVER.turnsParked += 1;
    DRIVER.parkedVia[via] += 1;
    logger?.info?.(`[steamedclaw-plugin] parked turn seq=${sequence} via=${via} woken=${woken}`);
    if (!woken) wakeAgent(api, 'steamedclaw-turn', logger, turnEventText(sequence));
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
    wakeAgent(
      api,
      'steamedclaw-game-over',
      logger,
      `SteamedClaw: the match (${DRIVER.matchId}) has ended. Call get_turn to confirm, then stop.`,
    );
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

// Build the WS receiver adapter with the supervisor's event handlers bound in.
// makeWebSocket is injectable for tests.
export function makeWsReceiver({ api, server, logger, makeWebSocket }) {
  function handleMatchFound(frame) {
    try {
      if (DRIVER.paused) return; //  leave_queue: ignore NEW pairings
      if (!frame?.matchId) return;
      if (frame.matchId === DRIVER.matchId) return; //  duplicate push for the tracked match
      // Single-match v1: only a LIVE match occupies the slot. A terminal one
      // does not (#663): a tournament Bo-N series delivers game 2 (and the
      // next round's game) as a fresh match_found with no re-queue — accept it
      // and reset the per-match state, exactly as a fresh queue_match would.
      if (DRIVER.matchId && DRIVER.phase !== 'terminal') return; //  live match — ignore extras
      adoptMatch(frame.matchId, frame.gameId ?? DRIVER.gameId);
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
      // The WS game_over frame carries the full outcome (results/reason/replayUrl)
      // plus the server messaging envelope (#514) — capture all of it so get_turn
      // surfaces results/reason/replayUrl (#510) and forwards messaging verbatim (#517).
      // `nextGameAssigned` (#663) is the structured don't-re-queue signal the
      // game_over guidance keys on; absent on non-tournament frames and pre-#663 servers.
      finishMatch(owner, { closeGame }, { api, logger }, 'ws', {
        results: frame?.results,
        replayUrl: frame?.replayUrl,
        reason: frame?.reason,
        messaging: frame?.messaging,
        nextGameAssigned: frame?.nextGameAssigned,
      });
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
    if (DRIVER.phase === 'terminal') {
      // Game over — idle, but do NOT go blind (#663): a tournament Bo-N series
      // (or the next round) creates this agent's next match server-side with
      // no re-queue, and its match_found push can even race the game_over
      // frame (observed live: game 2's push landed 1ms before game 1's
      // game_over) — in that order handleMatchFound's terminal-aware guard
      // never sees it, and /ws/agent replays only frames that were never
      // delivered. On the safety cadence, discover an unfinished match over
      // HTTP and adopt it; the attach block below opens it this same tick.
      if (!safety || DRIVER.paused || !DRIVER.boundSessionKey) return 'idle';
      if (DRIVER.backoffUntil && Date.now() < DRIVER.backoffUntil) return 'idle';
      if (typeof client.activeMatch !== 'function') return 'idle';
      const terminalCreds = readCredentials();
      if (!terminalCreds?.apiKey) return 'idle';
      client.setApiKey(terminalCreds.apiKey);
      // No gameId filter: the next tournament game is not tied to whatever the
      // agent last QUEUED (it may never have queued this game at all).
      const am = await client.activeMatch(terminalCreds.agentId);
      if (rateLimited(am, logger)) return 'idle';
      // Re-check after the await: a WS match_found may have adopted first.
      if (DRIVER.phase !== 'terminal') return 'continue';
      if (!am.ok || !am.matchId || am.matchId === DRIVER.matchId) return 'idle';
      adoptMatch(am.matchId, am.gameId ?? null);
      logger.info?.(
        `[steamedclaw-plugin] post-terminal discovery adopted matchId=${DRIVER.matchId}`,
      );
      //  fall through — the attach block below binds + opens the game socket now
    }

    const owner = getOwnerCoordinator();
    if (!owner) return 'continue'; //  no full-mode owner yet
    if (DRIVER.backoffUntil && Date.now() < DRIVER.backoffUntil) return 'continue';

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
        } else {
          const s = await client.matchmakingStatus(resolvedGameId);
          if (rateLimited(s, logger)) return 'continue';
          if (s.ok && s.status === 'matched' && s.matchId) {
            DRIVER.matchId = s.matchId;
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

    // Re-wake: while a parked turn sits unconsumed, re-fire the wake on a slow
    // cadence (the park-time wake is lost if the agent was mid-turn). Stops on its
    // own: the pull marks the token used, game-over flips the phase.
    if (DRIVER.phase === 'in_match' && api && DRIVER.tickCount % REWAKE_EVERY_TICKS === 0) {
      const cur = owner.nextTurn(DRIVER.boundSessionKey);
      if (cur.status === 'your_turn') {
        wakeAgent(api, 'steamedclaw-turn-rewake', logger, turnEventText(cur.sequence));
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
      // getState already fetched the terminal outcome — capture results/replayUrl
      // so the opponent-ended get_turn surfaces them (#510), plus the server
      // messaging envelope (#514) to forward verbatim (#517), plus the #663
      // nextGameAssigned don't-re-queue signal. reason is WS-only.
      finishMatch(owner, receiver, { api, logger }, 'http', {
        results: st.results,
        replayUrl: st.replayUrl,
        messaging: st.messaging,
        nextGameAssigned: st.nextGameAssigned,
      });
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
    description: `Register this agent with the SteamedClaw server. Pass {name, model?} — name is your agent identity (1-64 chars, letters/numbers/hyphens/spaces/underscores, immutable, unique across SteamedClaw); model is optional (your LLM model id for stats). Use your SOUL-defined identity for name. Returns {ok, id?, name?, claimUrl?, verificationCode?, operatorNotice?, error?, message?}. On ok:true surface the operatorNotice in your next message so the operator can claim this agent. On error='already_registered' credentials exist — skip and call queue_match. On error='name_taken' pick a different name. After registering, call queue_match to play.`,
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
            const codeSuffix = r.verificationCode
              ? ` (verification code: ${r.verificationCode})`
              : '';
            const operatorNotice = r.claimUrl
              ? `I registered on SteamedClaw. Link me to your operator account at ${r.claimUrl}${codeSuffix}.`
              : '';
            return {
              ok: true,
              id: r.id,
              name,
              model: typeof model === 'string' && model.length > 0 ? model : null,
              // H1 (087 security review): the raw apiKey is deliberately NOT returned
              // into the LLM tool result. The plugin already persisted it
              // (writeCredentials) and set it on the client (setApiKey) above, so the
              // agent never needs it in-context. claimUrl/verificationCode are the
              // operator-claim surface (non-secret) and also live inside operatorNotice.
              claimUrl: r.claimUrl || null,
              verificationCode: r.verificationCode || null,
              operatorNotice,
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
      return toolText(payload);
    },
  });
}

function makeQueueTool({ client, server, cfg, logger, receiver, coordinator }) {
  const allowedGames = Array.isArray(cfg.allowedGames) ? cfg.allowedGames : null;
  const maxGames = cfg.maxSimultaneousGames ?? MAX_SIMULTANEOUS_GAMES;
  return (ctx) => ({
    name: 'queue_match',
    description: `Enter SteamedClaw matchmaking for a game. Pass {gameId, lane?} — gameId is a SteamedClaw game id (call list_games to discover ids); optional lane selects the per-turn time budget — "fast" (the default: short per-turn window, best for responsive WebSocket play) or "standard" (long per-turn window, for agents on a slow heartbeat/poll cadence) — omit for the default ("${DEFAULT_LANE}"). This binds your session and holds the queue. Returns {ok, status, matchId?, game?, position?, error?}. On status="matched" a match formed — call get_turn (it blocks until your turn). On status="queued" no pairing yet — call get_turn and it will wake/resolve when a match is found; do NOT spam queue. On status="already_queued" you are already in queue. On error="already_in_match" finish the current match first. On error="game_not_allowed" the operator restricted which games this plugin may play. On error="not_registered" call register_agent first. After a match, loop get_turn / take_turn to game-over.`,
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
        coordinator.bindSession(ctx?.sessionKey, ctx?.agentId);
        coordinator.clearSessionMatch(ctx?.sessionKey); //  drop any finished-match binding
        DRIVER.boundSessionKey = ctx?.sessionKey ?? DRIVER.boundSessionKey;
        DRIVER.boundAgentId = ctx?.agentId ?? DRIVER.boundAgentId;
        if (DRIVER.matchGameId) DRIVER.gameId = DRIVER.matchGameId;
        DRIVER.phase = 'queued'; //  the attach block completes the join
        DRIVER.paused = false;
        receiver?.ensureStarted?.();
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
        return toolText(adopted);
      }

      const resolvedLane = lane ?? cfg.defaultLane ?? DEFAULT_LANE;
      client.setApiKey(creds.apiKey);
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
      coordinator.bindSession(ctx?.sessionKey, ctx?.agentId);
      coordinator.clearSessionMatch(ctx?.sessionKey); //  drop any finished-match binding
      DRIVER.boundSessionKey = ctx?.sessionKey ?? DRIVER.boundSessionKey;
      DRIVER.boundAgentId = ctx?.agentId ?? DRIVER.boundAgentId;
      DRIVER.gameId = gameId;
      DRIVER.lane = resolvedLane;
      DRIVER.paused = false;
      receiver?.ensureStarted?.();

      let q;
      try {
        q = await client.queue(gameId, resolvedLane);
      } catch (err) {
        return toolText({ ok: false, error: 'queue_failed', message: String(err?.message ?? err) });
      }
      if (!q.ok) return toolText({ ok: false, error: q.error, httpStatus: q.httpStatus });
      if (q.status === 'matched' && q.matchId) {
        DRIVER.matchId = q.matchId;
        DRIVER.matchGameId = gameId;
        DRIVER.phase = 'queued'; //  supervisor's attach block opens the game socket
        return toolText({ ok: true, status: 'matched', matchId: q.matchId, game: gameId });
      }
      if (q.status === 'already_queued') {
        DRIVER.phase = 'queued';
        return toolText({ ok: true, status: 'already_queued', game: gameId, position: q.position });
      }
      DRIVER.phase = 'queued';
      return toolText({ ok: true, status: 'queued', game: gameId, position: q.position });
    },
  });
}

function makeLeaveQueueTool() {
  return () => ({
    name: 'leave_queue',
    description:
      'Pause SteamedClaw matchmaking. After this call the plugin stops picking up NEW match_found pairings — an already-active match still plays out to game_over normally. The pause is in-memory only (a container restart resets to accepting). Resume by calling queue_match again — that clears the pause. Returns {ok:true, status:"queue_paused"} (or "already_paused").',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if (DRIVER.paused) return toolText({ ok: true, status: 'already_paused' });
      DRIVER.paused = true;
      return toolText({ ok: true, status: 'queue_paused' });
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
// (planning/063 §9.3 re-scope, 2026-08-05). The tool only reads. The entered
// view is assembled from the public reads (/schedule, /series, /standings)
// because /me carries entry fields only; every server shape passes through
// verbatim. Unregistered agents still get discovery — /active is public.

// Mirrors the server's LIVE_STAGE_ORDER: when rounds of several stages are
// open, the later stage is the one the agent is playing in.
const TOURNAMENT_STAGE_ORDER = { qualifying: 0, seeding: 1, bracket: 2, shootout: 3 };
// #646: rounds within a pool run sequentially and the schedule aggregates to
// one row per stage-round, so normally exactly ONE open row exists and the
// agent has at most ONE series in it. The scan cap stays as a guard so an
// unexpected schedule shape can't turn one tool call into a request storm.
const TOURNAMENT_POOL_SCAN_CAP = 16;

function makeTournamentStatusTool({ client, server, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

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

  return () => ({
    name: 'tournament_status',
    description: `Check SteamedClaw tournament status — read-only awareness. No parameters; example call: tournament_status(). Returns {ok, state, ...} where state is one of: "none_active" — no tournament running; "not_registered" — a tournament exists (summary included) but you have no SteamedClaw registration (entry requires a registered agent your owner has claimed); "not_entered" — tournament summary + enterUrl: entry happens ONLY on the owner portal, so tell your OWNER to visit enterUrl (you cannot enter); "entered" — your entry plus round (stage, roundNumber, window times), series (your matchup this round — normally exactly one: seriesId, opponent id and name, bestOfN, matchIds, outcome; empty in table formats; rounds run one at a time, so you play one match at a time), and standing (your rank row); "withdrawn" — you were entered but withdrew. This tool does NOT enter or withdraw you from tournaments and does not play matches — entry is an owner action on the portal, and tournament matches arrive automatically as normal match_found pushes (play them via get_turn and take_turn as usual). On error:"rate_limited", wait a few seconds and call again.`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
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
        if (creds) client.setApiKey(creds.apiKey);

        const active = await readWithRetry(() => client.tournamentActive());
        if (!active.ok) return toolText(readFailure(active));
        if (!active.tournament) {
          return toolText({
            ok: true,
            state: 'none_active',
            message: 'No SteamedClaw tournament is currently active or announced.',
          });
        }
        const t = active.tournament;

        if (!creds) {
          return toolText({
            ok: true,
            state: 'not_registered',
            tournament: t,
            note: 'A tournament exists but you are not registered on SteamedClaw. Entering requires a registered agent that your owner has CLAIMED, and entry itself is done by the owner on the portal. Call register_agent, surface the claim link to your owner, and tell them about this tournament.',
          });
        }

        const me = await readWithRetry(() => client.tournamentMe(t.id));
        if (!me.ok) return toolText(readFailure(me));
        if (!me.entry) {
          return toolText({
            ok: true,
            state: 'not_entered',
            tournament: t,
            enterUrl: `${server}/tournaments/${t.number}/enter`,
            note: 'You are not entered. Entry is owner-only: your OWNER enters you on the SteamedClaw portal at the enterUrl — you cannot enter yourself. Tell your owner about this tournament.',
          });
        }
        if (me.entry.withdrawnAt != null) {
          // Withdrawn entries ride the same /me response; round/opponent lookups
          // would mislead (the agent no longer plays), so report and stop.
          return toolText({ ok: true, state: 'withdrawn', tournament: t, entry: me.entry });
        }

        // Entered: best-effort assembly — a failed sub-read nulls its field
        // rather than failing the whole status (429s still surface, above).
        //
        // Round attribution (#646): rounds run sequentially and the schedule
        // aggregates to one row per stage-round, so the latest open stage
        // normally has exactly ONE open row — it IS the agent's round. The
        // /series read returns the union across the stage-round's pools;
        // filtering by our own agent id finds the agent's series (at most one
        // per round; none in a bye round of an odd pool). The capped loop
        // stays as a guard against an unexpected multi-open-row shape.
        let round = null;
        let mySeriesRows = null;
        const sched = await readWithRetry(() => client.tournamentSchedule(t.id));
        if (!sched.ok && sched.httpStatus === 429) return toolText(readFailure(sched));
        if (sched.ok) {
          const open = sched.rounds.filter((r) => r?.status === 'open');
          if (open.length > 0) {
            const topStage = open.reduce((best, r) =>
              (TOURNAMENT_STAGE_ORDER[r.stage] ?? -1) > (TOURNAMENT_STAGE_ORDER[best.stage] ?? -1)
                ? r
                : best,
            ).stage;
            const candidates = open
              .filter((r) => r.stage === topStage)
              .sort((a, b) => a.roundNumber - b.roundNumber)
              .slice(0, TOURNAMENT_POOL_SCAN_CAP);
            if (candidates.length === 1) {
              // Exactly one open round: the agent's round even when its series
              // list is empty (table formats put seats in tables, not series;
              // an odd pool's bye round leaves the agent without a series).
              round = candidates[0];
            }
            for (const r of candidates) {
              const pr = await readWithRetry(() =>
                client.tournamentSeries(t.id, r.roundNumber, r.stage, r.poolStage),
              );
              if (!pr.ok && pr.httpStatus === 429) return toolText(readFailure(pr));
              if (!pr.ok) break; //  best-effort: stop the scan on a hard failure
              const mine = pr.series.filter(
                (p) => p?.agentAId === creds.agentId || p?.agentBId === creds.agentId,
              );
              if (mine.length > 0) {
                round = r;
                mySeriesRows = mine;
                break;
              }
            }
          }
        }

        const stand = await readWithRetry(() => client.tournamentStandings(t.id));
        if (!stand.ok && stand.httpStatus === 429) return toolText(readFailure(stand));
        const rows = stand.ok ? stand.standings : [];
        const standing = rows.find((row) => row?.agentId === creds.agentId) ?? null;

        const series = (mySeriesRows ?? []).map((p) => {
          const opponentAgentId = p.agentAId === creds.agentId ? p.agentBId : p.agentAId;
          return {
            seriesId: p.seriesId,
            opponentAgentId,
            // Display name resolved from the standings rows (the series
            // payload carries ids only); null when the opponent has no row.
            opponentName: rows.find((row) => row?.agentId === opponentAgentId)?.agentName ?? null,
            bestOfN: p.bestOfN,
            matchIds: p.matchIds,
            outcome: p.outcome,
          };
        });

        return toolText({
          ok: true,
          state: 'entered',
          tournament: t,
          entry: me.entry,
          round,
          series,
          standing,
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
  api.registerTool(makeLeaveQueueTool(), { name: 'leave_queue' });
  const infoFactories = makeInfoTools({ client });
  api.registerTool(infoFactories[0], { name: 'list_games' });
  api.registerTool(infoFactories[1], { name: 'get_rules' });
  api.registerTool(infoFactories[2], { name: 'get_strategy' });
  // opts.sleep lets tests observe the 429 backoff without real delays.
  api.registerTool(makeTournamentStatusTool({ client, server, sleep: opts.sleep }), {
    name: 'tournament_status',
  });

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
        description: 'How long get_turn blocks for a turn (ms). Default 20000, capped at 25000.',
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
