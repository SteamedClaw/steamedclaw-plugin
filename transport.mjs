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
// Auth: Bearer <apiKey> on everything except register + list_games. The UA marks
// plugin-origin traffic so server-side analysis can classify it.

import https from 'node:https';
import http from 'node:http';

export const PLUGIN_USER_AGENT = 'steamedclaw-plugin/1.0.0';
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
      return { ok: false, error: err, httpStatus: res.status };
    },

    async queue(gameId, lane) {
      const res = await call('POST', '/api/matchmaking/queue', { gameId, lane });
      if (res.status !== 200) {
        const err = typeof res.data?.error === 'string' ? res.data.error : 'queue_failed';
        return {
          ok: false,
          error: res.status === 404 ? 'game_not_found' : err,
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs,
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
          retryAfterMs: res.data?.retryAfterMs,
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
    // list still shows the live match). Returns the newest unfinished match.
    async activeMatch(agentId, gameId) {
      if (!agentId) return { ok: false, error: 'no_agent_id' };
      const res = await call('GET', `/api/agents/${encodeURIComponent(agentId)}/matches?limit=5`);
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'matches_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs,
        };
      }
      const list = Array.isArray(res.data?.matches) ? res.data.matches : [];
      const m = list.find(
        (x) =>
          (!gameId || x.gameId === gameId) &&
          !x.finishedAt &&
          (x.status === 'active' || x.status === 'waiting' || x.status === 'not_started'),
      );
      return { ok: true, matchId: m ? m.id : null };
    },

    async getState(matchId) {
      const res = await call('GET', `/api/matches/${encodeURIComponent(matchId)}/state?wait=false`);
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'state_failed',
          httpStatus: res.status,
          retryAfterMs: res.data?.retryAfterMs,
        };
      }
      const s = res.data ?? {};
      // replayUrl is present on the server's game-over state response
      // (buildGameOverResponse) — thread it so the opponent-ended get_turn path
      // can surface it (#510). The state endpoint carries no `reason` (status is
      // always 'game_over'); that field stays WS-only, matching 0.9.x.
      // `messaging` (the server-authored end-of-game envelope, #514) is top-level
      // on the game-over /state response — forward it verbatim (#517). It is
      // undefined on non-terminal states (no envelope), which cleanOutcome drops.
      return {
        ok: true,
        status: s.status,
        sequence: s.sequence,
        view: s.view,
        results: s.results,
        replayUrl: s.replayUrl,
        messaging: s.messaging,
      };
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
          // The terminal /action response wraps buildGameOverResponse in `state`,
          // so the server messaging envelope (#514) rides on st.messaging — forward
          // it verbatim so a self-ending move surfaces encouragement too (#517).
          return {
            status: 'game_over',
            results: st.results,
            replayUrl: st.replayUrl,
            messaging: st.messaging,
          };
        }
        return { status: st.status, sequence: st.sequence, view: st.view };
      }
      const errBody = res.data ?? {};
      return {
        ok: false,
        error: typeof errBody.error === 'string' ? errBody.error : 'http_error',
        details: typeof errBody.details === 'string' ? errBody.details : undefined,
        currentSequence:
          typeof errBody.currentSequence === 'number' ? errBody.currentSequence : undefined,
        httpStatus: res.status,
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
  };
}
