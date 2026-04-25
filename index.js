// SteamedClaw plugin — Path 3 (WebSocket-first gameplay).
//
// The plugin holds two outbound sockets against the SteamedClaw server:
//   * /ws/game/:matchId while an active match is recorded in
//     ~/.config/steamedclaw-state/current-game.md — wakes the agent via
//     requestHeartbeatNow() on each `your_turn` push.
//   * /ws/agent whenever credentials are available — receives
//     `match_found` pushes server-side so the agent learns about freshly
//     paired matches without polling.
//
// The plugin also exposes six LLM-visible tools:
//   * `register_agent({name, model?})` — POST /api/agents on first boot
//     when no credentials exist. LLM supplies name from its SOUL.
//   * `queue_match({gameId})` — HTTP POST to /api/matchmaking/queue.
//   * `get_turn()` — reads the cached `your_turn` payload from the open
//     match WS; falls back to GET /api/matches/:id/state?wait=false when
//     no push has been cached yet.
//   * `take_turn({action})` — submits an action frame over the open
//     /ws/game/:matchId socket and awaits the server's next state push
//     (your_turn, game_over, or error) as the ack.
//   * `get_rules({gameId})` — HTTP GET /api/games/:gameId/rules; returns
//     mechanical rules markdown. Call once per match when starting a new
//     gameId (essential for murder-mystery, werewolf-7, falkens-maze,
//     liars-dice — action shapes are not in LLM training data).
//   * `get_strategy({gameId})` — HTTP GET /api/games/:gameId/strategy;
//     returns opinionated human-curated hints. Explicitly opt-in —
//     rules + view are sufficient to play and strong models may have
//     better strategy internalized already.
//
// See `botoff/CLAUDE.md` § Play Paths for the three-path model.

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { WebSocket } from 'ws';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// State dir matches the skill's ~/.config/steamedclaw-state/ path (skill
// v3.9.0+, renamed to eliminate LLM name-collision with the skill install
// dir at ~/.openclaw/skills/steamedclaw/; see #341).
const DATA_DIR = path.join(os.homedir(), '.config', 'steamedclaw-state');
const CREDENTIALS = path.join(DATA_DIR, 'credentials.md');
const CURRENT_GAME = path.join(DATA_DIR, 'current-game.md');
const PENDING_QUEUE = path.join(DATA_DIR, 'pending-queue.md');
const CLAIM = path.join(DATA_DIR, 'claim.md');

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const MATCH_POLL_MS = 5000;

// Degraded-mode fallback: when /ws/agent is not OPEN and we have an
// outstanding queue marker, poll GET /api/matchmaking/status at this
// interval. 30 s is a deliberate ceiling — the push path is primary;
// this poll is only meant to unwedge agents when the WS upgrade is
// stripped or 404-capped. A hostile proxy keeping /ws/agent down for
// the full 5-min 404 cap should see ~10 polls, not 60 (#385).
const QUEUE_POLL_MS = 30000;

// Distinctive UA so server-side analysis can classify plugin-origin
// traffic. Bumped alongside package.json.
const PLUGIN_USER_AGENT = 'steamedclaw-plugin/0.9.14';

// Match lanes. PLUGIN_LANES mirrors LANES from @botoff/shared
// (packages/shared/src/schemas/api.ts); the plugin ships standalone and
// cannot runtime-import the workspace-private shared package, so values
// are duplicated here and pinned by __tests__/lane-parity.test.mjs.
//
// PLUGIN_DEFAULT_LANE is the plugin's own default — deliberately
// divergent from shared DEFAULT_LANE ('standard'). Path 3 is WS
// push-driven and designed for sub-5s wake; an operator installing this
// plugin is opting into low-latency play, so 'fast' is the right default.
// Owners with a heartbeat-paced runtime behind the plugin should set
// `defaultLane: 'standard'` in plugin config.
export const PLUGIN_LANES = ['fast', 'standard'];
export const PLUGIN_DEFAULT_LANE = 'fast';

// Upper bound for take_turn ack correlation. In a 2-player sequential
// game the ack is "opponent submits their move → server emits your_turn
// back at this agent." That chain depends on the server's turn-timeout
// (≥ 7 min per SteamedClaw conventions) — if the opponent stalls, the server
// will eventually force a forfeit and emit game_over. Waiting past that
// window catches the game_over push as the ack instead of surfacing a
// spurious `timeout` error while the match is still live. 8 min buys a
// little slop on top of the 7-min server timeout.
const TAKE_TURN_TIMEOUT_MS = 480000;

// Response-body status values that mean "the match has ended". The
// server normalizes terminal DB states (completed, aborted) to a single
// response status `game_over` in buildStateResponse / buildGameOverResponse
// (packages/server/src/app.ts). When get_turn's HTTP fallback sees this
// the plugin clears current-game.md and surfaces the same
// `no_active_match` shape used when no match is set locally — without
// it, an LLM seeing `myTurn:false` plus `status:game_over` could
// mistake it for "opponent's turn" and loop on a dead match (#396).
const TERMINAL_MATCH_STATUSES = new Set(['game_over']);

// /ws/agent socket lifetime constants (issue #346).
const AGENT_WS_RECONNECT_BASE_MS = 1000;
const AGENT_WS_RECONNECT_MAX_MS = 30000;
// After an `unexpected-response` with status 404 (server does not have
// the /ws/agent route registered — feature flag off mid-deploy, or an
// older build), back off to 5 minutes on the next attempt. Reset to the
// normal cap on the next successful `open` (#358 Finding 6).
const AGENT_WS_RECONNECT_404_MAX_MS = 300000;

function readCredentials() {
  if (!fs.existsSync(CREDENTIALS)) return null;
  const text = fs.readFileSync(CREDENTIALS, 'utf8');
  const server = (text.match(/^Server:\s*(.+)$/m) || [])[1]?.trim();
  const agentId = (text.match(/^Agent ID:\s*(.+)$/m) || [])[1]?.trim();
  const apiKey = (text.match(/^API Key:\s*(.+)$/m) || [])[1]?.trim();
  const name = (text.match(/^Name:\s*(.+)$/m) || [])[1]?.trim() || null;
  if (!server || !agentId || !apiKey) return null;
  if (agentId.includes('not registered') || apiKey.includes('not registered')) return null;
  return { server, agentId, apiKey, name };
}

function writeCredentials(server, agentId, apiKey, name) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const nameLine = name ? `Name: ${name}\n` : '';
  fs.writeFileSync(
    CREDENTIALS,
    `Server: ${server}\nAgent ID: ${agentId}\nAPI Key: ${apiKey}\n${nameLine}`,
  );
}

function readCurrentMatch() {
  if (!fs.existsSync(CURRENT_GAME)) return null;
  const text = fs.readFileSync(CURRENT_GAME, 'utf8').trim();
  if (!text || text === 'No active game.') return null;
  const matchId = (text.match(/^match:\s*(.+)$/m) || [])[1]?.trim();
  const game = (text.match(/^game:\s*(.+)$/m) || [])[1]?.trim();
  const seq = parseInt((text.match(/^seq:\s*(\d+)$/m) || [])[1] || '0', 10);
  if (!matchId) return null;
  return { matchId, game, seq };
}

function writeCurrentMatch(matchId, game, seq) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CURRENT_GAME, `match: ${matchId}\ngame: ${game}\nseq: ${seq}\n`);
}

function clearCurrentMatch() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CURRENT_GAME, 'No active game.\n');
}

// pending-queue.md — the "awaiting match" marker. Written when
// queue_match returns {status:'queued'}, cleared when the match is
// resolved (push or poll) or the server reports {status:'not_queued'}.
// Survives plugin restart so the poll fallback can resume discovering
// a match after a crash. Same markdown key:value format as the two
// files above; the sentinel text is the "empty" representation so the
// file can be cleared without an unlink (some fs mocks in the tier-1
// tests only stub existsSync/read/write).
function readPendingQueue() {
  if (!fs.existsSync(PENDING_QUEUE)) return null;
  const text = fs.readFileSync(PENDING_QUEUE, 'utf8').trim();
  if (!text || text === 'No pending queue.') return null;
  const gameId = (text.match(/^game:\s*(.+)$/m) || [])[1]?.trim();
  if (!gameId) return null;
  const queuedAt = (text.match(/^queuedAt:\s*(.+)$/m) || [])[1]?.trim();
  return { gameId, queuedAt };
}

function writePendingQueue(gameId) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PENDING_QUEUE, `game: ${gameId}\nqueuedAt: ${new Date().toISOString()}\n`);
}

function clearPendingQueue() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PENDING_QUEUE, 'No pending queue.\n');
}

// claim.md — the operator-facing claim link persisted on registration so
// the operator can link the newly-registered agent to their SteamedClaw
// account. Written by the register_agent tool. Markdown key:value format.
// Under the LLM-driven registration model, the register_agent response
// itself carries the claim URL + verification code + operatorNotice
// string directly — claim.md is a durable fallback for operators who
// miss the LLM's next message.
function serializeClaim({ claimUrl, verificationCode, registered, status, announced }) {
  return (
    `Claim URL: ${claimUrl}\n` +
    `Verification code: ${verificationCode}\n` +
    `Registered: ${registered}\n` +
    `Status: ${status}\n` +
    `Announced: ${announced ? 'true' : 'false'}\n`
  );
}

// Write-once guard: if claim.md already exists, never rewrite it. A
// second registration attempt (e.g. credentials.md deleted externally
// but claim.md survived) must not clobber the original claim URL.
// `Announced: true` is written from the start because the LLM sees the
// claim surface directly in the register_agent tool response — no
// merge-into-subsequent-tools deferral.
function writeClaimIfAbsent(claimUrl, verificationCode) {
  if (fs.existsSync(CLAIM)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    CLAIM,
    serializeClaim({
      claimUrl,
      verificationCode: verificationCode || '',
      registered: new Date().toISOString(),
      status: 'unclaimed',
      announced: true,
    }),
  );
}

// ──────────────────────────────────────────────────────────────────────
// HTTP helper (node:http / node:https — no fetch or axios dependency)
// ──────────────────────────────────────────────────────────────────────

function httpRequest(method, urlStr, apiKey, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const bodyStr = body == null ? undefined : JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': PLUGIN_USER_AGENT,
    };
    // Authorization is opt-in — the /api/agents registration POST is
    // unauthenticated, and downstream callers pass apiKey only when they
    // have credentials.
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (bodyStr !== undefined) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, data: raw });
          }
        });
      },
    );
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────
// register_agent tool implementation (#390)
// ──────────────────────────────────────────────────────────────────────

const NOT_REGISTERED_MESSAGE =
  'No credentials yet. Call register_agent({name, model?}) to register before using other tools.';

// Factory so the tool closes over the three service instances and can
// notify them once credentials are persisted. Promise memoization lives
// inside the returned function so two parallel LLM invocations settle
// on the same POST.
function makeRegisterAgent(api, matchSvc, agentSvc, pollSvc) {
  let inFlight = null;
  async function notifyServicesOfCredentials() {
    await Promise.all([
      matchSvc?.onCredentialsReady ? matchSvc.onCredentialsReady() : Promise.resolve(),
      agentSvc?.onCredentialsReady ? agentSvc.onCredentialsReady() : Promise.resolve(),
      pollSvc?.onCredentialsReady ? pollSvc.onCredentialsReady() : Promise.resolve(),
    ]);
  }
  return async function registerAgent(name, model) {
    const existing = readCredentials();
    if (existing) {
      // Belt-and-suspenders: on the rare path where a prior
      // register_agent call persisted credentials but threw before
      // notifying services (e.g., claim.md write failed mid-success),
      // this rewires the services idempotently. onCredentialsReady
      // is a no-op in the usual case (services already connected).
      await notifyServicesOfCredentials();
      return {
        ok: false,
        error: 'already_registered',
        name: existing.name ?? null,
        message: existing.name
          ? `Already registered as "${existing.name}". Use queue_match, get_turn, etc.`
          : 'Already registered. Use queue_match, get_turn, etc.',
      };
    }
    if (inFlight) return inFlight;
    const server = api.pluginConfig?.server;
    if (typeof server !== 'string' || server.length === 0) {
      return {
        ok: false,
        error: 'config_error',
        message:
          'Plugin config missing "server". Ask the operator to set plugins.entries.steamedclaw-plugin.config.server in openclaw.json.',
      };
    }
    inFlight = (async () => {
      try {
        const body = { name };
        if (typeof model === 'string' && model.length > 0) body.model = model;
        let res;
        try {
          res = await httpRequest('POST', `${server}/api/agents`, null, body);
        } catch (err) {
          api.logger.warn?.(`[steamedclaw-match] register_agent network error: ${err.message}`);
          return {
            ok: false,
            error: 'network_error',
            message: `Network error during registration: ${err.message}. Retry in a moment.`,
          };
        }
        if (res.status === 201) {
          const data = res.data ?? {};
          if (!data.id || !data.apiKey) {
            api.logger.warn?.(
              '[steamedclaw-match] register_agent response missing id/apiKey — cannot persist credentials',
            );
            return {
              ok: false,
              error: 'register_failed',
              httpStatus: 201,
              message:
                'Server registered the agent but response was missing id/apiKey. Cannot proceed; ask the operator to check the server.',
            };
          }
          try {
            writeCredentials(server, data.id, data.apiKey, name);
          } catch (err) {
            api.logger.warn?.(
              `[steamedclaw-match] register_agent credentials persist failed: ${err.message}`,
            );
            return {
              ok: false,
              error: 'persist_failed',
              serverSideRegistered: true,
              message: `Server registered the agent but local credentials persist failed: ${err.message}. Operator must manually write credentials.md or reset server-side agent registration.`,
            };
          }
          const claimUrl = typeof data.claim_url === 'string' ? data.claim_url : '';
          const verificationCode =
            typeof data.verification_code === 'string' ? data.verification_code : '';
          if (claimUrl) {
            // Isolated try/catch: a claim.md write failure (disk full,
            // EACCES) must not abort the rest of the success path.
            // Credentials.md is already on disk; the next call to
            // register_agent will short-circuit to already_registered
            // and rewire services via the belt-and-suspenders path.
            try {
              writeClaimIfAbsent(claimUrl, verificationCode);
            } catch (err) {
              api.logger.warn?.(
                `[steamedclaw-match] claim.md write failed: ${err.message} — operatorNotice still delivered in tool response`,
              );
            }
            api.logger.info?.(
              `[steamedclaw-match] OPERATOR ACTION: claim this agent at ${claimUrl}`,
            );
            if (verificationCode) {
              api.logger.info?.(`[steamedclaw-match] verification code: ${verificationCode}`);
            }
          }
          api.logger.info?.(
            `[steamedclaw-match] registered agent "${name}" id=${data.id}; credentials written`,
          );
          // Notify services so agent-ws opens its /ws/agent socket and
          // match-ws picks up any current match. Without this, services
          // that started before credentials existed stay idle even after
          // register_agent succeeds.
          await notifyServicesOfCredentials();
          const codeSuffix = verificationCode ? ` (verification code: ${verificationCode})` : '';
          const operatorNotice = claimUrl
            ? `I registered on SteamedClaw. Link me to your operator account at ${claimUrl}${codeSuffix}. Without this, the rating, badges, and wins I earn won't be attributed to you.`
            : '';
          return {
            ok: true,
            id: data.id,
            name,
            model: typeof model === 'string' && model.length > 0 ? model : null,
            apiKey: data.apiKey,
            claimUrl: claimUrl || null,
            verificationCode: verificationCode || null,
            operatorNotice,
          };
        }
        if (res.status === 409) {
          api.logger.info?.(
            `[steamedclaw-match] register_agent 409 name_taken: "${name}" — LLM should retry with a different name`,
          );
          return {
            ok: false,
            error: 'name_taken',
            nameAttempted: name,
            message: `"${name}" is already taken on SteamedClaw. Pick a different name and call register_agent again.`,
          };
        }
        if (res.status === 400) {
          return {
            ok: false,
            error: 'invalid_name',
            nameAttempted: name,
            message:
              'Name is invalid. Must be 1-64 chars, letters/numbers/hyphens/spaces/underscores only.',
          };
        }
        api.logger.warn?.(`[steamedclaw-match] register_agent failed: HTTP ${res.status}`);
        return {
          ok: false,
          error: 'register_failed',
          httpStatus: res.status,
          message: `Registration failed with HTTP ${res.status}. Retry later or ask the operator to check the server.`,
        };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}

// ──────────────────────────────────────────────────────────────────────
// queue_match tool implementation
// ──────────────────────────────────────────────────────────────────────

async function queueMatch(gameId, lane, pollSvc) {
  const creds = readCredentials();
  if (!creds) {
    return { ok: false, error: 'not_registered', message: NOT_REGISTERED_MESSAGE };
  }
  const existing = readCurrentMatch();
  if (existing) {
    return {
      ok: false,
      error: 'already_in_match',
      matchId: existing.matchId,
      game: existing.game,
    };
  }
  const url = `${creds.server}/api/matchmaking/queue`;
  const res = await httpRequest('POST', url, creds.apiKey, { gameId, lane });
  if (res.status !== 200) {
    const err = typeof res.data?.error === 'string' ? res.data.error : 'queue_failed';
    // 404 game_not_found surfaces distinctly so the LLM picks a different
    // gameId rather than retrying the same one.
    return {
      ok: false,
      error: res.status === 404 ? 'game_not_found' : err,
      httpStatus: res.status,
    };
  }
  const body = res.data ?? {};
  if (body.status === 'matched' && body.matchId) {
    writeCurrentMatch(body.matchId, gameId, 0);
    clearPendingQueue();
    return { ok: true, status: 'matched', matchId: body.matchId, game: gameId };
  }
  // {status:'queued'} — mark this agent as having an outstanding queue
  // so the poll fallback can recover pairing if /ws/agent is degraded
  // (upgrade rejected, hostile proxy stripping WS, mid-deploy route
  // missing). Survives restart (#385).
  writePendingQueue(gameId);
  if (pollSvc) pollSvc.notifyMarkerWritten();
  return {
    ok: true,
    status: 'queued',
    game: gameId,
    position: typeof body.position === 'number' ? body.position : undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────
// get_turn / take_turn tool implementations
// ──────────────────────────────────────────────────────────────────────

async function getTurn(matchSvc, opts = {}) {
  const refresh = opts.refresh === true;
  const creds = readCredentials();
  if (!creds) {
    // get_turn historically used `status: 'not_registered'`; retain the
    // status field for backward-compatible pattern matching but add
    // `error` + `message` to align with the other tools.
    return { status: 'not_registered', error: 'not_registered', message: NOT_REGISTERED_MESSAGE };
  }
  const match = readCurrentMatch();
  if (!match) {
    return { status: 'no_active_match', message: 'Call queue_match to play.' };
  }
  if (!refresh) {
    const cached = matchSvc ? matchSvc.getCachedTurn(match.matchId) : null;
    if (cached) {
      return {
        status: 'your_turn',
        matchId: match.matchId,
        game: match.game,
        sequence: cached.sequence,
        view: cached.view,
        myTurn: true,
      };
    }
  } else if (matchSvc) {
    // Explicit refresh — drop any cached `your_turn` before falling
    // through. A subsequent take_turn would otherwise replay the same
    // stale view that motivated the refresh in the first place (#396).
    matchSvc.invalidateCachedTurn(match.matchId);
  }
  // Rare path — no `your_turn` push has landed yet (plugin just started
  // mid-match, the match WS is still reconnecting), or the LLM passed
  // {refresh:true} to escape a stale cache (#396). One HTTP GET to
  // surface whatever the server thinks this agent's state is.
  const url = `${creds.server}/api/matches/${match.matchId}/state?wait=false`;
  const res = await httpRequest('GET', url, creds.apiKey, null);
  // 404 + match_not_found means the server has no record of this match
  // (ended silently, expired, or never existed). Clear local state and
  // surface the terminal shape so the LLM doesn't loop on a dead match.
  if (
    res.status === 404 &&
    typeof res.data?.error === 'string' &&
    res.data.error === 'match_not_found'
  ) {
    if (matchSvc) matchSvc.invalidateCachedTurn(match.matchId);
    clearCurrentMatch();
    return {
      status: 'no_active_match',
      matchId: match.matchId,
      message: 'Match has ended on the server. Call queue_match to start a new game.',
      fetchedVia: 'http',
    };
  }
  if (res.status !== 200) {
    const err = typeof res.data?.error === 'string' ? res.data.error : 'state_failed';
    return { status: 'error', error: err, httpStatus: res.status };
  }
  const body = res.data ?? {};
  // Terminal server status — the match has ended; clear local state and
  // return `no_active_match` (the same shape the no-match path uses) so
  // the LLM doesn't get a `myTurn:false`/`completed` mix that's easy to
  // mistake for "opponent's turn" (#396).
  if (typeof body.status === 'string' && TERMINAL_MATCH_STATUSES.has(body.status)) {
    if (matchSvc) matchSvc.invalidateCachedTurn(match.matchId);
    clearCurrentMatch();
    return {
      status: 'no_active_match',
      matchId: body.matchId ?? match.matchId,
      game: body.gameId ?? match.game,
      message: `Match ${body.status} on the server. Call queue_match to start a new game.`,
      fetchedVia: 'http',
    };
  }
  // If the server reports it is our turn, prime the match service's
  // cache so a follow-up take_turn resolves a sequence instead of
  // failing with no_turn_cached while the match WS is still opening
  // or hasn't received its re-emitted pending turn yet (#386).
  if (
    body.status === 'your_turn' &&
    matchSvc &&
    typeof body.sequence === 'number' &&
    Number.isFinite(body.sequence)
  ) {
    matchSvc.primeCachedTurn(match.matchId, body.sequence, body.view);
  }
  return {
    status: typeof body.status === 'string' ? body.status : 'unknown',
    matchId: body.matchId ?? match.matchId,
    game: body.gameId ?? match.game,
    sequence: typeof body.sequence === 'number' ? body.sequence : match.seq,
    view: body.view,
    myTurn: body.status === 'your_turn',
    fetchedVia: 'http',
  };
}

async function takeTurn(matchSvc, action) {
  const creds = readCredentials();
  if (!creds) return { ok: false, error: 'not_registered', message: NOT_REGISTERED_MESSAGE };
  const match = readCurrentMatch();
  if (!match) return { ok: false, error: 'no_active_match' };
  if (!matchSvc) return { ok: false, error: 'ws_not_ready' };
  if (!matchSvc.isSocketOpenFor(match.matchId)) {
    return { ok: false, error: 'ws_not_ready' };
  }
  return matchSvc.submitAction(match.matchId, action, TAKE_TURN_TIMEOUT_MS);
}

// ──────────────────────────────────────────────────────────────────────
// get_rules tool implementation
// ──────────────────────────────────────────────────────────────────────

async function getRules(gameId) {
  const creds = readCredentials();
  if (!creds) return { ok: false, error: 'not_registered', message: NOT_REGISTERED_MESSAGE };
  const url = `${creds.server}/api/games/${encodeURIComponent(gameId)}/rules`;
  const res = await httpRequest('GET', url, creds.apiKey, null);
  if (res.status === 404) {
    return { ok: false, error: 'game_not_found', gameId };
  }
  if (res.status !== 200) {
    return { ok: false, error: 'fetch_failed', httpStatus: res.status };
  }
  const body = res.data ?? {};
  return {
    ok: true,
    gameId: typeof body.gameId === 'string' ? body.gameId : gameId,
    version: typeof body.version === 'string' ? body.version : '',
    content: typeof body.content === 'string' ? body.content : '',
  };
}

// ──────────────────────────────────────────────────────────────────────
// get_strategy tool implementation
// ──────────────────────────────────────────────────────────────────────

async function getStrategy(gameId) {
  const creds = readCredentials();
  if (!creds) return { ok: false, error: 'not_registered', message: NOT_REGISTERED_MESSAGE };
  const url = `${creds.server}/api/games/${encodeURIComponent(gameId)}/strategy`;
  const res = await httpRequest('GET', url, creds.apiKey, null);
  if (res.status === 404) {
    return { ok: false, error: 'game_not_found', gameId };
  }
  if (res.status !== 200) {
    return { ok: false, error: 'fetch_failed', httpStatus: res.status };
  }
  const body = res.data ?? {};
  return {
    ok: true,
    gameId: typeof body.gameId === 'string' ? body.gameId : gameId,
    version: typeof body.version === 'string' ? body.version : '',
    content: typeof body.content === 'string' ? body.content : '',
  };
}

// ──────────────────────────────────────────────────────────────────────
// match WS service — /ws/game/:matchId
// ──────────────────────────────────────────────────────────────────────

function httpToWsUrl(serverUrl, matchId) {
  const u = new URL(serverUrl);
  const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${u.host}/ws/game/${matchId}`;
}

function makeMatchWsService(api) {
  const logger = api.logger;

  let stopped = false;
  let poller;
  let ws;
  let currentMatchId = null;
  let lastSeq = -1;
  let reconnectAttempts = 0;
  let reconnectTimer;
  let activeMatchForSeq = null;
  // Last-seen `your_turn` payload per matchId — drives get_turn's hot
  // path so the tool returns immediately without an outbound request
  // when the agent is asked to play.
  let cachedTurn = null;
  // Single-slot promise for take_turn ack correlation. Sequential turns
  // mean only one action can be in flight per match, so a single slot is
  // sufficient — don't build a request-id correlator.
  let pendingTakeTurn = null;

  function resolvePendingTakeTurn(result) {
    if (!pendingTakeTurn) return;
    const p = pendingTakeTurn;
    pendingTakeTurn = null;
    clearTimeout(p.timer);
    p.resolve(result);
  }

  function scheduleReconnect(matchId, creds) {
    if (stopped || currentMatchId !== matchId) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    logger.info?.(
      `[steamedclaw-match] reconnecting match ${matchId} in ${delay}ms (attempt ${reconnectAttempts})`,
    );
    reconnectTimer = setTimeout(() => connect(matchId, creds), delay);
  }

  function wakeAgent(reason) {
    try {
      api.runtime.system.requestHeartbeatNow();
      logger.info?.(`[steamedclaw-match] requested heartbeat wake (${reason})`);
    } catch (err) {
      logger.warn?.(`[steamedclaw-match] requestHeartbeatNow failed: ${err.message}`);
    }
  }

  function connect(matchId, creds) {
    if (stopped || currentMatchId !== matchId) return;
    const url = httpToWsUrl(creds.server, matchId);
    logger.info?.(`[steamedclaw-match] opening ${url}`);
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'User-Agent': PLUGIN_USER_AGENT,
      },
      handshakeTimeout: 15000,
    });
    ws = socket;

    socket.on('open', () => {
      reconnectAttempts = 0;
      logger.info?.(`[steamedclaw-match] connected match ${matchId}`);
    });

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      const type = msg?.type;
      if (type === 'connected') {
        logger.info?.(`[steamedclaw-match] handshake ok match ${matchId}`);
        return;
      }
      if (type === 'your_turn') {
        const seq = typeof msg.sequence === 'number' ? msg.sequence : -1;
        if (activeMatchForSeq !== matchId) {
          lastSeq = -1;
          activeMatchForSeq = matchId;
        }
        if (seq <= lastSeq) {
          logger.info?.(`[steamedclaw-match] your_turn seq ${seq} <= lastSeq ${lastSeq}, ignoring`);
          return;
        }
        lastSeq = seq;
        const game = readCurrentMatch()?.game || 'unknown';
        writeCurrentMatch(matchId, game, seq);
        cachedTurn = { matchId, game, sequence: seq, view: msg.view, cachedAt: Date.now() };
        wakeAgent(`your_turn seq=${seq}`);
        resolvePendingTakeTurn({
          ok: true,
          gameOver: false,
          matchStatus: 'your_turn',
          newSequence: seq,
          view: msg.view,
        });
        return;
      }
      if (type === 'game_over') {
        // Clear current-game.md so the next wake sees no active match.
        clearCurrentMatch();
        cachedTurn = null;
        const matchStatus = msg.reason === 'aborted' ? 'aborted' : 'completed';
        resolvePendingTakeTurn({
          ok: true,
          gameOver: true,
          matchStatus,
          results: msg.results,
          reason: msg.reason,
          replayUrl: msg.replayUrl,
        });
        wakeAgent('game_over');
        try {
          socket.close(1000, 'game_over');
        } catch {
          // ignore
        }
        return;
      }
      if (type === 'error') {
        const errorCode = typeof msg.error === 'string' ? msg.error : 'server_error';
        // not_your_turn means the server has advanced state without a
        // push this agent observed (turn-timeout forfeit, opponent moved
        // while we were stuck, or the match ended silently). The cached
        // `your_turn` payload is stale by definition — invalidate it so
        // the LLM's next get_turn falls through to HTTP and surfaces
        // fresh state instead of replaying the same dead view. Reset
        // lastSeq too so a subsequent prime or push at the prior
        // sequence isn't swallowed by the stale-seq guard (#396).
        if (errorCode === 'not_your_turn') {
          // Cache is known stale — the server has advanced past our
          // current view. Drop it so the LLM's next get_turn falls
          // through to HTTP. lastSeq is intentionally NOT reset:
          // the server only pushes monotonically-newer sequences,
          // and weakening the stale-seq guard could let a re-emitted
          // old push (e.g. on a match-WS reconnect) overwrite the
          // freshly-primed cache.
          invalidateCachedTurn(matchId);
          logger.info?.(
            `[steamedclaw-match] not_your_turn — invalidated cached turn for ${matchId}`,
          );
          resolvePendingTakeTurn({
            ok: false,
            error: errorCode,
            details:
              'Server advanced state without a push this agent observed. Cache cleared — call get_turn (or get_turn({refresh: true})) to fetch fresh state before retrying.',
            currentSequence: msg.currentSequence,
          });
          return;
        }
        logger.warn?.(`[steamedclaw-match] server error match ${matchId}: ${JSON.stringify(msg)}`);
        const errorResult = {
          ok: false,
          error: errorCode,
          details: msg.details,
          currentSequence: msg.currentSequence,
        };
        // Hint LLMs at get_rules so minimal SOULs have a recovery path (#397).
        if (errorCode === 'invalid_action') {
          const game = readCurrentMatch()?.game;
          errorResult.hint = game
            ? `Action shape rejected. Check the ${game} rules for the valid action schema (call get_rules({gameId: "${game}"}) if you don't already have them).`
            : `Action shape rejected. Call get_rules({gameId}) for the current game's action schema.`;
        }
        resolvePendingTakeTurn(errorResult);
        return;
      }
    });

    socket.on('close', (code, reason) => {
      logger.info?.(
        `[steamedclaw-match] closed match ${matchId} code=${code} reason=${reason?.toString?.('utf8') || ''}`,
      );
      if (!stopped && currentMatchId === matchId && code !== 1000) {
        scheduleReconnect(matchId, creds);
      }
    });

    socket.on('error', (err) => {
      logger.warn?.(`[steamedclaw-match] ws error match ${matchId}: ${err.message}`);
    });
  }

  function onMatchChange(matchId, creds) {
    if (matchId === currentMatchId) return;
    if (ws) {
      try {
        ws.removeAllListeners('close');
        ws.close(1000, 'match-change');
      } catch {
        // ignore
      }
      ws = undefined;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    // Any in-flight ack from the previous match is now meaningless —
    // drop it so callers don't wait forever on a socket that's gone.
    resolvePendingTakeTurn({ ok: false, error: 'match_changed' });
    cachedTurn = null;
    currentMatchId = matchId;
    reconnectAttempts = 0;
    if (matchId && creds) connect(matchId, creds);
  }

  function isSocketOpenFor(matchId) {
    if (!ws || currentMatchId !== matchId) return false;
    // ws's OPEN constant is 1; fall back to a numeric check so the mock
    // WS in tier-1 tests can fake-open by setting readyState directly.
    const openState = typeof WebSocket.OPEN === 'number' ? WebSocket.OPEN : 1;
    return ws.readyState === openState;
  }

  function getCachedTurn(matchId) {
    if (!cachedTurn || cachedTurn.matchId !== matchId) return null;
    return cachedTurn;
  }

  // Called from the get_turn HTTP fallback so the next take_turn can
  // resolve a sequence even before the match WS has received a push.
  // Mirrors the stale-sequence/cross-match guards in the `your_turn`
  // message handler but does NOT wake the agent or resolve a pending
  // take_turn ack — the agent already initiated this read, and waking
  // twice inside the same tool call is pointless and can drop (#372).
  //
  // Skipped while a take_turn is in flight: the push path owns ack
  // correlation, and priming `lastSeq` mid-flight could cause a
  // subsequent same-sequence push to be swallowed by the stale-seq
  // guard, starving the pending ack until timeout.
  function primeCachedTurn(matchId, sequence, view) {
    if (pendingTakeTurn) return;
    if (!matchId || typeof sequence !== 'number' || !Number.isFinite(sequence)) return;
    if (activeMatchForSeq !== matchId) {
      lastSeq = -1;
      activeMatchForSeq = matchId;
    }
    if (sequence <= lastSeq) return;
    lastSeq = sequence;
    const game = readCurrentMatch()?.game || 'unknown';
    writeCurrentMatch(matchId, game, sequence);
    cachedTurn = { matchId, game, sequence, view, cachedAt: Date.now() };
  }

  // Inverse of primeCachedTurn — drops the cached `your_turn` payload
  // so a follow-up get_turn falls through to HTTP. Called after a
  // `not_your_turn` server reply (cache is known stale) or from get_turn
  // when the LLM passes {refresh: true}. matchId is optional; pass it
  // to invalidate only when the cache belongs to a specific match
  // (avoids clobbering after a fast match-change race) (#396).
  function invalidateCachedTurn(matchId) {
    if (!cachedTurn) return;
    if (matchId && cachedTurn.matchId !== matchId) return;
    cachedTurn = null;
  }

  function submitAction(matchId, action, timeoutMs) {
    if (!isSocketOpenFor(matchId)) {
      return Promise.resolve({ ok: false, error: 'ws_not_ready' });
    }
    if (pendingTakeTurn) {
      return Promise.resolve({ ok: false, error: 'action_already_pending' });
    }
    const sequence = cachedTurn?.sequence ?? lastSeq;
    if (typeof sequence !== 'number' || sequence < 0) {
      return Promise.resolve({ ok: false, error: 'no_turn_cached' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingTakeTurn && pendingTakeTurn.resolve === resolve) {
          pendingTakeTurn = null;
          resolve({
            ok: false,
            error: 'timeout',
            message: `Server did not respond within ${timeoutMs} ms`,
          });
        }
      }, timeoutMs);
      pendingTakeTurn = { resolve, timer, sentSequence: sequence };
      try {
        ws.send(JSON.stringify({ type: 'action', sequence, payload: action }));
      } catch (err) {
        pendingTakeTurn = null;
        clearTimeout(timer);
        resolve({ ok: false, error: 'send_failed', message: err.message });
      }
    });
  }

  async function tick() {
    if (stopped) return;
    const creds = readCredentials();
    const match = readCurrentMatch();
    const nextMatchId = creds && match ? match.matchId : null;
    onMatchChange(nextMatchId, creds);
  }

  async function onMatchFoundExternal() {
    if (stopped) return;
    await tick();
  }

  return {
    id: 'steamedclaw-match-service',
    async start() {
      logger.info?.(`[steamedclaw-match] service starting (mode=${api.registrationMode})`);
      const creds = readCredentials();
      if (!creds) {
        logger.info?.('[steamedclaw-match] no credentials yet; waiting for register_agent');
      }
      await tick();
      poller = setInterval(() => {
        void tick().catch((e) => logger.warn?.(`[steamedclaw-match] tick error: ${e.message}`));
      }, MATCH_POLL_MS);
    },
    async stop() {
      stopped = true;
      if (poller) clearInterval(poller);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resolvePendingTakeTurn({ ok: false, error: 'service_stopped' });
      if (ws) {
        try {
          ws.close(1000, 'service-stop');
        } catch {
          // ignore
        }
      }
      logger.info?.('[steamedclaw-match] service stopped');
    },
    // Called by the register_agent tool after credentials.md is written.
    // Drives a tick so match-ws picks up any current match — idempotent
    // no-op when no match exists yet, which is the usual case on a
    // fresh register.
    async onCredentialsReady() {
      if (stopped) return;
      await tick();
    },
    getCachedTurn,
    primeCachedTurn,
    invalidateCachedTurn,
    submitAction,
    isSocketOpenFor,
    onMatchFoundExternal,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Queue-status poll fallback service (#385)
// ──────────────────────────────────────────────────────────────────────

/**
 * Degraded-mode fallback for the push-driven /ws/agent path. When the
 * agent has an outstanding queue marker (pending-queue.md) and
 * /ws/agent is not OPEN — upgrade rejected, 404-cap backoff, hostile
 * proxy stripping the WS upgrade — polls GET /api/matchmaking/status
 * every QUEUE_POLL_MS until either:
 *   - /ws/agent reaches OPEN (poll cancelled immediately via onAgentWsOpen)
 *   - the poll returns {status:'matched'} (writes current-game.md, wakes
 *     the agent, fires matchSvc.onMatchFoundExternal — same semantics as
 *     a push match_found), or
 *   - the poll returns {status:'not_queued'} (server has no record of
 *     this queue entry — marker cleared and polling pauses), or
 *   - the poll returns 401 (credentials invalidated — service stops).
 *
 * The push path is primary; this poll exists only to unwedge agents
 * when WS is unavailable. We keep QUEUE_POLL_MS at 30 s as a ceiling,
 * not a floor (#385).
 */
function makeQueuePollService(api, matchSvc) {
  const logger = api.logger;

  let stopped = false;
  let timer = null;
  let inFlight = false;
  // Starts false — by construction neither service has connected yet
  // on boot, so the initial state is "poll is eligible to run."
  let agentWsOpen = false;

  function wakeAgent(reason) {
    try {
      api.runtime.system.requestHeartbeatNow();
      logger.info?.(`[steamedclaw-queue-poll] requested heartbeat wake (${reason})`);
    } catch (err) {
      logger.warn?.(`[steamedclaw-queue-poll] requestHeartbeatNow failed: ${err.message}`);
    }
  }

  function scheduleNextTick() {
    if (stopped) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void tick().catch((e) => logger.warn?.(`[steamedclaw-queue-poll] tick error: ${e.message}`));
    }, QUEUE_POLL_MS);
  }

  async function tick() {
    if (stopped) return;
    if (agentWsOpen) return;
    const pending = readPendingQueue();
    if (!pending) {
      // No marker — pause the cycle. queueMatch's notifyMarkerWritten()
      // re-schedules when a fresh marker is written.
      return;
    }
    const creds = readCredentials();
    if (!creds) {
      scheduleNextTick();
      return;
    }
    // A second tick fired while the previous poll is still in flight
    // would create overlapping requests and thrash the server on a
    // slow response. Skip — the in-flight poll will schedule the next
    // tick when it completes.
    if (inFlight) {
      scheduleNextTick();
      return;
    }
    inFlight = true;
    let res;
    try {
      const url = `${creds.server}/api/matchmaking/status?gameId=${encodeURIComponent(
        pending.gameId,
      )}`;
      res = await httpRequest('GET', url, creds.apiKey, null);
    } catch (err) {
      inFlight = false;
      logger.warn?.(`[steamedclaw-queue-poll] status network error: ${err.message}`);
      scheduleNextTick();
      return;
    }
    inFlight = false;

    if (res.status === 401) {
      // Credentials have been invalidated server-side — looping the poll
      // is just 401 traffic. Stop the service and clear the marker.
      logger.warn?.(
        '[steamedclaw-queue-poll] 401 on status poll — credentials invalid, stopping poll',
      );
      clearPendingQueue();
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return;
    }

    if (res.status === 200) {
      const body = res.data ?? {};
      const status = typeof body.status === 'string' ? body.status : null;
      if (status === 'matched' && typeof body.matchId === 'string' && body.matchId) {
        const existing = readCurrentMatch();
        if (existing && existing.matchId === body.matchId) {
          // A concurrent match_found push (or an earlier poll tick) has
          // already wired up this match. Don't re-open the match WS
          // or re-wake the agent.
          logger.info?.(
            `[steamedclaw-queue-poll] status=matched matchId=${body.matchId} already active, no-op`,
          );
        } else {
          logger.info?.(
            `[steamedclaw-queue-poll] status=matched matchId=${body.matchId} game=${pending.gameId}`,
          );
          writeCurrentMatch(body.matchId, pending.gameId, 0);
          wakeAgent(`poll match_found ${pending.gameId}`);
          if (matchSvc) {
            matchSvc
              .onMatchFoundExternal()
              .catch((err) =>
                logger.warn?.(
                  `[steamedclaw-queue-poll] onMatchFoundExternal failed: ${err.message}`,
                ),
              );
          }
        }
        clearPendingQueue();
        // No further polling needed for this marker — a new queue_match
        // will write a fresh one and re-nudge the service.
        return;
      }
      if (status === 'not_queued') {
        // Server lost the queue entry (expired, cancelled, restart).
        // Clear the marker so we don't keep polling.
        logger.info?.(
          `[steamedclaw-queue-poll] status=not_queued for ${pending.gameId} — clearing marker`,
        );
        clearPendingQueue();
        return;
      }
      // status === 'queued' or unrecognized — keep polling at the ceiling.
      scheduleNextTick();
      return;
    }

    // 5xx or other transient non-2xx — stay at the 30 s ceiling. Don't
    // escalate (no faster retry) and don't break out of the cycle.
    logger.info?.(`[steamedclaw-queue-poll] status poll returned HTTP ${res.status}, backing off`);
    scheduleNextTick();
  }

  function onAgentWsOpen() {
    agentWsOpen = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
      logger.info?.('[steamedclaw-queue-poll] /ws/agent open — cancelling scheduled poll');
    }
  }

  function onAgentWsClosed() {
    agentWsOpen = false;
    if (stopped) return;
    // Re-arm the cycle if there's outstanding work. Cheap no-op if not.
    if (readPendingQueue()) scheduleNextTick();
  }

  function notifyMarkerWritten() {
    if (stopped) return;
    if (!agentWsOpen) scheduleNextTick();
  }

  return {
    id: 'steamedclaw-queue-poll-service',
    async start() {
      if (api.registrationMode !== 'full') {
        logger.info?.(
          `[steamedclaw-queue-poll] skipped (mode=${api.registrationMode}); waiting for full registration`,
        );
        return;
      }
      // Startup recovery: if pending-queue.md survived a restart, start
      // the poll cycle immediately — don't wait for /ws/agent to fail.
      // The first tick fires QUEUE_POLL_MS later; if /ws/agent opens in
      // the meantime, onAgentWsOpen cancels it. Clean boot with no
      // marker leaves the cycle paused (no leak).
      if (readPendingQueue()) {
        logger.info?.('[steamedclaw-queue-poll] pending-queue.md present on boot — starting poll');
        scheduleNextTick();
      }
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      logger.info?.('[steamedclaw-queue-poll] service stopped');
    },
    // Called by the register_agent tool after credentials.md is written.
    // No-op unless a pending marker already exists (which would be
    // unusual on a fresh register, but possible if the operator seeded
    // pending-queue.md externally or credentials.md was deleted mid-queue).
    async onCredentialsReady() {
      if (stopped) return;
      if (readPendingQueue() && !agentWsOpen) scheduleNextTick();
    },
    onAgentWsOpen,
    onAgentWsClosed,
    notifyMarkerWritten,
  };
}

// ──────────────────────────────────────────────────────────────────────
// /ws/agent client (issue #346)
// ──────────────────────────────────────────────────────────────────────

function httpToAgentWsUrl(serverUrl) {
  const u = new URL(serverUrl);
  const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${u.host}/ws/agent`;
}

/**
 * Holds a single /ws/agent socket open for server-pushed queue-side events.
 * On `match_found`, writes current-game.md, calls requestHeartbeatNow so
 * the LLM wakes, and triggers matchSvc.onMatchFoundExternal() so the
 * match-WS socket opens immediately — not on the next 5-s tick (#367).
 */
function makeAgentWsService(api, matchSvc, pollSvc) {
  const logger = api.logger;

  let stopped = false;
  let ws;
  let reconnectTimer;
  let reconnectAttempts = 0;
  let currentServer = null;
  let capabilityLoggedMissing = false;
  // Raised reconnect cap after a 404 upgrade rejection — reset on next
  // successful `open` (#358 Finding 6).
  let sawRecent404 = false;

  function wakeAgent(reason) {
    try {
      api.runtime.system.requestHeartbeatNow();
      logger.info?.(`[steamedclaw-agent] requested heartbeat wake (${reason})`);
    } catch (err) {
      logger.warn?.(`[steamedclaw-agent] requestHeartbeatNow failed: ${err.message}`);
    }
  }

  function scheduleReconnect(creds) {
    if (stopped) return;
    // Exponential backoff with random jitter (0.75×–1.25×) so a
    // fleet-wide outage doesn't produce a thundering herd when the
    // server comes back up (#358 Finding 5).
    const jitter = 0.75 + Math.random() * 0.5;
    const cap = sawRecent404 ? AGENT_WS_RECONNECT_404_MAX_MS : AGENT_WS_RECONNECT_MAX_MS;
    const delay = Math.min(AGENT_WS_RECONNECT_BASE_MS * 2 ** reconnectAttempts * jitter, cap);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => connect(creds), delay);
  }

  function handleMatchFound(msg) {
    const matchId = typeof msg.matchId === 'string' ? msg.matchId : null;
    const gameId = typeof msg.gameId === 'string' ? msg.gameId : null;
    if (!matchId || !gameId) {
      logger.warn?.(
        `[steamedclaw-agent] match_found missing matchId/gameId: ${JSON.stringify(msg)}`,
      );
      return;
    }
    const existing = readCurrentMatch();
    if (existing && existing.matchId === matchId) {
      logger.info?.(`[steamedclaw-agent] match_found ${matchId} already active, no-op`);
      // Pending marker is stale by definition once we're matched — the
      // poll-path idempotency guard relies on it being cleared.
      clearPendingQueue();
      return;
    }
    if (existing && existing.matchId !== matchId) {
      logger.warn?.(
        `[steamedclaw-agent] overriding stale current-game.md matchId=${existing.matchId} → ${matchId}`,
      );
    }
    writeCurrentMatch(matchId, gameId, 0);
    clearPendingQueue();
    logger.info?.(`[steamedclaw-agent] match_found matchId=${matchId} game=${gameId}`);
    wakeAgent(`match_found ${gameId}`);
    if (matchSvc) {
      matchSvc
        .onMatchFoundExternal()
        .catch((err) =>
          logger.warn?.(`[steamedclaw-agent] onMatchFoundExternal failed: ${err.message}`),
        );
    }
  }

  function connect(creds) {
    if (stopped) return;
    currentServer = creds.server;
    const url = httpToAgentWsUrl(creds.server);
    logger.info?.(`[steamedclaw-agent] opening ${url}`);
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'User-Agent': PLUGIN_USER_AGENT,
      },
      handshakeTimeout: 15000,
    });
    if (stopped) {
      try {
        socket.close(1000, 'service-stop');
      } catch {
        // ignore
      }
      return;
    }
    ws = socket;

    socket.on('open', () => {
      reconnectAttempts = 0;
      capabilityLoggedMissing = false;
      sawRecent404 = false;
      // Push path is primary — cancel any scheduled /api/matchmaking/status
      // poll immediately (not on the next 30s tick). The poll service
      // resumes when this socket closes (#385 race: "poll cancelled as
      // soon as /ws/agent reaches OPEN").
      if (pollSvc) pollSvc.onAgentWsOpen();
    });

    socket.on('unexpected-response', (_req, res) => {
      if (!capabilityLoggedMissing) {
        logger.info?.(
          `[steamedclaw-agent] upgrade rejected status=${res.statusCode} — /ws/agent may be disabled; falling back to poll`,
        );
        capabilityLoggedMissing = true;
      }
      if (res.statusCode === 404) {
        sawRecent404 = true;
      }
    });

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      const type = msg?.type;
      if (type === 'connected') {
        logger.info?.(`[steamedclaw-agent] handshake ok agent=${msg.agentId}`);
        return;
      }
      if (type === 'match_found') {
        handleMatchFound(msg);
        return;
      }
      if (type === 'replaced') {
        logger.info?.(`[steamedclaw-agent] replaced by newer connection`);
        return;
      }
      if (type === 'error') {
        logger.warn?.(`[steamedclaw-agent] server error: ${JSON.stringify(msg)}`);
        return;
      }
    });

    socket.on('close', (code) => {
      if (stopped) return;
      // Any transition out of OPEN reactivates the poll fallback so an
      // outstanding queue marker gets picked up even during backoff.
      // Harmless on clean 1000 close below — the poll short-circuits if
      // there's no marker.
      if (pollSvc) pollSvc.onAgentWsClosed();
      const fresh = readCredentials();
      if (!fresh) return;
      if (code === 1000) return;
      scheduleReconnect(fresh);
    });

    socket.on('error', (err) => {
      logger.warn?.(`[steamedclaw-agent] ws error: ${err.message}`);
    });
  }

  return {
    id: 'steamedclaw-agent-service',
    async start() {
      if (api.registrationMode !== 'full') {
        logger.info?.(
          `[steamedclaw-agent] skipped (mode=${api.registrationMode}); waiting for full registration`,
        );
        return;
      }
      const creds = readCredentials();
      if (!creds) {
        logger.info?.(
          '[steamedclaw-agent] no credentials yet; waiting for register_agent to open /ws/agent',
        );
        return;
      }
      connect(creds);
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.removeAllListeners('close');
          ws.close(1000, 'service-stop');
        } catch {
          // ignore
        }
      }
      logger.info?.('[steamedclaw-agent] service stopped');
    },
    // Called by the register_agent tool after credentials.md is written.
    // Opens /ws/agent so the newly-registered agent starts receiving
    // match_found pushes immediately rather than waiting for next reconnect.
    async onCredentialsReady() {
      if (stopped) return;
      if (ws) return;
      const creds = readCredentials();
      if (!creds) return;
      connect(creds);
    },
    /** Testing hook: expose current server for assertions. */
    _currentServer() {
      return currentServer;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Plugin entry
// ──────────────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: 'steamedclaw-plugin',
  name: 'SteamedClaw',
  description:
    'register_agent + queue_match + get_turn + take_turn + get_rules + get_strategy tools backed by /ws/agent and /ws/game push sockets.',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      server: { type: 'string' },
      defaultLane: { type: 'string', enum: PLUGIN_LANES },
    },
  },
  register(api) {
    const cfg = api.pluginConfig ?? {};
    // The match service owns the cached `your_turn` payload and the
    // single-slot ack for take_turn, so we build it once here and let
    // both tools call into the same instance. In non-full mode (no
    // service registration) the tools still work — getCachedTurn
    // returns null, isSocketOpenFor returns false, and get_turn falls
    // through to the HTTP path while take_turn reports ws_not_ready.
    const matchSvc = makeMatchWsService(api);
    // Always construct the poll service so queueMatch can call
    // pollSvc.notifyMarkerWritten() unconditionally. Service
    // registration (start/stop lifecycle) is gated on full mode + agent-ws
    // below; the poll's scheduleNextTick still works via notifyMarkerWritten
    // in agent-ws-disabled mode so queued→matched recovery is never lost.
    const pollSvc = makeQueuePollService(api, matchSvc);
    const agentSvc = makeAgentWsService(api, matchSvc, pollSvc);
    const registerAgent = makeRegisterAgent(api, matchSvc, agentSvc, pollSvc);

    api.registerTool({
      name: 'register_agent',
      description:
        "Register this plugin agent with the SteamedClaw server. Pass {name, model?} — name is the agent identity (max 64 chars, letters/numbers/hyphens/spaces/underscores only, immutable once registered, must be unique across SteamedClaw); model is optional (your LLM model identifier for model-performance stats). Use your SOUL-defined identity for name. Returns {ok, id?, name?, model?, apiKey?, claimUrl?, verificationCode?, operatorNotice?, error?, nameAttempted?, httpStatus?, message?}. On ok:true registration succeeded — surface the operatorNotice in your next message to the operator so they can link this agent to their SteamedClaw account. On error='already_registered' credentials already exist — skip and proceed with queue_match, get_turn, etc. On error='name_taken' (HTTP 409) pick a different name and call again. On error='invalid_name' (HTTP 400) the name violates the character rules — pick a conforming name. On error='network_error' retry in a moment. On error='config_error' the operator hasn't configured the server — surface the message in your next output. On error='persist_failed' the server registered the agent but local persistence failed — operator action required.",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Agent name (1-64 chars, letters/numbers/hyphens/spaces/underscores). Must be unique across SteamedClaw. Immutable once registered.',
          },
          model: {
            type: 'string',
            description:
              "Optional LLM model identifier (e.g. 'claude-opus-4-7'). Populates agent model-performance stats. Immutable once set.",
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async execute(_toolCallId, { name, model }) {
        try {
          const payload = await registerAgent(name, model);
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
        } catch (err) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: false, error: 'exception', message: err.message }),
              },
            ],
            isError: true,
          };
        }
      },
    });

    api.registerTool({
      name: 'queue_match',
      description:
        "Queue for a SteamedClaw match on the given game. Pass {gameId, lane?} — gameId e.g. 'tic-tac-toe', 'nim', 'four-in-a-row'; optional lane is 'fast' (low-latency agents; tight timeouts) or 'standard' (heartbeat-paced agents; longer per-turn windows). Omit lane to use the plugin's configured defaultLane (default 'fast' — this plugin is WS push-driven so fast is the expected posture; owners with a heartbeat-paced runtime should set defaultLane 'standard' in plugin config). A per-call lane argument overrides the config default. Returns {ok, status, matchId?, game, position?, error?}. On status='matched' the plugin has already written the new matchId to local state — the match WS will wake you on `your_turn`. On status='queued' no pairing was available yet; the plugin is holding the queue-side /ws/agent socket open and will wake you when a match is found. Do NOT call queue_match again after a `queued` — repeat calls return error='already_in_match' once paired, and spamming creates queue churn. On error='game_not_found' (HTTP 404), the gameId is invalid — pick a supported game. On error='invalid_lane' the lane argument was not 'fast' or 'standard'. On error='not_registered' no credentials are present; call register_agent({name}) first.",
      parameters: {
        type: 'object',
        properties: {
          gameId: {
            type: 'string',
            description:
              "Game ID to queue for. Known values include 'tic-tac-toe', 'nim', 'four-in-a-row'.",
          },
          lane: {
            type: 'string',
            enum: PLUGIN_LANES,
            description:
              "Optional match lane. 'fast' = continuous-runtime agents (tight timeouts); 'standard' = heartbeat-paced agents (longer per-turn windows). Omit to use the plugin's configured defaultLane.",
          },
        },
        required: ['gameId'],
        additionalProperties: false,
      },
      async execute(_toolCallId, { gameId, lane }) {
        try {
          if (lane !== undefined && !PLUGIN_LANES.includes(lane)) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: false,
                    error: 'invalid_lane',
                    message: `lane must be one of ${PLUGIN_LANES.join(', ')}`,
                  }),
                },
              ],
              isError: true,
            };
          }
          const resolvedLane = lane ?? cfg.defaultLane ?? PLUGIN_DEFAULT_LANE;
          const payload = await queueMatch(gameId, resolvedLane, pollSvc);
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
        } catch (err) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: false, error: 'exception', message: err.message }),
              },
            ],
            isError: true,
          };
        }
      },
    });

    api.registerTool({
      name: 'get_turn',
      description:
        "Read the current turn state for your active match. Pass {refresh?: true} to bypass the cache and force a fresh fetch from the server — use this if take_turn just returned not_your_turn (the cache may be stale because the server advanced state without notifying this agent). Returns {status, matchId?, game?, sequence?, view?, myTurn?, fetchedVia?, message?, error?, httpStatus?}. The default (no refresh) hot path hits the plugin's cache of the last `your_turn` push and returns immediately — no outbound request. With refresh:true (or when no push has landed yet) the plugin issues GET /api/matches/:id/state?wait=false and marks fetchedVia:'http'. status='no_active_match' means there is no live match — either you haven't queued yet OR the server has ended the match (call queue_match to start a new one). status='not_registered' means no credentials — call register_agent({name}) first.",
      parameters: {
        type: 'object',
        properties: {
          refresh: {
            type: 'boolean',
            description:
              'Optional. If true, bypass the plugin cache and fetch fresh state from the server. Use this after take_turn returns not_your_turn — the cached `your_turn` payload is stale and will keep returning isYourTurn:true forever otherwise.',
          },
        },
        additionalProperties: false,
      },
      async execute(_toolCallId, args) {
        try {
          const refresh = args?.refresh === true;
          const payload = await getTurn(matchSvc, { refresh });
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
        } catch (err) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'error', error: 'exception', message: err.message }),
              },
            ],
            isError: true,
          };
        }
      },
    });

    api.registerTool({
      name: 'get_rules',
      description:
        "Fetch the mechanical rules (action shapes, phase transitions, edge cases) for a SteamedClaw game. Pass {gameId} (e.g. 'tic-tac-toe', 'murder-mystery-5', 'werewolf-7', 'falkens-maze', 'liars-dice'). Returns {ok, gameId, version, content, error?, httpStatus?}. Call this ONCE per match when you start a new gameId — rules change rarely so you don't need to re-fetch mid-match. Strongly recommended for SteamedClaw-specific games (murder-mystery-5, murder-mystery-7, werewolf-7, falkens-maze, liars-dice) where the action JSON shapes are not in your training data; without the rules, every action will be invalid and your match-abort budget will burn on turn 1. On error='game_not_found' (HTTP 404) the gameId is invalid. On error='not_registered' no credentials are present — call register_agent({name}) first.",
      parameters: {
        type: 'object',
        properties: {
          gameId: {
            type: 'string',
            description:
              "Game ID to fetch rules for. Known values include 'tic-tac-toe', 'nim', 'four-in-a-row', 'liars-dice', 'werewolf-7', 'murder-mystery-5', 'murder-mystery-7', 'falkens-maze', 'prisoners-dilemma', 'reversi', 'chess', 'checkers', 'backgammon', 'mancala'.",
          },
        },
        required: ['gameId'],
        additionalProperties: false,
      },
      async execute(_toolCallId, { gameId }) {
        try {
          const payload = await getRules(gameId);
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
        } catch (err) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: false, error: 'exception', message: err.message }),
              },
            ],
            isError: true,
          };
        }
      },
    });

    api.registerTool({
      name: 'get_strategy',
      description:
        "Optional — fetch human-curated strategic hints for a SteamedClaw game. Safe to skip: rules + your turn view are sufficient to play, and strong models often already know better strategy than a short hint provides. Loading hints can actually degrade strong-model play by anchoring on a shallow heuristic. Consider calling this only if you are a weaker or newer model, if the gameId is unfamiliar after reading the rules, or if a match is not going well and you want a baseline heuristic. Pass {gameId} (e.g. 'tic-tac-toe'). Returns {ok, gameId, version, content, error?, httpStatus?}. On error='game_not_found' (HTTP 404) the gameId is invalid. On error='not_registered' no credentials are present — call register_agent({name}) first.",
      parameters: {
        type: 'object',
        properties: {
          gameId: {
            type: 'string',
            description:
              "Game ID to fetch strategy hints for. Known values include 'tic-tac-toe', 'nim', 'four-in-a-row', 'liars-dice', 'werewolf-7', 'murder-mystery-5', 'murder-mystery-7', 'falkens-maze', 'prisoners-dilemma', 'reversi', 'chess', 'checkers', 'backgammon', 'mancala'.",
          },
        },
        required: ['gameId'],
        additionalProperties: false,
      },
      async execute(_toolCallId, { gameId }) {
        try {
          const payload = await getStrategy(gameId);
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
        } catch (err) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: false, error: 'exception', message: err.message }),
              },
            ],
            isError: true,
          };
        }
      },
    });

    api.registerTool({
      name: 'take_turn',
      description:
        "Submit a move for your active match over the open game WebSocket. Pass {action: <move>} where the move shape is game-specific (e.g. {type:'move', position:4} for tic-tac-toe, {type:'take', pile, count} for nim, {type:'drop', column} for four-in-a-row). Returns {ok, gameOver?, matchStatus?, newSequence?, view?, results?, error?, details?, currentSequence?, hint?}. On ok:true gameOver:false the server sent your_turn again — use the new view for the next decision. On ok:true gameOver:true the match ended; `results` carries the outcome. On error='ws_not_ready' the match WS isn't open yet — wait a moment (the plugin will reconnect) and retry. On error='stale_sequence' a newer your_turn already arrived; call get_turn to refresh and retry. On error='invalid_action' the move shape didn't match the game's action schema; the response includes a `hint` field pointing at get_rules — fetch the rules and retry with a conformant action. On error='not_your_turn' the server has advanced state without a push this agent observed (the previous turn timed out, the opponent moved, or the match has ended). The plugin clears its stale cache automatically; call get_turn({refresh: true}) to fetch fresh state and decide what to do (it may be the opponent's turn or the match may have ended). Do NOT loop on take_turn after this error — every retry will return the same not_your_turn until you refresh. On error='timeout' nothing was received for ~8 min — the match may still be live; call get_turn to re-check and only retry if myTurn is still true. On error='not_registered' no credentials are present — call register_agent({name}) first.",
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'object',
            description:
              "The game action object. Shape depends on the game (e.g. {type:'move', position:4} for tic-tac-toe).",
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async execute(_toolCallId, { action }) {
        try {
          const payload = await takeTurn(matchSvc, action);
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
        } catch (err) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: false, error: 'exception', message: err.message }),
              },
            ],
            isError: true,
          };
        }
      },
    });

    if (api.registrationMode === 'full') {
      api.registerService(matchSvc);
      api.registerService(agentSvc);
      api.registerService(pollSvc);
    } else {
      api.logger.info?.(
        `[steamedclaw-match] services NOT registered (mode=${api.registrationMode}); tools still available`,
      );
    }
  },
});
