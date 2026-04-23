import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 — mocked-runtime tests for the Path 3 plugin's queue_match tool.
 *
 * The tool lands a POST on /api/matchmaking/queue via the plugin's
 * httpRequest() helper. We stub `node:fs`, `node:http` and `node:https`
 * via `vi.hoisted` so each test drives tool.execute() against synthetic
 * file state and synthetic HTTP responses without touching the network.
 */

const mocks = vi.hoisted(() => ({
  fsState: { files: new Map(), writes: [] },
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
    constructor() {
      super();
      this.closed = false;
    }
    close() {
      this.closed = true;
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

const { fsState } = mocks;

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
function setResponse(fn) {
  mocks.http.responder = fn;
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

async function invokeQueueMatch(captured, gameId) {
  const tool = captured.tools.find((t) => t.name === 'queue_match');
  expect(tool).toBeTruthy();
  const result = await tool.execute('tool-call-1', { gameId });
  const text = result.content?.[0]?.text;
  return { result, payload: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  fsState.files.clear();
  fsState.writes.length = 0;
  mocks.http.calls.length = 0;
  mocks.http.responder = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('queue_match tool — response-handling matrix', () => {
  it('returns not_registered when credentials.md is missing', async () => {
    setResponse(() => {
      throw new Error('should not POST');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeQueueMatch(captured, 'tic-tac-toe');
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('not_registered');
    expect(payload.message).toMatch(/register_agent/);
    expect(mocks.http.calls.length).toBe(0);
  });

  it('returns already_in_match when current-game.md points at an active match', async () => {
    seedCreds();
    seedMatch('m-active', 'nim', 3);
    setResponse(() => {
      throw new Error('should not POST');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeQueueMatch(captured, 'tic-tac-toe');
    expect(payload).toEqual({
      ok: false,
      error: 'already_in_match',
      matchId: 'm-active',
      game: 'nim',
    });
    expect(mocks.http.calls.length).toBe(0);
  });

  it('POSTs to /api/matchmaking/queue with the configured body + auth header', async () => {
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeQueueMatch(captured, 'tic-tac-toe');
    expect(mocks.http.calls.length).toBe(1);
    const call = mocks.http.calls[0];
    expect(call.opts.method).toBe('POST');
    expect(call.opts.path).toBe('/api/matchmaking/queue');
    expect(call.opts.hostname).toBe('stage.example.com');
    expect(call.opts.headers.Authorization).toBe('Bearer key-xyz');
    expect(call.opts.headers['User-Agent']).toMatch(/^steamedclaw-plugin\/\d/);
    expect(call.opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.body)).toEqual({ gameId: 'tic-tac-toe', lane: 'fast' });
  });

  it('returns matched and writes current-game.md on {status:matched}', async () => {
    seedCreds();
    setResponse(() => ({
      status: 200,
      data: { status: 'matched', matchId: 'm-xyz', players: ['a', 'b'] },
    }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeQueueMatch(captured, 'tic-tac-toe');
    expect(payload).toEqual({
      ok: true,
      status: 'matched',
      matchId: 'm-xyz',
      game: 'tic-tac-toe',
    });
    const current = fsState.files.get(CURRENT);
    expect(current).toContain('match: m-xyz');
    expect(current).toContain('game: tic-tac-toe');
    expect(current).toContain('seq: 0');
  });

  it('round-trips: the current-game.md written on matched is parseable', async () => {
    seedCreds();
    setResponse(() => ({
      status: 200,
      data: { status: 'matched', matchId: 'm-rt', players: ['a', 'b'] },
    }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeQueueMatch(captured, 'four-in-a-row');
    // Second queue call should now see already_in_match (proves the file
    // round-trips through readCurrentMatch()).
    const { payload: second } = await invokeQueueMatch(captured, 'four-in-a-row');
    expect(second).toEqual({
      ok: false,
      error: 'already_in_match',
      matchId: 'm-rt',
      game: 'four-in-a-row',
    });
  });

  it('returns queued and does NOT write current-game.md on {status:queued}', async () => {
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 2 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeQueueMatch(captured, 'nim');
    expect(payload).toEqual({ ok: true, status: 'queued', game: 'nim', position: 2 });
    expect(fsState.files.has(CURRENT)).toBe(false);
  });

  it('surfaces game_not_found distinctly on HTTP 404', async () => {
    seedCreds();
    setResponse(() => ({ status: 404, data: { error: 'game_not_found' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeQueueMatch(captured, 'mystery-game');
    expect(payload).toEqual({ ok: false, error: 'game_not_found', httpStatus: 404 });
    expect(fsState.files.has(CURRENT)).toBe(false);
  });

  it('passes through server error codes with the server error string', async () => {
    seedCreds();
    setResponse(() => ({ status: 503, data: { error: 'server_busy' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeQueueMatch(captured, 'tic-tac-toe');
    expect(payload).toEqual({ ok: false, error: 'server_busy', httpStatus: 503 });
  });

  it('falls back to queue_failed when the error string is missing on non-200', async () => {
    seedCreds();
    setResponse(() => ({ status: 500, data: 'internal server error' }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeQueueMatch(captured, 'tic-tac-toe');
    expect(payload).toEqual({ ok: false, error: 'queue_failed', httpStatus: 500 });
  });

  it('wraps thrown errors as {ok:false, error:exception} and marks isError', async () => {
    seedCreds();
    setResponse(() => {
      throw new Error('boom');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const tool = captured.tools.find((t) => t.name === 'queue_match');
    const result = await tool.execute('tool-call-1', { gameId: 'tic-tac-toe' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('exception');
  });
});
