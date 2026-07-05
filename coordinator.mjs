// Coordinator — module-scope match state + parked-turn token model (072j/072k).
//
// Folded from the live-validated coordinator POC (tools/steamedclaw-coordinator-
// poc/coordinator.mjs). Owns the cross-component protocol state at MODULE scope
// (so every register() instance of this resolved file shares one object — the
// instance-split guarantee the WS receiver also relies on) and the v1 PULL
// delivery contract: each turn is PARKED in module scope with a single-use
// token; the agent fetches it via the BLOCKING get_turn tool
// and submits via take_turn (token-validated).
//
// DELIVERY: v1 is PULL + heartbeat WAKE. Coordinator-side context injection
// (enqueueNextTurnInjection) was abandoned (072i blocker: the plugin api Proxy is
// closed after register() and the injection method is not lateCallable), so the
// driver wakes the agent with a content-carrying heartbeat instead (entry.mjs).
//
// Verified SDK shapes used here (memory reference_openclaw_plugin_sdk_shapes):
//   - factory tool = a bare function (ctx) => tool, registered via
//     api.registerTool(fn, { name }); ctx carries the trusted sessionKey/agentId
//   - tool execute(toolCallId, params) — params is the SECOND argument

// Blocking get_turn (072j): hard ceiling on how long the tool may hold its call
// waiting for a turn. The leg1 probe verified execute() survives ≥30s uncut
// (072i §11); we cap below that. The shipped DEFAULT (20s) lives in entry.mjs,
// which threads the config value in.
const MAX_NEXT_TURN_BLOCK_MS = 25000;

// Discussion receive-buffer cap (#538): oldest entries are dropped past this.
// Murder-mystery caps messages at 8/agent/round server-side; werewolf has no
// per-agent cap, so a chatty 7-player table CAN exceed this — oldest-drop is
// the intended behavior (recent talk matters most).
const MAX_BUFFERED_MESSAGES = 100;
// get_turn results resend only the newest tail of the buffer — a full-buffer
// resend on every poll of a chatty werewolf game is a real token cost.
const MAX_RESULT_MESSAGES = 30;

// ── Module-scope shared protocol state (REQUIRED at module scope) ────────────
const SHARED = {
  bindings: new Map(), //  sessionKey -> { agentId, gameId, matchId }
  matchToSession: new Map(), //  matchId    -> sessionKey
  tokens: new Map(), //  turnToken  -> { sessionKey, matchId, sequence, viewHash, used, attempts, packet, idempotencyKey }
  currentTokenByMatch: new Map(), //  matchId -> turnToken (newest; older are stale)
  transportByMatch: new Map(), //  matchId -> { isOpen(): bool, submit(frame): Promise<ack> } — dormant Leg-2 seam
  terminalMatches: new Set(), //  matchId set after game_over
  terminalOutcomes: new Map(), //  matchId -> { results?, replayUrl?, reason? } captured at game_over (#510)
  messagesByMatch: new Map(), //  matchId -> [{from, text, to}] — discussion receive buffer (#538)
  pending: null, //  single shared pending-action slot: { matchId, turnToken }
  owner: null, //  generation of the live full-mode coordinator (fence)
  ownerCoordinator: null, //  the live owner's coordinator object (module-scope handle)
  generation: 0, //  monotonically increasing across start() calls
  tokenSeq: 0, //  monotonic token uniqueness counter (no Math.random)
  turnWaiters: new Map(), //  sessionKey -> Set<resolve> — blocked get_turn calls (072j)
};

// Resolve (and clear) all blocked get_turn waiters for a session. Returns how
// many were woken — the driver skips the heartbeat wake when a waiter consumed
// the turn (the agent is mid-tool-call, already awake).
function notifyTurnWaiters(sessionKey) {
  const set = SHARED.turnWaiters.get(sessionKey);
  if (!set || set.size === 0) return 0;
  SHARED.turnWaiters.delete(sessionKey);
  let woken = 0;
  for (const resolve of set) {
    resolve();
    woken += 1;
  }
  return woken;
}

function notifyAllTurnWaiters() {
  for (const sessionKey of [...SHARED.turnWaiters.keys()]) notifyTurnWaiters(sessionKey);
}

// Park the caller until notifyTurnWaiters(sessionKey) fires or ms elapses.
function waitForTurnNotify(sessionKey, ms) {
  return new Promise((resolve) => {
    let set = SHARED.turnWaiters.get(sessionKey);
    if (!set) {
      set = new Set();
      SHARED.turnWaiters.set(sessionKey, set);
    }
    const entry = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      set.delete(entry);
      if (set.size === 0) SHARED.turnWaiters.delete(sessionKey); //  no empty-set leak
      resolve();
    }, ms);
    timer.unref?.();
    set.add(entry);
  });
}

// Deterministic test reset; also the model for a complete owner-scoped reset on stop().
export function __resetState() {
  notifyAllTurnWaiters(); //  release blocked get_turn calls so tests never hang
  SHARED.bindings.clear();
  SHARED.matchToSession.clear();
  SHARED.tokens.clear();
  SHARED.currentTokenByMatch.clear();
  SHARED.transportByMatch.clear();
  SHARED.terminalMatches.clear();
  SHARED.terminalOutcomes.clear();
  SHARED.messagesByMatch.clear();
  SHARED.pending = null;
  SHARED.owner = null;
  SHARED.ownerCoordinator = null;
  SHARED.generation = 0;
  SHARED.tokenSeq = 0;
}

// Build a clean terminal-outcome object from a source that carries some of
// { results, replayUrl, reason, messaging } — dropping undefined keys so a bare
// game_over (nothing captured) never surfaces phantom `results:undefined` etc. (#510).
// `reason` is best-effort: WS game_over frames carry it; the HTTP state endpoint
// does not (it always reports status:'game_over'), matching 0.9.x's HTTP path.
// `messaging` is the server-authored end-of-game envelope ({teaser?, encouragement},
// #514) — forwarded as ONE object so a future reserved field (analysis) lands for
// free; the plugin never authors, replaces, or cherry-picks its text (#517).
function cleanOutcome(source) {
  if (!source || typeof source !== 'object') return null;
  const out = {};
  if (source.results !== undefined) out.results = source.results;
  if (source.replayUrl !== undefined) out.replayUrl = source.replayUrl;
  if (source.reason !== undefined) out.reason = source.reason;
  if (source.messaging !== undefined) out.messaging = source.messaging;
  return Object.keys(out).length > 0 ? out : null;
}

// get_rules recovery hint surfaced on a server invalid_action (#511, ported from
// the published plugin's #397 invalidActionHint). Names the current game and
// points at the plugin's get_rules tool so a minimal-SOUL agent has a concrete
// recovery path instead of an opaque failure. Falls back to a game-less form when
// the bound match has no gameId (never interpolates a literal "undefined").
function invalidActionHint(gameId) {
  return gameId
    ? `Action shape rejected. Call get_rules({gameId: "${gameId}"}) for the valid action schema, then retry with a conformant action.`
    : `Action shape rejected. Call get_rules({gameId}) for the current game's action schema, then retry.`;
}

// Map a structured server rejection (from transport.submitAction, #511) to an
// actionable take_turn error. Recoverable rejections RELEASE the parked turn's
// token (rec.used=false) so the agent can re-submit the SAME turn with a corrected
// action; game_already_over instead flips the match terminal so get_turn reports
// game_over and the agent stops. Unknown codes pass through with their code +
// httpStatus preserved — never collapsed to a single opaque submit_failed.
function mapServerRejection(ack, rec) {
  const code = ack.error;
  if (code === 'game_already_over') {
    SHARED.terminalMatches.add(rec.matchId);
    SHARED.currentTokenByMatch.delete(rec.matchId);
    return {
      ok: false,
      error: 'game_already_over',
      message:
        'The match has already ended on the server. Call get_turn to confirm, then stop or re-queue.',
    };
  }
  rec.used = false; //  recoverable — the parked turn survives for a corrected re-submit
  if (code === 'invalid_action') {
    return {
      ok: false,
      error: 'invalid_action',
      details: ack.details,
      hint: invalidActionHint(rec.packet?.gameId),
    };
  }
  if (code === 'stale_sequence') {
    return { ok: false, error: 'stale_sequence', currentSequence: ack.currentSequence };
  }
  if (code === 'not_your_turn') {
    return {
      ok: false,
      error: 'not_your_turn',
      details:
        ack.details ??
        'The server advanced state without a push this agent observed. Call get_turn to refresh before retrying.',
      currentSequence: ack.currentSequence,
    };
  }
  return { ok: false, error: code, details: ack.details, httpStatus: ack.httpStatus };
}

// Test-only view into module scope (assertions only — never used by logic).
export function __peekState() {
  return SHARED;
}

// The live full-mode coordinator instance, readable from any register-instance.
// The supervisor (entry.mjs) may run in a DIFFERENT instance than the one that
// won ownership; routing owner-gated operations through this handle lets it
// attach/enqueue/markTerminal. Null when no full-mode coordinator owns.
export function getOwnerCoordinator() {
  return SHARED.ownerCoordinator;
}

function hashView(view) {
  // Deterministic, dependency-free. Sufficient as a stale-turn fingerprint.
  const s = JSON.stringify(view ?? null);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `${s.length}:${h}`;
}

// ── Coordinator (registerService, full mode only) ──────────────────────────
// Owns transport/lifecycle and is the ONLY component allowed to mutate shared
// protocol state via owner-gated methods (attach/enqueue/markTerminal). Bind +
// the pull/submit reads are NOT owner-gated, so the tools resolve from any
// instance.
function makeCoordinator(api) {
  const logger = api.logger ?? { info() {}, warn() {}, error() {} };

  let myGeneration = 0;
  const isOwner = () => SHARED.owner === myGeneration && myGeneration !== 0;
  const assertOwner = () => {
    if (!isOwner()) {
      throw new Error(`coordinator not owner (mine=${myGeneration} live=${SHARED.owner})`);
    }
  };

  const coordinator = {
    get generation() {
      return myGeneration;
    },
    isOwner,
    sessionForMatch(matchId) {
      return SHARED.matchToSession.get(matchId) ?? null;
    },

    // Bind an agent session to the coordinator. Folded from the POC join tool,
    // but the plugin binds at queue time (072k §3 — no separate join tool). A
    // plain module-scope write (readable from any instance) — preserves any
    // existing gameId/matchId for the session.
    bindSession(sessionKey, agentId) {
      if (!sessionKey) return false;
      const existing = SHARED.bindings.get(sessionKey);
      SHARED.bindings.set(sessionKey, {
        agentId: agentId ?? existing?.agentId,
        gameId: existing?.gameId,
        matchId: existing?.matchId,
      });
      return true;
    },

    // Clear a session's current match association (used by the queue tool when
    // the agent starts a NEW match after a previous one ended). Without this the
    // binding's stale matchId would make nextTurn keep reporting the finished
    // game instead of no_match. Not owner-gated (a plain module-scope write).
    clearSessionMatch(sessionKey) {
      const b = SHARED.bindings.get(sessionKey);
      if (b) b.matchId = null;
    },

    // Snapshot of current bindings (module scope, readable from any instance —
    // lets the supervisor see sessions bound by the queue tool).
    boundSessions() {
      return [...SHARED.bindings.entries()].map(([sessionKey, b]) => ({
        sessionKey,
        agentId: b.agentId,
        gameId: b.gameId,
        matchId: b.matchId,
      }));
    },

    // Dormant Leg-2 seam (#457 floor): when a /ws/game submit path exists the
    // coordinator publishes a transport entry so submit even in another instance
    // uses it. v1 submit is HTTP, so this stays empty and submit falls through
    // to httpSubmit — never regressing below the proven HTTP floor.
    registerTransport(matchId, entry) {
      assertOwner();
      SHARED.transportByMatch.set(matchId, entry);
    },
    dropTransport(matchId) {
      SHARED.transportByMatch.delete(matchId);
    },

    // Discussion-channel receive buffer (#538). Messages arrive as WS 'message'
    // frames (primary) and as the HTTP state response's `messages` array
    // (fallback backfill); the two overlap, so entries are unioned on a
    // from+text key — the HTTP entries carry no `to` field, so `to` cannot be
    // part of the key, and it is stored only when the frame actually carried it
    // (never fabricated: mislabeling a whisper as broadcast would mislead a
    // social-deduction agent). Known limitations of the key: a player repeating
    // an IDENTICAL statement is buffered once. Capped at MAX_BUFFERED_MESSAGES
    // (oldest dropped). Owner-gated like the other shared-state mutations.
    appendMessages(matchId, msgs) {
      assertOwner();
      if (!matchId || !Array.isArray(msgs) || msgs.length === 0) return 0;
      let buf = SHARED.messagesByMatch.get(matchId);
      if (!buf) {
        buf = [];
        SHARED.messagesByMatch.set(matchId, buf);
      }
      const keyOf = (m) => JSON.stringify([m.from, m.text]);
      const seen = new Set(buf.map(keyOf));
      let added = 0;
      for (const m of msgs) {
        if (!m || typeof m.text !== 'string') continue;
        const entry =
          m.to === undefined
            ? { from: m.from, text: m.text }
            : { from: m.from, text: m.text, to: m.to };
        if (seen.has(keyOf(entry))) continue;
        seen.add(keyOf(entry));
        buf.push(entry);
        added += 1;
      }
      if (buf.length > MAX_BUFFERED_MESSAGES) buf.splice(0, buf.length - MAX_BUFFERED_MESSAGES);
      return added;
    },

    attachMatch(sessionKey, matchId, gameId) {
      assertOwner();
      const binding = SHARED.bindings.get(sessionKey);
      if (!binding) throw new Error(`no binding for session ${sessionKey}`);
      binding.matchId = matchId;
      if (gameId) binding.gameId = gameId;
      SHARED.matchToSession.set(matchId, sessionKey);
    },

    // Mint + PARK a turn: new token (older tokens for this match become stale),
    // build the packet, store it in module scope. The agent fetches it via
    // get_turn (pull).
    async enqueueTurn({
      matchId,
      sequence,
      view,
      phase = 'play',
      allowedActionTypes,
      legalActionSchema,
      instructions,
    }) {
      assertOwner();
      const sessionKey = SHARED.matchToSession.get(matchId);
      if (!sessionKey) throw new Error(`no session bound to match ${matchId}`);
      if (SHARED.terminalMatches.has(matchId)) {
        throw new Error(`match ${matchId} is terminal — refusing to enqueue`);
      }
      const binding = SHARED.bindings.get(sessionKey);

      SHARED.tokenSeq += 1;
      const turnToken = `tok:${matchId}:${sequence}:g${myGeneration}:n${SHARED.tokenSeq}`;
      const idempotencyKey = `steamedclaw-plugin:${matchId}:${sequence}`;
      const packet = {
        kind: 'steamedclaw.turn',
        gameId: binding?.gameId,
        matchId,
        sequence,
        turnToken,
        phase,
        view,
        allowedActionTypes,
        legalActionSchema,
        instructions,
      };
      const rec = {
        sessionKey,
        matchId,
        sequence,
        viewHash: hashView(view),
        used: false,
        attempts: 1,
        packet,
        idempotencyKey,
      };
      SHARED.tokens.set(turnToken, rec);
      SHARED.currentTokenByMatch.set(matchId, turnToken);

      // Wake any get_turn call blocked on this session (072j). woken > 0 means
      // the agent is mid-tool-call — the driver then skips the heartbeat wake.
      const woken = notifyTurnWaiters(sessionKey);
      return { turnToken, packet, woken };
    },

    // PULL read (the v1 hard contract). A plain module-scope read — NOT
    // owner-gated, so the get_turn tool resolves it even from a non-owner
    // instance. Statuses: not_joined | no_match (queuing) | waiting (matched, no
    // fresh turn) | your_turn (act now) | game_over.
    nextTurn(sessionKey) {
      const binding = SHARED.bindings.get(sessionKey);
      if (!binding) return { status: 'not_joined' };
      const matchId = binding.matchId;
      if (!matchId) return { status: 'no_match' };
      if (SHARED.terminalMatches.has(matchId)) {
        // Surface the outcome captured at terminal detection so an agent parked
        // in get_turn on the opponent-ended path learns win/loss + replay, not a
        // bare terminal status (#510). Absent ⇒ bare game_over (no phantom keys).
        const outcome = SHARED.terminalOutcomes.get(matchId);
        return outcome
          ? { status: 'game_over', matchId, ...outcome }
          : { status: 'game_over', matchId };
      }
      // Discussion table talk rides every non-terminal read (#538) so the agent
      // can catch up on chat both when acting and while waiting after its ready.
      // Only the newest MAX_RESULT_MESSAGES resend (token cost); key omitted
      // entirely when there is no chat.
      const buffered = SHARED.messagesByMatch.get(matchId);
      const messages =
        buffered && buffered.length > 0 ? { messages: buffered.slice(-MAX_RESULT_MESSAGES) } : {};
      const turnToken = SHARED.currentTokenByMatch.get(matchId);
      if (!turnToken) return { status: 'waiting', matchId, ...messages };
      const rec = SHARED.tokens.get(turnToken);
      if (!rec || rec.used) return { status: 'waiting', matchId, ...messages };
      return {
        status: 'your_turn',
        matchId,
        turnToken,
        sequence: rec.sequence,
        gameId: rec.packet.gameId,
        phase: rec.packet.phase,
        view: rec.packet.view,
        ...messages,
      };
    },

    // Blocking pull read (072j). Same statuses as nextTurn, but on 'waiting' or
    // 'no_match' it parks up to blockMs for enqueueTurn/markTerminal to land — a
    // WS your_turn push resolves it mid-call, so a responsive game plays with no
    // idle polling gap. On timeout it re-reads once and returns whatever the
    // state is ('waiting' is a valid answer; the agent calls again).
    async nextTurnWait(sessionKey, blockMs = 0) {
      const first = coordinator.nextTurn(sessionKey);
      if (first.status !== 'waiting' && first.status !== 'no_match') return first;
      const ms = Math.max(0, Math.min(blockMs ?? 0, MAX_NEXT_TURN_BLOCK_MS));
      if (ms === 0) return first;
      await waitForTurnNotify(sessionKey, ms);
      return coordinator.nextTurn(sessionKey);
    },

    // Token-validated submit (the POC submit_action logic). Returns the same
    // ack shape over WS or HTTP. Rejects stale/replayed/wrong-session/wrong-match
    // tokens. Not owner-gated — runs in whatever instance the host invokes the
    // tool in, reading the shared token store.
    async submitAction(sessionKey, turnToken, action, httpSubmit) {
      if (!turnToken) return { ok: false, error: 'missing_token' };
      const rec = SHARED.tokens.get(turnToken);
      if (!rec) return { ok: false, error: 'unknown_token' };
      if (rec.used) return { ok: false, error: 'replayed_token' };
      if (rec.sessionKey !== sessionKey) return { ok: false, error: 'wrong_session' };
      const boundMatch = SHARED.bindings.get(sessionKey)?.matchId;
      if (rec.matchId !== boundMatch) return { ok: false, error: 'wrong_match' };
      if (SHARED.currentTokenByMatch.get(rec.matchId) !== turnToken) {
        return { ok: false, error: 'stale_token' };
      }
      if (SHARED.terminalMatches.has(rec.matchId)) return { ok: false, error: 'match_terminal' };
      // Single shared pending-action slot (cross-instance): reject concurrent
      // submits against the active match.
      if (SHARED.pending) return { ok: false, error: 'action_in_flight' };
      // Claim the token + slot before any await so a concurrent call in another
      // instance loses the race deterministically.
      rec.used = true;
      SHARED.pending = { matchId: rec.matchId, turnToken };
      try {
        const ack = await submitViaTransport({
          matchId: rec.matchId,
          sequence: rec.sequence,
          action,
          httpSubmit,
        });
        if (ack && ack.ok === false) {
          // Server REJECTED the action (structured error from transport, #511) —
          // map it to an actionable take_turn error (with a get_rules hint on
          // invalid_action) instead of collapsing everything to submit_failed.
          return mapServerRejection(ack, rec);
        }
        if (ack.status === 'game_over') {
          SHARED.terminalMatches.add(rec.matchId);
          SHARED.currentTokenByMatch.delete(rec.matchId);
          SHARED.messagesByMatch.delete(rec.matchId);
          // Persist the outcome so a get_turn re-read after a self-ending move
          // also carries results/replayUrl, not just the transient take_turn ack (#510).
          const outcome = cleanOutcome(ack);
          if (outcome) SHARED.terminalOutcomes.set(rec.matchId, outcome);
          return { ok: true, ...ack };
        }
        if (action?.type === 'message') {
          // Message actions are non-turn-consuming SERVER-side (the action route
          // handles them without touching the game turn), so RELEASE the parked
          // turn: the same token stays valid for the phase action. Without this
          // a statement burns the single-use token and no re-park exists for the
          // unchanged sequence (parkTurn dedupes) — the #538 murder-mystery trap
          // (the participation floor makes a statement MANDATORY before ready).
          rec.used = false;
          return {
            ok: true,
            status: 'message_sent',
            message:
              'Statement delivered to the table. Your turn is still open and the same turnToken is still valid — call get_turn to see table messages, then submit your phase action (e.g. {type:"ready"}) with take_turn.',
          };
        }
        // INVARIANT: take_turn never surfaces an actionable turn or a turnToken —
        // get_turn is the SOLE source of actionable turns + tokens (enqueueTurn is
        // the only token-minting site). A fast opponent makes the HTTP submit
        // response carry the NEXT turn's state (status:"your_turn" + view/sequence
        // but NO coordinator-minted token); echoing it produced a tokenless
        // "your_turn" the agent could not act on (replayed_token on the old token,
        // no new token). Return a NEUTRAL ack that routes the agent back to
        // get_turn, which blocks until the next turn is parked WITH a fresh token.
        // This removes the broken shortcut without adding a second token-minting
        // site or any extra calls (the play loop already round-trips get_turn).
        return { ok: true, status: 'submitted', next: 'call get_turn' };
      } catch (err) {
        // Failed submit: release the token so a re-issued packet can retry.
        rec.used = false;
        return { ok: false, error: 'submit_failed', message: String(err?.message ?? err) };
      } finally {
        SHARED.pending = null;
      }
    },

    markTerminal(matchId, outcome) {
      assertOwner();
      SHARED.terminalMatches.add(matchId);
      SHARED.messagesByMatch.delete(matchId);
      // Capture the game-over outcome (opponent-ended / timeout / forfeit) so the
      // parked get_turn re-read surfaces results/replayUrl/reason (#510).
      const cleaned = cleanOutcome(outcome);
      if (cleaned) SHARED.terminalOutcomes.set(matchId, cleaned);
      const tok = SHARED.currentTokenByMatch.get(matchId);
      if (tok) SHARED.tokens.delete(tok);
      SHARED.currentTokenByMatch.delete(matchId);
      // Wake a blocked get_turn so the agent learns game_over immediately.
      const sessionKey = SHARED.matchToSession.get(matchId);
      const woken = sessionKey ? notifyTurnWaiters(sessionKey) : 0;
      return { woken };
    },

    service: {
      id: 'steamedclaw-coordinator',
      async start() {
        SHARED.generation += 1;
        myGeneration = SHARED.generation;
        SHARED.owner = myGeneration; //  newest full-mode service wins ownership
        SHARED.ownerCoordinator = coordinator; //  publish the live owner handle
        logger.info?.(`[steamedclaw-plugin] coordinator owner=${myGeneration}`);
      },
      async stop() {
        // Only the live owner performs the owner-scoped reset; a stale/duplicate
        // service stopping must not wipe the live owner's state.
        if (SHARED.owner === myGeneration) {
          notifyAllTurnWaiters(); //  release blocked get_turn calls
          SHARED.bindings.clear();
          SHARED.matchToSession.clear();
          SHARED.tokens.clear();
          SHARED.currentTokenByMatch.clear();
          SHARED.transportByMatch.clear();
          SHARED.terminalMatches.clear();
          SHARED.terminalOutcomes.clear();
          SHARED.messagesByMatch.clear();
          SHARED.pending = null;
          SHARED.owner = null;
          SHARED.ownerCoordinator = null;
        }
        myGeneration = 0;
      },
    },
  };
  return coordinator;
}

// ── Transport facade: WS-preferred, HTTP fallback (the #457 correctness floor).
// Reads the module-scope transport registry so any instance resolves the same
// socket the coordinator opened; absent ⇒ HTTP. Identical ack shape either way.
// v1 leaves transportByMatch empty (HTTP submit), so this is HTTP in practice.
async function submitViaTransport({ matchId, sequence, action, httpSubmit }) {
  const entry = SHARED.transportByMatch.get(matchId);
  if (entry && entry.isOpen()) {
    const ack = await entry.submit({ type: 'action', sequence, payload: action });
    return { ...ack, via: 'ws' };
  }
  const ack = await httpSubmit({ matchId, sequence, action });
  return { ...ack, via: 'http' };
}

function toolText(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

// The hard play loop — stated identically in every tool description so the agent
// has one unambiguous contract. Mechanics live in tool descriptions/results,
// never in agent SOUL/persona.
export const PLAY_LOOP =
  'SteamedClaw play loop: call register_agent once (identity), then queue_match to enter matchmaking; then call get_turn repeatedly until it returns status "your_turn"; then call take_turn with that turnToken and a legal action; then go back to get_turn. Repeat until get_turn returns status "game_over".';

// PULL delivery tool — the v1 hard contract. The agent calls this on each turn.
// With WS Leg-1 (072j) it BLOCKS briefly: a turn pushed over WebSocket resolves
// the call mid-wait, so a responsive game plays without polling gaps.
export function makeGetTurnFactory(coordinator, { nextTurnBlockMs } = {}) {
  const blockMs = Math.max(0, Math.min(nextTurnBlockMs ?? 0, MAX_NEXT_TURN_BLOCK_MS));
  const blockSecs = Math.round(blockMs / 1000);
  return (ctx) => ({
    name: 'get_turn',
    description: `Fetch your current SteamedClaw turn. This call WAITS up to ~${blockSecs}s for your turn to arrive, then returns status: "not_joined" (you have not queued — call queue_match first), "no_match" (still matchmaking — call again), "waiting" (matched, opponent's turn — call again), "your_turn" (act now: pass the returned turnToken to take_turn), or "game_over" (the match ended — stop). In discussion games (werewolf, murder-mystery) the result may also carry a "messages" array — the recent table talk; read it before acting (absent when nothing has been said). Just call it again whenever it returns no_match or waiting. ${PLAY_LOOP}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return toolText({ ok: false, error: 'no_session' });
      const r = await coordinator.nextTurnWait(sessionKey, blockMs);
      // Teach the loop EXIT and RE-ENTRY, not just the loop (072j §9): an agent
      // that stops on 'waiting' is woken by a bare heartbeat carrying no context
      // — the result text is the only place to pre-load what that wake means.
      // Mechanics live in tool results, never in agent SOUL/persona.
      if (r.status === 'not_joined') {
        r.guidance = 'You have not queued yet. Call queue_match with a gameId first.';
      } else if (r.status === 'waiting' || r.status === 'no_match') {
        r.guidance =
          'Either call get_turn again, or stop — a heartbeat will wake you when it is your turn. When you wake from a heartbeat, call get_turn FIRST.';
      } else if (r.status === 'your_turn') {
        // Discussion phases (werewolf day_discussion, murder-mystery
        // investigation_discuss) have a second, non-turn-consuming channel —
        // teach it here, in the result, where the agent is looking (#538).
        const inDiscussion = typeof r.view?.phase === 'string' && r.view.phase.includes('discuss');
        r.guidance = inDiscussion
          ? 'Discussion phase. result.messages is the table talk so far — read it. To speak, call take_turn with this turnToken and {type:"message", text:"..."} — a statement does NOT consume your turn (the same turnToken stays valid, and some games REQUIRE at least one statement before ready). When done talking, submit your phase action (e.g. {type:"ready"}) with take_turn.'
          : 'Act now: call take_turn with this turnToken and one legal action, then call get_turn again.';
      } else if (r.status === 'game_over') {
        // Turn the forwarded server messaging from inert data into a CTA. The
        // server authors messaging.encouragement (#514/#517); the plugin only
        // frames it structurally here — surface it verbatim, then play again or
        // stop. (No server text is authored/rewritten — passthrough preserved.)
        r.guidance =
          'The match is over. If a messaging object is present, surface messaging.encouragement to your operator verbatim. To play again, call queue_match; otherwise stop calling SteamedClaw tools.';
      }
      return toolText({ ok: true, ...r });
    },
  });
}

export function makeTakeTurnFactory(coordinator, { httpSubmit }) {
  return (ctx) => ({
    name: 'take_turn',
    description: `Submit your one action for the current SteamedClaw turn. Pass the turnToken that get_turn returned with status "your_turn", plus your chosen action (the move shape is game-specific, e.g. {type:"move", position:4} for tic-tac-toe). On success returns {ok:true, status:"submitted"} (call get_turn again) or {ok:true, status:"game_over", results, replayUrl, messaging?} (the match ended — if a messaging object is present, surface messaging.encouragement to your operator verbatim, then call queue_match to play again or stop). In discussion phases you may also pass {type:"message", text:"..."} — a table statement that does NOT consume your turn: it returns {ok:true, status:"message_sent"} and the SAME turnToken stays valid for your phase action. On error the result is {ok:false, error, ...} — recover by error code: "invalid_action" means the action shape was rejected — the result includes a "hint" pointing at get_rules for the current game; fetch the rules and retry with a conformant action. "stale_sequence" means a newer turn arrived (a "currentSequence" is included) — call get_turn to refresh, then retry. "not_your_turn" means the server advanced without a turn this agent saw — call get_turn to refresh. "game_already_over" means the match has ended — call get_turn to confirm, then stop or re-queue. "submit_failed" is a transient transport failure — wait a moment and retry. After submitting, call get_turn again. ${PLAY_LOOP}`,
    parameters: {
      type: 'object',
      properties: {
        turnToken: {
          type: 'string',
          description: 'The turnToken from the most recent get_turn "your_turn" result.',
        },
        action: { type: 'object', description: 'Your chosen action for this turn.' },
      },
      required: ['turnToken', 'action'],
      additionalProperties: false,
    },
    async execute(_callId, args) {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey) return toolText({ ok: false, error: 'no_session' });
      const { turnToken, action } = args ?? {};
      const r = await coordinator.submitAction(sessionKey, turnToken, action, httpSubmit);
      return toolText(r);
    },
  });
}

// ── Plugin registration. entry.mjs wraps this via definePluginEntry; tests call
// register() directly with a mock api. opts.httpSubmit MUST be threaded
// explicitly — NOT stashed on `api`. The live OpenClaw plugin `api` is a Proxy:
// a custom property set on it reads back as a late-callable stub (returns null,
// no HTTP), so a stashed api.httpSubmit silently no-ops while reporting ok:true
// (072i). Passing it through opts keeps the real transport in a closure the
// Proxy can't shadow. Falls back to api.httpSubmit only for the plain test mock.
export function register(api, opts = {}) {
  const coordinator = makeCoordinator(api);
  const httpSubmit = opts.httpSubmit ?? api.httpSubmit;
  const nextTurnBlockMs = opts.nextTurnBlockMs ?? 0;
  // Tools register in ALL modes (the instance split is the whole point). Factories
  // are bare functions; the name is passed via opts so the host (and the tests)
  // can identify the tool before invoking it.
  api.registerTool(makeGetTurnFactory(coordinator, { nextTurnBlockMs }), {
    name: 'get_turn',
  });
  api.registerTool(makeTakeTurnFactory(coordinator, { httpSubmit }), {
    name: 'take_turn',
  });
  if (api.registrationMode === 'full') {
    api.registerService(coordinator.service);
  }
  return { coordinator };
}

export default { register };
