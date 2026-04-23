import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 — mocked-runtime tests for the Path 3 plugin's get_strategy tool.
 *
 * The tool lands a GET on /api/games/:gameId/strategy via the plugin's
 * httpRequest() helper. We stub `node:fs`, `node:http`, and `node:https`
 * so each test drives tool.execute() against synthetic HTTP responses.
 *
 * This mirrors get-rules-tool.test.mjs because get_strategy deliberately
 * copies the get_rules wire shape — response matrix tests should stay
 * in lockstep.
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

function seedCreds() {
  fsState.files.set(
    CREDS,
    'Server: https://stage.example.com\nAgent ID: agent-1\nAPI Key: key-xyz\n',
  );
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

async function invokeGetStrategy(captured, gameId) {
  const tool = captured.tools.find((t) => t.name === 'get_strategy');
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

describe('get_strategy tool — response-handling matrix', () => {
  it('registers alongside register_agent, queue_match, get_turn, take_turn, get_rules', async () => {
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const names = captured.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_rules',
      'get_strategy',
      'get_turn',
      'queue_match',
      'register_agent',
      'take_turn',
    ]);
  });

  it('tool description actively frames the call as opt-in / safe to skip', async () => {
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const tool = captured.tools.find((t) => t.name === 'get_strategy');
    expect(tool).toBeTruthy();
    // The distinction from get_rules is load-bearing — pin the phrasing
    // so a future edit doesn't accidentally turn this into a mandatory
    // pre-match call.
    expect(tool.description.toLowerCase()).toContain('optional');
    expect(tool.description.toLowerCase()).toMatch(/safe to skip|skip/);
  });

  it('returns not_registered when credentials.md is missing', async () => {
    setResponse(() => {
      throw new Error('should not GET');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeGetStrategy(captured, 'tic-tac-toe');
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('not_registered');
    expect(payload.message).toMatch(/register_agent/);
    expect(mocks.http.calls.length).toBe(0);
  });

  it('GETs /api/games/:gameId/strategy with auth header', async () => {
    seedCreds();
    setResponse(() => ({
      status: 200,
      data: { gameId: 'tic-tac-toe', version: 'abc123', content: '# TTT strategy' },
    }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeGetStrategy(captured, 'tic-tac-toe');
    expect(mocks.http.calls.length).toBe(1);
    const call = mocks.http.calls[0];
    expect(call.opts.method).toBe('GET');
    expect(call.opts.path).toBe('/api/games/tic-tac-toe/strategy');
    expect(call.opts.hostname).toBe('stage.example.com');
    expect(call.opts.headers.Authorization).toBe('Bearer key-xyz');
    expect(call.opts.headers['User-Agent']).toMatch(/^steamedclaw-plugin\/\d/);
  });

  it('passes through {gameId, version, content} on HTTP 200', async () => {
    seedCreds();
    setResponse(() => ({
      status: 200,
      data: { gameId: 'nim', version: 'v1', content: '# Nim strategy\n- XOR heaps' },
    }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeGetStrategy(captured, 'nim');
    expect(payload).toEqual({
      ok: true,
      gameId: 'nim',
      version: 'v1',
      content: '# Nim strategy\n- XOR heaps',
    });
  });

  it('url-encodes unusual gameIds so the path stays valid', async () => {
    seedCreds();
    setResponse(() => ({
      status: 404,
      data: { error: 'game_not_found' },
    }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeGetStrategy(captured, 'weird id/with spaces');
    const call = mocks.http.calls[0];
    expect(call.opts.path).toBe('/api/games/weird%20id%2Fwith%20spaces/strategy');
  });

  it('returns game_not_found on HTTP 404', async () => {
    seedCreds();
    setResponse(() => ({ status: 404, data: { error: 'game_not_found' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeGetStrategy(captured, 'mystery-game');
    expect(payload).toEqual({ ok: false, error: 'game_not_found', gameId: 'mystery-game' });
  });

  it('returns fetch_failed with httpStatus on other non-200 responses', async () => {
    seedCreds();
    setResponse(() => ({ status: 503, data: 'service unavailable' }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeGetStrategy(captured, 'tic-tac-toe');
    expect(payload).toEqual({ ok: false, error: 'fetch_failed', httpStatus: 503 });
  });

  it('wraps thrown errors as {ok:false, error:exception} and marks isError', async () => {
    seedCreds();
    setResponse(() => {
      throw new Error('boom');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const tool = captured.tools.find((t) => t.name === 'get_strategy');
    const result = await tool.execute('tool-call-1', { gameId: 'tic-tac-toe' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('exception');
  });
});
