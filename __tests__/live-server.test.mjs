import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestServer, registerAgent, queueForMatch, TestAgentClient } from '@botoff/test-utils';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tier 2 — the plugin's two services run against a real Fastify SteamedClaw
 * server bound to a random port. No agent process, no LLM — just the
 * plugin's WS clients talking to live /ws/agent and /ws/game/:matchId.
 *
 * The plugin computes its state dir from `os.homedir()` at module-load,
 * so we redirect HOME (and `os.homedir` itself, which Node caches) to
 * an isolated tmp dir before importing the plugin.
 *
 * Lane convention: the plugin's queue_match tool defaults to 'fast'. When
 * pairing a plugin-side queue with a helper-side `queueForMatch` call,
 * pass `'fast'` as the 4th arg so both agents land in the same lane.
 * Helper-vs-helper pairings (no plugin involved) omit the lane arg and
 * both land in the server default 'standard'.
 */

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'steamedclaw-plugin-path3-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const originalHomedir = os.homedir;
os.homedir = () => TMP_HOME;

const STATE_DIR = path.join(TMP_HOME, '.config', 'steamedclaw-state');
const CREDS = path.join(STATE_DIR, 'credentials.md');
const CURRENT = path.join(STATE_DIR, 'current-game.md');
const PENDING = path.join(STATE_DIR, 'pending-queue.md');
const CLAIM = path.join(STATE_DIR, 'claim.md');
fs.mkdirSync(STATE_DIR, { recursive: true });

function writeCreds(server, agentId, apiKey) {
  fs.writeFileSync(CREDS, `Server: ${server}\nAgent ID: ${agentId}\nAPI Key: ${apiKey}\n`);
}

function clearState() {
  for (const f of [CREDS, CURRENT, PENDING, CLAIM]) {
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
}

function makeMockApi(server) {
  const services = [];
  const tools = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const requestHeartbeatNow = vi.fn();
  return {
    captured: { services, tools, logger, requestHeartbeatNow },
    api: {
      registrationMode: 'full',
      pluginConfig: { server },
      logger,
      runtime: { system: { requestHeartbeatNow } },
      registerTool: vi.fn((tool) => tools.push(tool)),
      registerService: (svc) => services.push(svc),
      registerHook: () => {},
    },
  };
}

async function invokeQueueMatch(captured, gameId) {
  const tool = captured.tools.find((t) => t.name === 'queue_match');
  if (!tool) throw new Error('queue_match tool not registered');
  const result = await tool.execute('tool-call', { gameId });
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function invokeGetTurn(captured) {
  const tool = captured.tools.find((t) => t.name === 'get_turn');
  if (!tool) throw new Error('get_turn tool not registered');
  const result = await tool.execute('tool-call', {});
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function invokeTakeTurn(captured, action) {
  const tool = captured.tools.find((t) => t.name === 'take_turn');
  if (!tool) throw new Error('take_turn tool not registered');
  const result = await tool.execute('tool-call', { action });
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function invokeGetRules(captured, gameId) {
  const tool = captured.tools.find((t) => t.name === 'get_rules');
  if (!tool) throw new Error('get_rules tool not registered');
  const result = await tool.execute('tool-call', { gameId });
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function invokeGetStrategy(captured, gameId) {
  const tool = captured.tools.find((t) => t.name === 'get_strategy');
  if (!tool) throw new Error('get_strategy tool not registered');
  const result = await tool.execute('tool-call', { gameId });
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function invokeRegisterAgent(captured, args) {
  const tool = captured.tools.find((t) => t.name === 'register_agent');
  if (!tool) throw new Error('register_agent tool not registered');
  const result = await tool.execute('tool-call', args);
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

function firstOpenPosition(board) {
  return (board ?? []).findIndex((c) => c === '' || c === null || c === undefined);
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

// ── Fixture ──────────────────────────────────────────────────────────────

let server;
let serverUrl;
let entry;

beforeAll(async () => {
  server = await startTestServer({ disableRateLimit: true });
  serverUrl = server.url;
  entry = (await import('../index.js')).default;
});

afterAll(async () => {
  await server?.close();
  os.homedir = originalHomedir;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('plugin against a live server', () => {
  it('receives match_found on /ws/agent and writes current-game.md', async () => {
    clearState();
    const a = await registerAgent(serverUrl, 'path3-agent-match-found-a');
    const b = await registerAgent(serverUrl, 'path3-agent-match-found-b');
    writeCreds(serverUrl, a.id, a.apiKey);

    const { api, captured } = makeMockApi(serverUrl);
    entry.register(api);
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    try {
      await agentSvc.start();

      // Allow the /ws/agent handshake to complete before queueing.
      await waitFor(
        () => captured.logger.info.mock.calls.some((c) => String(c[0]).includes('handshake ok')),
        4000,
      );

      await queueForMatch(serverUrl, a.apiKey, 'tic-tac-toe');
      const q2 = await queueForMatch(serverUrl, b.apiKey, 'tic-tac-toe');
      expect(q2.status).toBe('matched');

      await waitFor(() => captured.requestHeartbeatNow.mock.calls.length >= 1, 4000);

      const current = fs.readFileSync(CURRENT, 'utf8');
      expect(current).toContain(`match: ${q2.matchId}`);
      expect(current).toContain('game: tic-tac-toe');
    } finally {
      await agentSvc.stop();
    }
  });

  it('queue_match: two plugin queues produce {status:matched} + writes current-game.md', async () => {
    clearState();
    const a = await registerAgent(serverUrl, 'path3-queue-match-a');
    const b = await registerAgent(serverUrl, 'path3-queue-match-b');
    writeCreds(serverUrl, a.id, a.apiKey);

    // The match-queuer opponent is queued by the plugin under `b`'s creds
    // so the tool's second call lands `matched`. TTT greedy pairing means
    // whichever agent posts second is the one that gets `matched`.
    const { api: apiA, captured: capturedA } = makeMockApi(serverUrl);
    entry.register(apiA);
    const firstRes = await invokeQueueMatch(capturedA, 'tic-tac-toe');
    expect(firstRes.ok).toBe(true);
    expect(firstRes.status).toBe('queued');
    expect(firstRes.game).toBe('tic-tac-toe');
    expect(typeof firstRes.position).toBe('number');
    // First agent's queue call must NOT have written current-game.md.
    expect(fs.existsSync(CURRENT)).toBe(false);

    // Switch creds to agent b and invoke the tool again; server returns
    // matched and the plugin writes current-game.md.
    writeCreds(serverUrl, b.id, b.apiKey);
    const { api: apiB, captured: capturedB } = makeMockApi(serverUrl);
    entry.register(apiB);
    const secondRes = await invokeQueueMatch(capturedB, 'tic-tac-toe');
    expect(secondRes.ok).toBe(true);
    expect(secondRes.status).toBe('matched');
    expect(typeof secondRes.matchId).toBe('string');
    expect(secondRes.game).toBe('tic-tac-toe');

    const current = fs.readFileSync(CURRENT, 'utf8');
    expect(current).toContain(`match: ${secondRes.matchId}`);
    expect(current).toContain('game: tic-tac-toe');
    expect(current).toContain('seq: 0');
  });

  it('queue_match: single agent gets queued, /ws/agent push writes current-game.md', async () => {
    clearState();
    const a = await registerAgent(serverUrl, 'path3-queue-then-push-a');
    const b = await registerAgent(serverUrl, 'path3-queue-then-push-b');
    writeCreds(serverUrl, a.id, a.apiKey);

    const { api, captured } = makeMockApi(serverUrl);
    entry.register(api);
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    try {
      await agentSvc.start();
      await waitFor(
        () => captured.logger.info.mock.calls.some((c) => String(c[0]).includes('handshake ok')),
        4000,
      );

      // Single-agent queue via the plugin tool — server returns queued.
      const firstRes = await invokeQueueMatch(captured, 'tic-tac-toe');
      expect(firstRes.ok).toBe(true);
      expect(firstRes.status).toBe('queued');
      expect(firstRes.game).toBe('tic-tac-toe');
      expect(fs.existsSync(CURRENT)).toBe(false);

      // Pair from the outside with agent b; /ws/agent should push
      // match_found to the plugin, which writes current-game.md and
      // wakes the agent.
      const q2 = await queueForMatch(serverUrl, b.apiKey, 'tic-tac-toe', 'fast');
      expect(q2.status).toBe('matched');
      await waitFor(() => captured.requestHeartbeatNow.mock.calls.length >= 1, 4000);

      const current = fs.readFileSync(CURRENT, 'utf8');
      expect(current).toContain(`match: ${q2.matchId}`);
      expect(current).toContain('game: tic-tac-toe');
    } finally {
      await agentSvc.stop();
    }
  });

  it(
    'get_turn + take_turn: plays a full TTT match end-to-end via plugin tools only',
    { timeout: 45_000 },
    async () => {
      clearState();
      const a = await registerAgent(serverUrl, 'path3-full-ttt-a');
      const b = await registerAgent(serverUrl, 'path3-full-ttt-b');
      writeCreds(serverUrl, a.id, a.apiKey);

      const { api, captured } = makeMockApi(serverUrl);
      entry.register(api);
      const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
      const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
      let clientB;
      try {
        await agentSvc.start();
        await matchSvc.start();
        await waitFor(
          () =>
            captured.logger.info.mock.calls.some((c) => {
              const msg = String(c[0]);
              return msg.includes('[steamedclaw-agent-ws] handshake ok');
            }),
          4000,
        );

        // Plugin queues for A. B queues via HTTP and pairs.
        const qA = await invokeQueueMatch(captured, 'tic-tac-toe');
        expect(qA.ok).toBe(true);
        expect(qA.status).toBe('queued');
        const qB = await queueForMatch(serverUrl, b.apiKey, 'tic-tac-toe', 'fast');
        expect(qB.status).toBe('matched');
        const matchId = qB.matchId;
        expect(matchId).toBeTruthy();

        // Wait for the plugin to land match_found → open /ws/game/:matchId.
        // Event-driven: handleMatchFound calls matchSvc.onMatchFoundExternal
        // directly (#367), so opening fires without waiting for the 5-s
        // tick. 3s leaves a safe margin for the microtask chain.
        await waitFor(
          () =>
            captured.logger.info.mock.calls.some((c) =>
              String(c[0]).includes(`[steamedclaw-ws] opening`),
            ),
          3000,
        );

        // Drive agent B concurrently via TestAgentClient so the server has
        // an opponent to advance turns against.
        clientB = new TestAgentClient(serverUrl, b.apiKey);
        clientB.onTurn((view) => ({
          type: 'move',
          position: Math.max(0, firstOpenPosition(view?.board ?? [])),
        }));
        await clientB.connect(matchId);

        // Play the match to completion via plugin tools only.
        let finalResult = null;
        const deadline = Date.now() + 30000;
        for (let i = 0; i < 20 && Date.now() < deadline; i++) {
          const turn = await invokeGetTurn(captured);
          if (turn.status === 'no_active_match') break;
          if (!turn.myTurn) {
            await new Promise((r) => setTimeout(r, 150));
            continue;
          }
          const pos = firstOpenPosition(turn.view?.board ?? []);
          expect(pos).toBeGreaterThanOrEqual(0);
          const res = await invokeTakeTurn(captured, { type: 'move', position: pos });
          expect(res.ok).toBe(true);
          if (res.gameOver) {
            finalResult = res;
            break;
          }
        }
        expect(finalResult).not.toBeNull();
        expect(finalResult.gameOver).toBe(true);
        expect(['completed', 'aborted']).toContain(finalResult.matchStatus);
        expect(Array.isArray(finalResult.results)).toBe(true);

        // current-game.md was cleared by the plugin's game_over handler —
        // a subsequent get_turn should report no_active_match.
        const afterGameOver = await invokeGetTurn(captured);
        expect(afterGameOver.status).toBe('no_active_match');
      } finally {
        if (clientB) clientB.close();
        await matchSvc.stop();
        await agentSvc.stop();
      }
    },
  );

  it('get_turn HTTP fallback: returns state when no your_turn push has been cached', async () => {
    clearState();
    const a = await registerAgent(serverUrl, 'path3-get-turn-http-a');
    const b = await registerAgent(serverUrl, 'path3-get-turn-http-b');
    await queueForMatch(serverUrl, a.apiKey, 'tic-tac-toe');
    const qB = await queueForMatch(serverUrl, b.apiKey, 'tic-tac-toe');
    expect(qB.status).toBe('matched');
    const matchId = qB.matchId;

    // Seed plugin state pointing at the paired match — but deliberately
    // do NOT start the match service, so no your_turn push can arrive.
    // get_turn must then fall back to GET /state.
    writeCreds(serverUrl, a.id, a.apiKey);
    fs.writeFileSync(CURRENT, `match: ${matchId}\ngame: tic-tac-toe\nseq: 0\n`);

    const { api, captured } = makeMockApi(serverUrl);
    entry.register(api);

    const turn = await invokeGetTurn(captured);
    expect(turn.matchId).toBe(matchId);
    expect(turn.fetchedVia).toBe('http');
    // Match has been paired but neither player has connected via WS, so
    // the server reports `not_started`. The HTTP fallback's job is to
    // surface whatever the server knows — any legitimate state status
    // counts. What we're pinning here is that the fallback round-trips
    // at all.
    expect(['your_turn', 'waiting', 'not_started']).toContain(turn.status);
    expect(typeof turn.status).toBe('string');
  });

  it('get_rules: fetches mechanical rules markdown for tic-tac-toe against a live server', async () => {
    clearState();
    const a = await registerAgent(serverUrl, 'path3-get-rules-a');
    writeCreds(serverUrl, a.id, a.apiKey);

    const { api, captured } = makeMockApi(serverUrl);
    entry.register(api);

    const ok = await invokeGetRules(captured, 'tic-tac-toe');
    expect(ok.ok).toBe(true);
    expect(ok.gameId).toBe('tic-tac-toe');
    expect(typeof ok.version).toBe('string');
    expect(ok.version.length).toBeGreaterThan(0);
    expect(typeof ok.content).toBe('string');
    expect(ok.content).toMatch(/Tic Tac Toe/);
    expect(ok.content).toMatch(/"type":\s*"move"/);

    const notFound = await invokeGetRules(captured, 'does-not-exist');
    expect(notFound.ok).toBe(false);
    expect(notFound.error).toBe('game_not_found');
    expect(notFound.gameId).toBe('does-not-exist');
  });

  it('get_strategy: fetches strategy hints markdown for tic-tac-toe against a live server', async () => {
    clearState();
    const a = await registerAgent(serverUrl, 'path3-get-strategy-a');
    writeCreds(serverUrl, a.id, a.apiKey);

    const { api, captured } = makeMockApi(serverUrl);
    entry.register(api);

    const ok = await invokeGetStrategy(captured, 'tic-tac-toe');
    expect(ok.ok).toBe(true);
    expect(ok.gameId).toBe('tic-tac-toe');
    expect(typeof ok.version).toBe('string');
    expect(ok.version.length).toBeGreaterThan(0);
    expect(typeof ok.content).toBe('string');
    // Strategy content must be distinct from rules markdown — rules
    // carry action shapes, strategy carries hints.
    expect(ok.content.length).toBeGreaterThan(0);

    const notFound = await invokeGetStrategy(captured, 'does-not-exist');
    expect(notFound.ok).toBe(false);
    expect(notFound.error).toBe('game_not_found');
    expect(notFound.gameId).toBe('does-not-exist');
  });

  it(
    'queue-poll fallback (#385): discovers match via /api/matchmaking/status when /ws/agent is never opened',
    { timeout: 45_000 },
    async () => {
      clearState();
      const a = await registerAgent(serverUrl, 'path3-poll-fallback-a');
      const b = await registerAgent(serverUrl, 'path3-poll-fallback-b');
      writeCreds(serverUrl, a.id, a.apiKey);

      const { api, captured } = makeMockApi(serverUrl);
      entry.register(api);
      const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
      const pollSvc = captured.services.find((s) => s.id === 'steamedclaw-queue-poll-service');
      expect(pollSvc).toBeTruthy();

      // Simulate /ws/agent being unavailable by never starting the
      // agent-ws service. The match service must still run so the poll
      // path can hand off match discovery to it via
      // matchSvc.onMatchFoundExternal().
      try {
        await matchSvc.start();
        await pollSvc.start();

        // queue_match for agent A via the plugin tool — server returns
        // {status:queued}, plugin writes pending-queue.md and nudges
        // the poll service to schedule its first tick.
        const qA = await invokeQueueMatch(captured, 'tic-tac-toe');
        expect(qA.ok).toBe(true);
        expect(qA.status).toBe('queued');
        expect(fs.existsSync(PENDING)).toBe(true);
        expect(fs.readFileSync(PENDING, 'utf8')).toContain('game: tic-tac-toe');

        // Pair via agent B with real tools (no plugin), so the server
        // pairs A server-side without ever pushing to a /ws/agent
        // connection (there isn't one).
        const qB = await queueForMatch(serverUrl, b.apiKey, 'tic-tac-toe', 'fast');
        expect(qB.status).toBe('matched');

        // Kick the poll now so the test doesn't wait 30 s for the first
        // scheduled tick. notifyMarkerWritten on its own won't fire
        // until /ws/agent is closed — which it permanently is here —
        // so a direct call to onAgentWsClosed() is the test hook. The
        // production wiring calls this from the real agent-ws socket
        // close handler; here we simulate "WS has never been up and
        // will not come up."
        pollSvc.onAgentWsClosed();

        // Fast-forward by polling the real state dir; the poll
        // resolves the matched result, writes current-game.md, clears
        // the pending marker, and hands off to matchSvc via
        // onMatchFoundExternal. We wait up to ~35 s (one QUEUE_POLL_MS
        // plus slack) since the poll uses real timers.
        await waitFor(
          () =>
            fs.existsSync(CURRENT) &&
            fs.readFileSync(CURRENT, 'utf8').includes(`match: ${qB.matchId}`),
          40_000,
          250,
        );
        expect(fs.readFileSync(CURRENT, 'utf8')).toContain(`match: ${qB.matchId}`);
        expect(fs.readFileSync(CURRENT, 'utf8')).toContain('game: tic-tac-toe');
        // Marker cleared.
        if (fs.existsSync(PENDING)) {
          expect(fs.readFileSync(PENDING, 'utf8')).toBe('No pending queue.\n');
        }
      } finally {
        await pollSvc.stop();
        await matchSvc.stop();
      }
    },
  );

  it('claim surface (#390): register_agent tool writes claim.md and response carries operatorNotice', async () => {
    clearState();
    // Fresh install path: no pre-seeded credentials, LLM drives
    // registration via the register_agent tool. The server returns
    // claim_url + verification_code, which the plugin persists to
    // claim.md with Announced:true and surfaces via operatorNotice in
    // the tool response directly (no deferred merge).
    const { api, captured } = makeMockApi(serverUrl);
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    const pollSvc = captured.services.find((s) => s.id === 'steamedclaw-queue-poll-service');
    try {
      // Services start before credentials exist — they bail gracefully
      // and register_agent's onCredentialsReady hooks wake them up.
      await Promise.all([matchSvc.start(), agentSvc.start(), pollSvc.start()]);

      const regPayload = await invokeRegisterAgent(captured, {
        name: 'path3-claim-surface-a',
        model: 'claude-opus-4-7',
      });
      expect(regPayload.ok).toBe(true);
      expect(typeof regPayload.id).toBe('string');
      expect(regPayload.name).toBe('path3-claim-surface-a');
      expect(regPayload.model).toBe('claude-opus-4-7');
      expect(typeof regPayload.claimUrl).toBe('string');
      expect(regPayload.claimUrl).toMatch(/\/claim\?agent=/);
      expect(typeof regPayload.verificationCode).toBe('string');
      expect(regPayload.verificationCode).toMatch(/^sc-verify-[0-9a-f]{16}$/);
      expect(typeof regPayload.operatorNotice).toBe('string');
      expect(regPayload.operatorNotice).toMatch(/I registered on SteamedClaw/);
      expect(regPayload.operatorNotice).toMatch(/\/claim\?agent=/);
      expect(regPayload.operatorNotice).toMatch(/verification code: sc-verify-/);

      // Credentials + claim written to disk.
      expect(fs.existsSync(CREDS)).toBe(true);
      expect(fs.readFileSync(CREDS, 'utf8')).toContain('Name: path3-claim-surface-a');
      expect(fs.existsSync(CLAIM)).toBe(true);
      const claimContents = fs.readFileSync(CLAIM, 'utf8');
      expect(claimContents).toMatch(/^Claim URL: https?:\/\/.+\/claim\?agent=/m);
      expect(claimContents).toMatch(/^Verification code: sc-verify-[0-9a-f]{16}$/m);
      expect(claimContents).toContain('Status: unclaimed');
      // Announced:true from the start — notice already delivered in tool response.
      expect(claimContents).toContain('Announced: true');

      // Info logs surfaced the OPERATOR ACTION line and verification code.
      const infoLines = captured.logger.info.mock.calls.map((c) => String(c[0]));
      expect(infoLines.some((l) => /OPERATOR ACTION: claim this agent/.test(l))).toBe(true);
      expect(infoLines.some((l) => /verification code: sc-verify-/.test(l))).toBe(true);

      // Subsequent tool calls do NOT carry operatorNotice — the deferred
      // merge path is deleted.
      const queueRes = await invokeQueueMatch(captured, 'tic-tac-toe');
      expect(queueRes.ok).toBe(true);
      expect(queueRes).not.toHaveProperty('operatorNotice');

      const rulesRes = await invokeGetRules(captured, 'tic-tac-toe');
      expect(rulesRes.ok).toBe(true);
      expect(rulesRes).not.toHaveProperty('operatorNotice');

      // Second register_agent returns already_registered without POST.
      const reReg = await invokeRegisterAgent(captured, { name: 'DifferentName' });
      expect(reReg.ok).toBe(false);
      expect(reReg.error).toBe('already_registered');
      expect(reReg.name).toBe('path3-claim-surface-a');
    } finally {
      await Promise.all([matchSvc.stop(), agentSvc.stop(), pollSvc.stop()]);
    }
  });

  it(
    'register_agent (#390): fresh install → register opens /ws/agent → queue + match_found push lands current-game.md',
    { timeout: 20_000 },
    async () => {
      clearState();
      // End-to-end: no pre-seeded credentials. LLM calls register_agent,
      // which must notify services via onCredentialsReady so /ws/agent
      // opens in the same tool-call window. The queue_match call then
      // returns {status:'queued'} (no prior queue for this gameId on
      // this fresh-server port), and a second HTTP queue on behalf of
      // an opponent triggers the match_found push, which writes
      // current-game.md + wakes the agent.
      //
      // Uses 'nim' (not 'tic-tac-toe') to isolate from the shared
      // in-memory server's queue state bled in from earlier tests.
      const { api, captured } = makeMockApi(serverUrl);
      entry.register(api);
      const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
      const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
      const pollSvc = captured.services.find((s) => s.id === 'steamedclaw-queue-poll-service');
      try {
        // Services start pre-registration — they bail gracefully.
        await Promise.all([matchSvc.start(), agentSvc.start(), pollSvc.start()]);
        // Agent-ws must not have opened a socket yet (no credentials).
        expect(
          captured.logger.info.mock.calls.some((c) =>
            String(c[0]).includes('no credentials yet; waiting for register_agent'),
          ),
        ).toBe(true);

        // LLM registers via the tool.
        const regPayload = await invokeRegisterAgent(captured, {
          name: 'path3-register-e2e-a',
        });
        expect(regPayload.ok).toBe(true);
        expect(regPayload.name).toBe('path3-register-e2e-a');

        // onCredentialsReady must have opened /ws/agent. Wait for
        // handshake ok log line.
        await waitFor(
          () =>
            captured.logger.info.mock.calls.some((c) =>
              String(c[0]).includes('[steamedclaw-agent-ws] handshake ok'),
            ),
          6000,
        );

        // Plugin queues via the tool.
        const qA = await invokeQueueMatch(captured, 'nim');
        expect(qA.ok).toBe(true);
        expect(qA.status).toBe('queued');
        expect(fs.existsSync(CURRENT)).toBe(false);

        // Opponent queues via HTTP; pairs with plugin.
        const b = await registerAgent(serverUrl, 'path3-register-e2e-b');
        const qB = await queueForMatch(serverUrl, b.apiKey, 'nim', 'fast');
        expect(qB.status).toBe('matched');

        // match_found push over /ws/agent writes current-game.md.
        await waitFor(() => fs.existsSync(CURRENT), 5000);
        const current = fs.readFileSync(CURRENT, 'utf8');
        expect(current).toContain(`match: ${qB.matchId}`);
        expect(current).toContain('game: nim');
        await waitFor(() => captured.requestHeartbeatNow.mock.calls.length >= 1, 2000);
      } finally {
        await Promise.all([matchSvc.stop(), agentSvc.stop(), pollSvc.stop()]);
      }
    },
  );

  it('opens /ws/game/:matchId and wakes the agent on your_turn', async () => {
    clearState();
    const a = await registerAgent(serverUrl, 'path3-ws-game-a');
    const b = await registerAgent(serverUrl, 'path3-ws-game-b');
    const q1 = await queueForMatch(serverUrl, a.apiKey, 'tic-tac-toe');
    const q2 = await queueForMatch(serverUrl, b.apiKey, 'tic-tac-toe');
    const matchId =
      q2.status === 'matched' && q2.matchId
        ? q2.matchId
        : q1.status === 'matched' && q1.matchId
          ? q1.matchId
          : null;
    expect(matchId).toBeTruthy();

    // Seed `a` as the plugin agent with the freshly paired match in
    // current-game.md so the first tick() picks it up and opens a live
    // /ws/game/:matchId socket.
    writeCreds(serverUrl, a.id, a.apiKey);
    fs.writeFileSync(CURRENT, `match: ${matchId}\ngame: tic-tac-toe\nseq: 0\n`);

    const { api, captured } = makeMockApi(serverUrl);
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    try {
      await matchSvc.start();

      // Drive `b` as the opponent so the server emits `your_turn` to `a`.
      // TestAgentClient plays one move if it's b's turn. If a is first,
      // no move from b is needed — a's first `your_turn` push fires on
      // match activation.
      const clientB = new TestAgentClient(serverUrl, b.apiKey);
      clientB.onTurn((view) => {
        const firstOpen = (view?.board ?? []).findIndex((c) => c === '' || c === null);
        return { type: 'move', position: firstOpen >= 0 ? firstOpen : 0 };
      });
      await clientB.connect(matchId);

      await waitFor(() => captured.requestHeartbeatNow.mock.calls.length >= 1, 6000);

      clientB.close();
    } finally {
      await matchSvc.stop();
    }
  });
});
