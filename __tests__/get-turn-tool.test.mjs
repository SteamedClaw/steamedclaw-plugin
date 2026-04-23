import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 — mocked-runtime tests for the Path 3 plugin's get_turn tool.
 *
 * The hot path returns the match-WS service's cached `your_turn` payload
 * with no outbound request. The fallback path hits GET /state — we stub
 * `node:http` / `node:https` to drive that deterministically.
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
      this.readyState = 3; // CLOSED
      queueMicrotask(() => this.emit('close', code, Buffer.from(String(reason ?? ''))));
    }
  }
  return { WebSocket: FakeWs };
});

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

async function invokeGetTurn(captured) {
  const tool = captured.tools.find((t) => t.name === 'get_turn');
  expect(tool).toBeTruthy();
  const result = await tool.execute('tool-call-1', {});
  const text = result.content?.[0]?.text;
  return { result, payload: text ? JSON.parse(text) : null };
}

async function drainMicrotasks() {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  fsState.files.clear();
  fsState.writes.length = 0;
  wsInstances.length = 0;
  mocks.http.calls.length = 0;
  mocks.http.responder = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('get_turn tool', () => {
  it('returns not_registered when credentials are missing', async () => {
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeGetTurn(captured);
    expect(payload.status).toBe('not_registered');
    expect(payload.error).toBe('not_registered');
    expect(payload.message).toMatch(/register_agent/);
    expect(mocks.http.calls.length).toBe(0);
  });

  it('returns no_active_match when current-game.md is missing', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeGetTurn(captured);
    expect(payload.status).toBe('no_active_match');
    expect(payload.message).toMatch(/queue_match/);
    expect(mocks.http.calls.length).toBe(0);
  });

  it('returns the cached your_turn payload with myTurn:true on the hot path', async () => {
    seedCreds();
    seedMatch('m-42', 'tic-tac-toe', 0);
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-42'));
    expect(ws).toBeTruthy();
    ws.readyState = 1;
    ws.emit('open');
    const view = { board: ['', '', '', '', '', '', '', '', ''], symbol: 'X' };
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 1, view })));

    const { payload } = await invokeGetTurn(captured);
    expect(payload).toEqual({
      status: 'your_turn',
      matchId: 'm-42',
      game: 'tic-tac-toe',
      sequence: 1,
      view,
      myTurn: true,
    });
    // No outbound request on the hot path.
    expect(mocks.http.calls.length).toBe(0);
    await matchSvc.stop();
  });

  it('falls back to GET /state when no your_turn push has been cached yet', async () => {
    seedCreds();
    seedMatch('m-cold', 'nim', 2);
    mocks.http.responder = ({ opts }) => {
      expect(opts.method).toBe('GET');
      expect(opts.path).toBe('/api/matches/m-cold/state?wait=false');
      expect(opts.headers.Authorization).toBe('Bearer key-xyz');
      return {
        status: 200,
        data: {
          matchId: 'm-cold',
          gameId: 'nim',
          gameType: 'sequential',
          status: 'your_turn',
          sequence: 4,
          view: { piles: [3, 4, 5] },
        },
      };
    };
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    // Do not start the match service — the cache remains empty so the
    // tool must fall back to HTTP.
    const { payload } = await invokeGetTurn(captured);
    expect(payload.status).toBe('your_turn');
    expect(payload.matchId).toBe('m-cold');
    expect(payload.game).toBe('nim');
    expect(payload.sequence).toBe(4);
    expect(payload.view).toEqual({ piles: [3, 4, 5] });
    expect(payload.myTurn).toBe(true);
    expect(payload.fetchedVia).toBe('http');
    expect(mocks.http.calls.length).toBe(1);
  });

  it('propagates waiting status from the HTTP fallback (myTurn:false)', async () => {
    seedCreds();
    seedMatch('m-wait', 'tic-tac-toe', 3);
    mocks.http.responder = () => ({
      status: 200,
      data: {
        matchId: 'm-wait',
        gameId: 'tic-tac-toe',
        status: 'waiting',
        sequence: 3,
        view: { board: [] },
      },
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeGetTurn(captured);
    expect(payload.status).toBe('waiting');
    expect(payload.myTurn).toBe(false);
    expect(payload.fetchedVia).toBe('http');
  });

  it('surfaces non-200 HTTP fallback responses as status:error', async () => {
    seedCreds();
    seedMatch('m-gone', 'tic-tac-toe', 1);
    mocks.http.responder = () => ({ status: 404, data: { error: 'match_not_found' } });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeGetTurn(captured);
    expect(payload).toEqual({
      status: 'error',
      error: 'match_not_found',
      httpStatus: 404,
    });
  });

  it('wraps thrown errors as status:error with isError=true', async () => {
    seedCreds();
    seedMatch('m-boom', 'tic-tac-toe', 1);
    mocks.http.responder = () => {
      throw new Error('boom');
    };
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const tool = captured.tools.find((t) => t.name === 'get_turn');
    const result = await tool.execute('tool-call', {});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe('error');
    expect(payload.error).toBe('exception');
  });
});
