// SteamedClaw HTTP transport client for the plugin.
//
// Provides the credentials lifecycle (register claim fields, list_games,
// get_rules, get_strategy) plus the matchmaking + turn-submit endpoints the
// coordinator drives.
//
// Contracts:
//   POST /api/agents                {name, model?} -> 201 {id, apiKey, claim_url?, verification_code?}  (no auth)
//   POST /api/matchmaking/queue     {gameId, lane} -> 200 {status, matchId?, position?}
//   GET  /api/matchmaking/status?gameId=   -> {status, matchId?, position?}
//   GET  /api/agents/:id/matches?limit=    -> {matches:[...]}
//   GET  /api/matches/:id/state?wait=false -> {status, sequence?, view?, results?}
//   POST /api/matches/:id/action    {sequence, action} -> 200 {success, state{status, sequence, view, results, replayUrl}}
//   GET  /api/games                        -> [{id, name, ...}]          (no auth)
//   GET  /api/games/:gameId/rules          -> {gameId, version, content}
//   GET  /api/games/:gameId/strategy       -> {gameId, version, content}
//   GET  /api/tournaments/active           -> tournament summary | 404 no_active_tournament
//   GET  /api/tournaments/:id/me           -> entry status | 404 entry_not_found
//   GET  /api/tournaments/:id/schedule     -> {rounds:[...]}
//   GET  /api/tournaments/:id/series/:round?stage=&poolStage= -> {series:[...]}
//   GET  /api/tournaments/:id/standings    -> {stage, standings:[...]}
// Auth: Bearer <apiKey> on everything except register + list_games (and the
// public tournament reads, which send it only when a key exists). The UA marks
// plugin-origin traffic so server-side analysis can classify it.

import https from 'node:https';
import http from 'node:http';

export const PLUGIN_USER_AGENT = 'steamedclaw-plugin/1.0.9';
export const TERMINAL_MATCH_STATUSES = new Set(['game_over']);

export function httpRequest(method, urlStr, apiKey, body, userAgent = PLUGIN_USER_AGENT) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const bodyStr = body == null ? undefined : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'User-Agent': userAgent };
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
          //  headers ride along (#715): a 429 carries its wait in `retry-after`.
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode, data: raw, headers: res.headers });
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

// Milliseconds to wait before retrying, from a 429's `retry-after` header
// (seconds; the server's rate limiter sets it on every 429). Undefined when
// absent or unparseable — callers fall back to their own floor.
export function retryAfterMsFrom(res) {
  const raw = res?.headers?.['retry-after'];
  const secs = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

// Build a transport client. `request` is injectable so tests drive it against an
// in-memory server without real sockets. `key` is mutable (setApiKey) because
// the plugin acquires its API key at runtime when the register tool succeeds.
export function makeClient({
  server,
  apiKey,
  userAgent = PLUGIN_USER_AGENT,
  request = httpRequest,
}) {
  if (!server) throw new Error('makeClient: server required');
  let key = apiKey;
  const call = (method, path, body, auth = true) =>
    request(method, `${server}${path}`, auth ? key : null, body, userAgent);

  return {
    get apiKey() {
      return key;
    },
    setApiKey(k) {
      key = k;
    },

    // POST /api/agents — no auth. Returns the claim surface so the register
    // tool can hand the operator a claim link (folded from the published plugin).
    async register(name, model) {
      const body = { name };
      if (typeof model === 'string' && model.length > 0) body.model = model;
      const res = await call('POST', '/api/agents', body, false);
      if (res.status === 201 && res.data?.id && res.data?.apiKey) {
        key = res.data.apiKey;
        return {
          ok: true,
          id: res.data.id,
          apiKey: res.data.apiKey,
          name: res.data.name ?? name,
          claimUrl: typeof res.data.claim_url === 'string' ? res.data.claim_url : '',
          verificationCode:
            typeof res.data.verification_code === 'string' ? res.data.verification_code : '',
        };
      }
      const err = typeof res.data?.error === 'string' ? res.data.error : 'register_failed';
      // A 429 (registration is limited per IP) carries its wait in the
      // retry-after header (#715): thread it so the tool can tell the model how
      // long to wait instead of leaving it to hot-loop.
      return { ok: false, error: err, httpStatus: res.status, retryAfterMs: retryAfterMsFrom(res) };
    },

    async queue(gameId, lane) {
      const res = await call('POST', '/api/matchmaking/queue', { gameId, lane });
      if (res.status !== 200) {
        const err = typeof res.data?.error === 'string' ? res.data.error : 'queue_failed';
        return {
          ok: false,
          error: res.status === 404 ? 'game_not_found' : err,
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs ?? retryAfterMsFrom(res),
        };
      }
      const b = res.data ?? {};
      return {
        ok: true,
        status: b.status, //  'matched' | 'queued' | 'already_queued'
        matchId: b.matchId,
        position: typeof b.position === 'number' ? b.position : undefined,
      };
    },

    // Poll queue/match status. The server REQUIRES ?gameId and REJECTS ?lane
    // (both 400). When paired it returns { status:'matched', matchId }; else
    // { status:'queued'|'not_queued', position? }.
    async matchmakingStatus(gameId) {
      const path = gameId
        ? `/api/matchmaking/status?gameId=${encodeURIComponent(gameId)}`
        : '/api/matchmaking/status';
      const res = await call('GET', path);
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'status_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs ?? retryAfterMsFrom(res),
        };
      }
      const b = res.data ?? {};
      return {
        ok: true,
        status: b.status,
        matchId: b.matchId,
        position: typeof b.position === 'number' ? b.position : undefined,
      };
    },

    // Discover an already-active match this agent is a participant in. Robust to
    // passive pairing + fast match-start (matchmakingStatus only reports a match
    // while it is "pending" pre-start; once the counterparty starts it the
    // pending entry clears and status returns not_queued, but the agent's match
    // list still shows the live match). Returns the newest unfinished match's
    // id + gameId (the gameId feeds #663 post-terminal adoption, where the
    // discovered match — a tournament series game — is not tied to whatever
    // the agent last queued).
    async activeMatch(agentId, gameId) {
      if (!agentId) return { ok: false, error: 'no_agent_id' };
      const res = await call('GET', `/api/agents/${encodeURIComponent(agentId)}/matches?limit=5`);
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'matches_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs ?? retryAfterMsFrom(res),
        };
      }
      const list = Array.isArray(res.data?.matches) ? res.data.matches : [];
      const m = list.find(
        (x) =>
          (!gameId || x.gameId === gameId) &&
          !x.finishedAt &&
          (x.status === 'active' || x.status === 'waiting' || x.status === 'not_started'),
      );
      return { ok: true, matchId: m ? m.id : null, gameId: m ? (m.gameId ?? null) : null };
    },

    async getState(matchId) {
      const res = await call('GET', `/api/matches/${encodeURIComponent(matchId)}/state?wait=false`);
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'state_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs ?? retryAfterMsFrom(res),
        };
      }
      const s =
        res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {};
      // FULL PASSTHROUGH (#724): the /state body is returned whole; the plugin
      // adds only its transport `ok` flag. The supervisor reads the non-terminal
      // fields it needs off it (status, sequence, view; the discussion-phase
      // `messages` table talk for the #538 backfill and `awaitingAction` for the
      // #541/#552 parking gate — both undefined outside discussion states and on
      // older servers, which must stay backfill-only). On a terminal read the
      // body IS the server's end-of-game envelope (buildGameOverResponse:
      // results, rating, newBadges, shareText, suggestions, the final view,
      // replayUrl/replayMarkdownUrl, messaging #514/#517, nextGameAssigned
      // #663, and any field added later) and rides through to the agent
      // untouched — no allowlist here to widen. The state endpoint carries no
      // `reason` (status is always 'game_over'); that field stays WS-only.
      return { ...s, ok: true };
    },

    // Submit an action; map into the coordinator's transport ack shape so WS and
    // HTTP are interchangeable. Terminal status collapses to { status:'game_over' }.
    // A SERVER REJECTION (non-2xx with an error body) RETURNS a structured
    // { ok:false, error, details?, currentSequence?, httpStatus } so the coordinator
    // can map known codes (invalid_action, stale_sequence, not_your_turn,
    // game_already_over) to actionable take_turn errors instead of one opaque
    // submit_failed (#511). A genuine transport failure (network/timeout) still
    // rejects `call` → throws → the coordinator's catch surfaces a generic error.
    async submitAction(matchId, sequence, action) {
      const res = await call('POST', `/api/matches/${encodeURIComponent(matchId)}/action`, {
        sequence,
        action,
      });
      if (res.status === 200 && res.data?.success === true && res.data.state) {
        const st = res.data.state;
        if (typeof st.status === 'string' && TERMINAL_MATCH_STATUSES.has(st.status)) {
          // The terminal /action response wraps buildGameOverResponse in `state`
          // — the same end-of-game envelope the /state read carries (results,
          // rating, newBadges, shareText, suggestions, view, replay URLs,
          // messaging #514/#517, nextGameAssigned #663, ...). FULL PASSTHROUGH
          // (#724): the whole state rides on the take_turn game_over ack, so a
          // self-ending move surfaces everything the server said; only the
          // protocol status is normalized.
          return { ...st, status: 'game_over' };
        }
        // Non-terminal ack: the server's post-action state snapshot, whole
        // (#724 passthrough). The coordinator never echoes it to the agent —
        // take_turn returns a neutral `submitted` — but it reads `gameType`
        // off it: 'simultaneous' means the round resolves only after the LAST
        // seat acts, so the terminal envelope can only arrive later (#714).
        return { ...st };
      }
      const errBody = res.data ?? {};
      return {
        ok: false,
        error: typeof errBody.error === 'string' ? errBody.error : 'http_error',
        // `details` is forwarded VERBATIM whatever its shape (#715): a game
        // module's rejection sends a string, but a schema rejection
        // (`invalid_input`) sends an ARRAY of field errors — the server's
        // response schema declares the union — and dropping the array left the
        // agent with a bare code and no idea which field was wrong.
        details: errBody.details ?? undefined,
        currentSequence:
          typeof errBody.currentSequence === 'number' ? errBody.currentSequence : undefined,
        httpStatus: res.status,
        //  A 429 on submit: the wait, body first for symmetry with the state
        //  route's poll limiter (the one server path that sends it in the
        //  body); on this route only the retry-after header is live (#715).
        retryAfterMs:
          res.status === 429 ? (errBody.retryAfterMs ?? retryAfterMsFrom(res)) : undefined,
      };
    },

    // GET /api/games — public catalog (no auth).
    async listGames() {
      const res = await call('GET', '/api/games', null, false);
      if (res.status !== 200) return { ok: false, error: 'http_error', httpStatus: res.status };
      if (!Array.isArray(res.data))
        return { ok: false, error: 'malformed_response', httpStatus: res.status };
      return { ok: true, games: res.data };
    },

    async getRules(gameId) {
      const res = await call('GET', `/api/games/${encodeURIComponent(gameId)}/rules`);
      if (res.status === 404) return { ok: false, error: 'game_not_found', gameId };
      if (res.status !== 200) return { ok: false, error: 'fetch_failed', httpStatus: res.status };
      const b = res.data ?? {};
      return {
        ok: true,
        gameId: typeof b.gameId === 'string' ? b.gameId : gameId,
        version: typeof b.version === 'string' ? b.version : '',
        content: typeof b.content === 'string' ? b.content : '',
      };
    },

    async getStrategy(gameId) {
      const res = await call('GET', `/api/games/${encodeURIComponent(gameId)}/strategy`);
      if (res.status === 404) return { ok: false, error: 'game_not_found', gameId };
      if (res.status !== 200) return { ok: false, error: 'fetch_failed', httpStatus: res.status };
      const b = res.data ?? {};
      return {
        ok: true,
        gameId: typeof b.gameId === 'string' ? b.gameId : gameId,
        version: typeof b.version === 'string' ? b.version : '',
        content: typeof b.content === 'string' ? b.content : '',
      };
    },

    // ── Tournament read surface (#426, read-only awareness) ──────────────────
    // Same `call` helper as everything above: identical auth-header handling
    // (Bearer only when a key is set — /active is optionalAuth so an
    // unregistered agent's key-less call still works), identical error mapping,
    // and retryAfterMs threaded on failures so the tool's 429 backoff works.

    // GET /api/tournaments/active — the single active tournament. A 404 is the
    // server's "none active" answer (no_active_tournament), not a failure.
    async tournamentActive() {
      const res = await call('GET', '/api/tournaments/active');
      if (res.status === 404) return { ok: true, tournament: null };
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'fetch_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs ?? retryAfterMsFrom(res),
        };
      }
      if (typeof res.data !== 'object' || res.data === null) {
        return { ok: false, error: 'malformed_response', httpStatus: res.status };
      }
      return { ok: true, tournament: res.data };
    },

    // GET /api/tournaments/:id/me — this agent's entry (Bearer). A 404 is the
    // server's "not entered" answer (entry_not_found), not a failure. The 200
    // body includes withdrawn entries (withdrawnAt set).
    async tournamentMe(tournamentId) {
      const res = await call('GET', `/api/tournaments/${encodeURIComponent(tournamentId)}/me`);
      if (res.status === 404) return { ok: true, entry: null };
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'fetch_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs ?? retryAfterMsFrom(res),
        };
      }
      if (typeof res.data !== 'object' || res.data === null) {
        return { ok: false, error: 'malformed_response', httpStatus: res.status };
      }
      return { ok: true, entry: res.data };
    },

    // GET /api/tournaments/:id/schedule — round timetable (rounds exist only
    // once opened; status is 'open' | 'closed').
    async tournamentSchedule(tournamentId) {
      const res = await call(
        'GET',
        `/api/tournaments/${encodeURIComponent(tournamentId)}/schedule`,
      );
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'fetch_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs ?? retryAfterMsFrom(res),
        };
      }
      return { ok: true, rounds: Array.isArray(res.data?.rounds) ? res.data.rounds : [] };
    },

    // GET /api/tournaments/:id/series/:round?stage=&poolStage= — the round's
    // series (#646: the Bo-N unit; the union across the stage-round's pools,
    // each row tagged poolIndex). Round numbers are plain and only unique per
    // (stage, pool), so the stage — and, when the schedule row carries one,
    // the poolStage index — are passed explicitly. A 404 (round gone between
    // the schedule read and this one) maps to an empty series list.
    async tournamentSeries(tournamentId, round, stage, poolStage) {
      const params = [];
      if (stage) params.push(`stage=${encodeURIComponent(stage)}`);
      if (poolStage != null) params.push(`poolStage=${encodeURIComponent(poolStage)}`);
      const query = params.length > 0 ? `?${params.join('&')}` : '';
      const res = await call(
        'GET',
        `/api/tournaments/${encodeURIComponent(tournamentId)}/series/${encodeURIComponent(round)}${query}`,
      );
      if (res.status === 404) return { ok: true, series: [] };
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'fetch_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs ?? retryAfterMsFrom(res),
        };
      }
      return { ok: true, series: Array.isArray(res.data?.series) ? res.data.series : [] };
    },

    // GET /api/tournaments/:id/standings — stage-aware standings (agent names
    // ride the rows, so the tool resolves opponent display names from here).
    async tournamentStandings(tournamentId) {
      const res = await call(
        'GET',
        `/api/tournaments/${encodeURIComponent(tournamentId)}/standings`,
      );
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'fetch_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs ?? retryAfterMsFrom(res),
        };
      }
      return {
        ok: true,
        stage: res.data?.stage,
        standings: Array.isArray(res.data?.standings) ? res.data.standings : [],
      };
    },
  };
}
