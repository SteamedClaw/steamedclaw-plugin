import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 — mocked-runtime tests for the plugin's defaultLane config field
 * and the per-call `lane` argument on queue_match (#377).
 *
 * Same mock harness as queue-match-tool.test.mjs: stubs `node:fs`, `ws`,
 * `node:http`, and `node:https` so tool.execute() drives synthetic file
 * state and synthetic HTTP responses with no network.
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

function makeMockApi(pluginConfig = {}) {
  const services = [];
  const tools = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const requestHeartbeatNow = vi.fn();
  return {
    captured: { services, tools, logger, requestHeartbeatNow },
    api: {
      registrationMode: 'full',
      pluginConfig: { server: 'https://stage.example.com', ...pluginConfig },
      logger,
      runtime: { system: { requestHeartbeatNow } },
      registerTool: vi.fn((tool) => tools.push(tool)),
      registerService: (svc) => services.push(svc),
      registerHook: () => {},
    },
  };
}

async function invokeQueueMatch(captured, args) {
  const tool = captured.tools.find((t) => t.name === 'queue_match');
  expect(tool).toBeTruthy();
  const result = await tool.execute('tool-call-1', args);
  const text = result.content?.[0]?.text;
  return { result, payload: text ? JSON.parse(text) : null };
}

function lastBodyLane() {
  expect(mocks.http.calls.length).toBe(1);
  return JSON.parse(mocks.http.calls[0].body).lane;
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

describe('queue_match — defaultLane config + per-call lane override', () => {
  it('defaults to "fast" when neither config nor argument set a lane', async () => {
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeQueueMatch(captured, { gameId: 'tic-tac-toe' });
    expect(lastBodyLane()).toBe('fast');
  });

  it('uses configured defaultLane when no argument is given', async () => {
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi({ defaultLane: 'standard' });
    entry.register(api);
    await invokeQueueMatch(captured, { gameId: 'tic-tac-toe' });
    expect(lastBodyLane()).toBe('standard');
  });

  it('accepts a per-call lane argument when no config default is set', async () => {
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeQueueMatch(captured, { gameId: 'tic-tac-toe', lane: 'standard' });
    expect(lastBodyLane()).toBe('standard');
  });

  it('per-call lane="fast" overrides configured defaultLane="standard"', async () => {
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi({ defaultLane: 'standard' });
    entry.register(api);
    await invokeQueueMatch(captured, { gameId: 'tic-tac-toe', lane: 'fast' });
    expect(lastBodyLane()).toBe('fast');
  });

  it('per-call lane="standard" overrides configured defaultLane="fast"', async () => {
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi({ defaultLane: 'fast' });
    entry.register(api);
    await invokeQueueMatch(captured, { gameId: 'tic-tac-toe', lane: 'standard' });
    expect(lastBodyLane()).toBe('standard');
  });

  it('rejects invalid lane values without dispatching an HTTP request', async () => {
    seedCreds();
    setResponse(() => {
      throw new Error('should not POST on invalid lane');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const tool = captured.tools.find((t) => t.name === 'queue_match');
    const result = await tool.execute('tool-call-1', {
      gameId: 'tic-tac-toe',
      lane: 'super-fast',
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('invalid_lane');
    expect(mocks.http.calls.length).toBe(0);
  });
});
