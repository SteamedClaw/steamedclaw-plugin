import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 — mocked-runtime tests for the Path 3 plugin's take_turn tool.
 *
 * take_turn owns the outbound WS action frame and the single-slot ack
 * correlation — we stub `node:fs` and `ws` so each test can drive the
 * match service with synthetic pushes and assert the frame shape, ack
 * resolution, and error/timeout paths.
 */

const mocks = vi.hoisted(() => ({
  fsState: { files: new Map(), writes: [] },
  wsInstances: [],
  http: { calls: [], responder: null },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: (p) => mocks.fsState.files.has(p),
    readFileSync: (p) => {
      const v = mocks.fsState.files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFileSync: (p, data) => {
      mocks.fsState.files.set(p, String(data));
      mocks.fsState.writes.push([p, String(data)]);
    },
    mkdirSync: () => {},
  },
}));

function buildHttpMock(EventEmitter) {
  return {
    request: (opts, onResponse) => {
      const req = new EventEmitter();
      let bodyStr = '';
      req.setTimeout = () => {};
      req.write = (chunk) => {
        bodyStr += chunk.toString();
      };
      req.end = () => {
        mocks.http.calls.push({ opts, body: bodyStr });
        queueMicrotask(() => {
          const responder = mocks.http.responder;
          if (!responder) {
            req.emit('error', new Error('no mock responder set'));
            return;
          }
          let status;
          let data;
          try {
            ({ status, data } = responder({ opts, body: bodyStr }));
          } catch (err) {
            req.emit('error', err);
            return;
          }
          const res = new EventEmitter();
          res.statusCode = status;
          onResponse(res);
          queueMicrotask(() => {
            res.emit('data', Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)));
            res.emit('end');
          });
        });
      };
      req.destroy = () => {};
      return req;
    },
  };
}

vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: buildHttpMock(EventEmitter) };
});

vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: buildHttpMock(EventEmitter) };
});

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWs extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts;
      this.closed = false;
      this.readyState = 0; // CONNECTING
      this.sentFrames = [];
      mocks.wsInstances.push(this);
    }
    static get OPEN() {
      return 1;
    }
    send(data) {
      this.sentFrames.push(String(data));
    }
    close(code, reason) {
      this.closed = true;
      this.readyState = 3;
      queueMicrotask(() => this.emit('close', code, Buffer.from(String(reason ?? ''))));
    }
  }
  return { WebSocket: FakeWs };
});

const { fsState, wsInstances } = mocks;

const path = await import('node:path');
const os = await import('node:os');
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.config', 'steamedclaw-state');
const CREDS = path.join(STATE_DIR, 'credentials.md');
const CURRENT = path.join(STATE_DIR, 'current-game.md');

function seedCreds() {
  fsState.files.set(
    CREDS,
    'Server: https://stage.example.com\nAgent ID: agent-1\nAPI Key: key-xyz\n',
  );
}
function seedMatch(matchId, game, seq) {
  fsState.files.set(CURRENT, `match: ${matchId}\ngame: ${game}\nseq: ${seq}\n`);
}

function makeMockApi(overrides = {}) {
  const services = [];
  const tools = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const requestHeartbeatNow = vi.fn();
  return {
    captured: { services, tools, logger, requestHeartbeatNow },
    api: {
      registrationMode: 'full',
      pluginConfig: { server: 'https://stage.example.com' },
      logger,
      runtime: { system: { requestHeartbeatNow } },
      registerTool: vi.fn((tool) => tools.push(tool)),
      registerService: (svc) => services.push(svc),
      registerHook: () => {},
      ...overrides,
    },
  };
}

function getTool(captured, name) {
  const tool = captured.tools.find((t) => t.name === name);
  expect(tool).toBeTruthy();
  return tool;
}

function startTakeTurn(captured, action) {
  return getTool(captured, 'take_turn')
    .execute('tool-call', { action })
    .then((result) => {
      const text = result.content?.[0]?.text;
      return { result, payload: text ? JSON.parse(text) : null };
    });
}

async function drainMicrotasks() {
  await new Promise((r) => setImmediate(r));
}

async function seedLiveMatchFixture(sequence = 1) {
  seedCreds();
  seedMatch('m-live', 'tic-tac-toe', 0);
  const { default: entry } = await import('../index.js');
  const { api, captured } = makeMockApi();
  entry.register(api);
  const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
  await matchSvc.start();
  await drainMicrotasks();
  const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-live'));
  expect(ws).toBeTruthy();
  ws.readyState = 1;
  ws.emit('open');
  ws.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'your_turn',
        sequence,
        view: { board: ['', '', '', '', '', '', '', '', ''] },
      }),
    ),
  );
  return { captured, matchSvc, ws };
}

beforeEach(() => {
  fsState.files.clear();
  fsState.writes.length = 0;
  wsInstances.length = 0;
  mocks.http.calls.length = 0;
  mocks.http.responder = null;
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('take_turn tool — guard rails', () => {
  it('returns not_registered when credentials are missing', async () => {
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await startTakeTurn(captured, { type: 'move', position: 0 });
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('not_registered');
    expect(payload.message).toMatch(/register_agent/);
  });

  it('returns no_active_match when current-game.md is missing', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await startTakeTurn(captured, { type: 'move', position: 0 });
    expect(payload).toEqual({ ok: false, error: 'no_active_match' });
  });

  it('returns ws_not_ready when the match service has not opened a socket', async () => {
    seedCreds();
    seedMatch('m-na', 'tic-tac-toe', 0);
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await startTakeTurn(captured, { type: 'move', position: 0 });
    expect(payload).toEqual({ ok: false, error: 'ws_not_ready' });
  });

  it('returns ws_not_ready when the socket is still CONNECTING', async () => {
    seedCreds();
    seedMatch('m-connecting', 'tic-tac-toe', 0);
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const { payload } = await startTakeTurn(captured, { type: 'move', position: 0 });
    expect(payload).toEqual({ ok: false, error: 'ws_not_ready' });
    await matchSvc.stop();
  });

  it('returns no_turn_cached when the socket is open but no your_turn has landed', async () => {
    seedCreds();
    seedMatch('m-empty', 'tic-tac-toe', 0);
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-empty'));
    ws.readyState = 1;
    ws.emit('open');
    const { payload } = await startTakeTurn(captured, { type: 'move', position: 0 });
    expect(payload).toEqual({ ok: false, error: 'no_turn_cached' });
    await matchSvc.stop();
  });
});

describe('take_turn tool — happy paths', () => {
  it('sends {type:action, sequence, payload} using the cached sequence', async () => {
    const { captured, ws, matchSvc } = await seedLiveMatchFixture(7);
    // Kick off the tool but don't await yet — inspect the frame first.
    const pending = startTakeTurn(captured, { type: 'move', position: 4 });
    await drainMicrotasks();
    expect(ws.sentFrames).toHaveLength(1);
    const frame = JSON.parse(ws.sentFrames[0]);
    expect(frame).toEqual({
      type: 'action',
      sequence: 7,
      payload: { type: 'move', position: 4 },
    });
    // Resolve the ack with a fresh your_turn so the pending promise settles.
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 9, view: { board: [] } })),
    );
    const { payload } = await pending;
    expect(payload.ok).toBe(true);
    expect(payload.gameOver).toBe(false);
    expect(payload.newSequence).toBe(9);
    await matchSvc.stop();
  });

  it('resolves ok:true, gameOver:false on the next your_turn push', async () => {
    const { captured, ws, matchSvc } = await seedLiveMatchFixture(1);
    const pending = startTakeTurn(captured, { type: 'move', position: 0 });
    await drainMicrotasks();
    const nextView = { board: ['X', '', '', '', '', '', '', '', ''] };
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 3, view: nextView })),
    );
    const { payload } = await pending;
    expect(payload).toEqual({
      ok: true,
      gameOver: false,
      matchStatus: 'your_turn',
      newSequence: 3,
      view: nextView,
    });
    await matchSvc.stop();
  });

  it('resolves ok:true, gameOver:true with results on game_over (completed)', async () => {
    const { captured, ws, matchSvc } = await seedLiveMatchFixture(5);
    const pending = startTakeTurn(captured, { type: 'move', position: 8 });
    await drainMicrotasks();
    const results = [
      { agentId: 'agent-1', outcome: 'win' },
      { agentId: 'agent-2', outcome: 'loss' },
    ];
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'game_over',
          results,
          replayUrl: '/api/matches/m-live',
        }),
      ),
    );
    const { payload } = await pending;
    expect(payload.ok).toBe(true);
    expect(payload.gameOver).toBe(true);
    expect(payload.matchStatus).toBe('completed');
    expect(payload.results).toEqual(results);
    expect(payload.replayUrl).toBe('/api/matches/m-live');
    // current-game.md should now be cleared so subsequent tools see no match.
    expect(fsState.files.get(CURRENT)).toBe('No active game.\n');
    await matchSvc.stop();
  });

  it('resolves matchStatus:aborted on game_over with reason=aborted', async () => {
    const { captured, ws, matchSvc } = await seedLiveMatchFixture(2);
    const pending = startTakeTurn(captured, { type: 'move', position: 1 });
    await drainMicrotasks();
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'game_over', reason: 'aborted', results: [] })),
    );
    const { payload } = await pending;
    expect(payload.ok).toBe(true);
    expect(payload.gameOver).toBe(true);
    expect(payload.matchStatus).toBe('aborted');
    expect(payload.reason).toBe('aborted');
    await matchSvc.stop();
  });
});

describe('take_turn tool — server error frames', () => {
  it('surfaces stale_sequence error frames with currentSequence', async () => {
    const { captured, ws, matchSvc } = await seedLiveMatchFixture(3);
    const pending = startTakeTurn(captured, { type: 'move', position: 0 });
    await drainMicrotasks();
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'error',
          error: 'stale_sequence',
          currentSequence: 5,
        }),
      ),
    );
    const { payload } = await pending;
    expect(payload).toEqual({
      ok: false,
      error: 'stale_sequence',
      currentSequence: 5,
    });
    await matchSvc.stop();
  });

  it('surfaces invalid_input error frames with details', async () => {
    const { captured, ws, matchSvc } = await seedLiveMatchFixture(1);
    const pending = startTakeTurn(captured, { type: 'bogus' });
    await drainMicrotasks();
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'error',
          error: 'invalid_input',
          details: 'unknown action type',
        }),
      ),
    );
    const { payload } = await pending;
    expect(payload).toEqual({
      ok: false,
      error: 'invalid_input',
      details: 'unknown action type',
    });
    await matchSvc.stop();
  });
});

describe('take_turn tool — timeout', () => {
  it('resolves {ok:false, error:timeout} after the configured window', async () => {
    const { captured, matchSvc } = await seedLiveMatchFixture(1);
    const pending = startTakeTurn(captured, { type: 'move', position: 0 });
    await drainMicrotasks();
    // Advance past the 8 min take_turn timeout (server turn timeout is
    // ≥ 7 min, so the plugin waits slightly longer to catch a late
    // game_over push before surfacing timeout to the LLM).
    await vi.advanceTimersByTimeAsync(485000);
    const { payload } = await pending;
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('timeout');
    expect(payload.message).toMatch(/within 480000 ms/);
    await matchSvc.stop();
  });
});

describe('take_turn tool — lifecycle rejection', () => {
  it('resolves {ok:false, error:service_stopped} when stop() races the pending ack', async () => {
    const { captured, matchSvc } = await seedLiveMatchFixture(1);
    const pending = startTakeTurn(captured, { type: 'move', position: 0 });
    await drainMicrotasks();
    await matchSvc.stop();
    const { payload } = await pending;
    expect(payload).toEqual({ ok: false, error: 'service_stopped' });
  });
});

describe('take_turn tool — primed via get_turn HTTP fallback (#386)', () => {
  it('sends the action with the sequence primed by the get_turn HTTP fallback', async () => {
    seedCreds();
    seedMatch('m-primed', 'tic-tac-toe', 0);
    mocks.http.responder = ({ opts }) => {
      expect(opts.method).toBe('GET');
      expect(opts.path).toBe('/api/matches/m-primed/state?wait=false');
      return {
        status: 200,
        data: {
          matchId: 'm-primed',
          gameId: 'tic-tac-toe',
          status: 'your_turn',
          sequence: 4,
          view: { board: ['', '', '', '', '', '', '', '', ''], symbol: 'X' },
        },
      };
    };
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-primed'));
    expect(ws).toBeTruthy();
    // Socket is open but no your_turn push has landed yet — this is the
    // exact window #386 targets.
    ws.readyState = 1;
    ws.emit('open');

    // get_turn falls back to HTTP and primes the match-service cache.
    const getTurnTool = getTool(captured, 'get_turn');
    const getResult = await getTurnTool.execute('gt', {});
    const getPayload = JSON.parse(getResult.content[0].text);
    expect(getPayload.status).toBe('your_turn');
    expect(getPayload.sequence).toBe(4);
    expect(getPayload.fetchedVia).toBe('http');
    expect(mocks.http.calls.length).toBe(1);

    // take_turn now resolves the sequence from the primed cache instead
    // of returning no_turn_cached.
    const pending = startTakeTurn(captured, { type: 'move', position: 4 });
    await drainMicrotasks();
    expect(ws.sentFrames).toHaveLength(1);
    const frame = JSON.parse(ws.sentFrames[0]);
    expect(frame).toEqual({
      type: 'action',
      sequence: 4,
      payload: { type: 'move', position: 4 },
    });
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 6, view: { board: [] } })),
    );
    const { payload } = await pending;
    expect(payload.ok).toBe(true);
    expect(payload.newSequence).toBe(6);
    await matchSvc.stop();
  });

  it('does not wake the agent from the prime path', async () => {
    seedCreds();
    seedMatch('m-silent', 'tic-tac-toe', 0);
    mocks.http.responder = () => ({
      status: 200,
      data: {
        matchId: 'm-silent',
        gameId: 'tic-tac-toe',
        status: 'your_turn',
        sequence: 1,
        view: { board: [] },
      },
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-silent'));
    ws.readyState = 1;
    ws.emit('open');
    // Sanity: open/handshake does not wake either.
    captured.requestHeartbeatNow.mockClear();
    await getTool(captured, 'get_turn').execute('gt', {});
    expect(captured.requestHeartbeatNow).not.toHaveBeenCalled();
    await matchSvc.stop();
  });

  it('treats a WS your_turn push with the same primed sequence as a no-op', async () => {
    seedCreds();
    seedMatch('m-idemp', 'tic-tac-toe', 0);
    const primedView = { board: ['primed'] };
    mocks.http.responder = () => ({
      status: 200,
      data: {
        matchId: 'm-idemp',
        gameId: 'tic-tac-toe',
        status: 'your_turn',
        sequence: 2,
        view: primedView,
      },
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-idemp'));
    ws.readyState = 1;
    ws.emit('open');

    // Prime via HTTP fallback.
    await getTool(captured, 'get_turn').execute('gt', {});

    // Server re-emits the pending turn with the same sequence on match-WS
    // reconnect (app.ts:3683-3692). The existing stale-sequence guard
    // must swallow it — no wake, no second cache write, and the cached
    // view must stay as the primed value (distinguishable from the push).
    captured.requestHeartbeatNow.mockClear();
    const writesBefore = fsState.writes.length;
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 2, view: { board: ['push'] } })),
    );
    expect(captured.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(fsState.writes.length).toBe(writesBefore);
    expect(matchSvc.getCachedTurn('m-idemp').view).toEqual(primedView);

    // take_turn still uses the primed sequence.
    const pending = startTakeTurn(captured, { type: 'move', position: 0 });
    await drainMicrotasks();
    const frame = JSON.parse(ws.sentFrames[0]);
    expect(frame.sequence).toBe(2);

    // Resolve the ack with a fresh your_turn to unblock the promise.
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 3, view: {} })));
    await pending;
    await matchSvc.stop();
  });

  it('does not prime the cache while a take_turn action is already in flight', async () => {
    const { captured, ws, matchSvc } = await seedLiveMatchFixture(3);
    // Ensure a fresh HTTP mock that would prime to seq=99 if allowed.
    mocks.http.responder = () => ({
      status: 200,
      data: {
        matchId: 'm-live',
        gameId: 'tic-tac-toe',
        status: 'your_turn',
        sequence: 99,
        view: { board: ['http-stale'] },
      },
    });
    const pending = startTakeTurn(captured, { type: 'move', position: 0 });
    await drainMicrotasks();
    // take_turn is now in flight with sentSequence=3. Running get_turn
    // must NOT advance lastSeq to 99 — that would let the server's
    // real your_turn ack at seq=5 (or any seq<99) be silently dropped
    // by the stale-sequence guard, starving the pending take_turn.
    await getTool(captured, 'get_turn').execute('gt', {});
    // The real ack arrives at seq=5 and must still resolve the pending
    // take_turn.
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 5, view: { board: ['ack'] } })),
    );
    const { payload } = await pending;
    expect(payload.ok).toBe(true);
    expect(payload.newSequence).toBe(5);
    await matchSvc.stop();
  });

  it('does not prime the cache when the HTTP fallback reports status !== your_turn', async () => {
    seedCreds();
    seedMatch('m-wait', 'tic-tac-toe', 0);
    mocks.http.responder = () => ({
      status: 200,
      data: {
        matchId: 'm-wait',
        gameId: 'tic-tac-toe',
        status: 'waiting',
        sequence: 5,
        view: { board: [] },
      },
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-wait'));
    ws.readyState = 1;
    ws.emit('open');

    await getTool(captured, 'get_turn').execute('gt', {});

    // take_turn must not be able to use that sequence — status wasn't
    // your_turn, so the primed cache must stay empty.
    const { payload } = await startTakeTurn(captured, { type: 'move', position: 0 });
    expect(payload).toEqual({ ok: false, error: 'no_turn_cached' });
    await matchSvc.stop();
  });
});

describe('take_turn tool — concurrency', () => {
  it('rejects a second take_turn while one is already in flight', async () => {
    const { captured, ws, matchSvc } = await seedLiveMatchFixture(1);
    const first = startTakeTurn(captured, { type: 'move', position: 0 });
    await drainMicrotasks();
    const second = startTakeTurn(captured, { type: 'move', position: 1 });
    await drainMicrotasks();
    const { payload: secondPayload } = await second;
    expect(secondPayload).toEqual({ ok: false, error: 'action_already_pending' });
    // Unblock the first pending call.
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 3, view: {} })));
    const { payload: firstPayload } = await first;
    expect(firstPayload.ok).toBe(true);
    await matchSvc.stop();
  });
});
