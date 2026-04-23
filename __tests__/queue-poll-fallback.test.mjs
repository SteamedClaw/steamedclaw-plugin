import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 — mocked-runtime tests for the Path 3 plugin's queue-poll
 * fallback service (#385). `/api/matchmaking/status` is polled every
 * 30 s whenever the plugin has a pending-queue marker AND /ws/agent is
 * not OPEN, so a queued agent can still discover its pairing if the WS
 * upgrade is stripped (404-cap, hostile proxy, mid-deploy route).
 *
 * Tests stub `node:fs`, `node:http`, `node:https`, and `ws` so the poll
 * cycle can be driven via fake timers without booting a server.
 */

const mocks = vi.hoisted(() => ({
  fsState: { files: new Map(), writes: [] },
  http: { calls: [], responder: null },
  wsInstances: [],
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
      this.readyState = 0;
      mocks.wsInstances.push(this);
    }
    close(code, reason) {
      this.closed = true;
      this.readyState = 3;
      queueMicrotask(() => this.emit('close', code, Buffer.from(String(reason ?? ''))));
    }
    removeAllListeners(event) {
      super.removeAllListeners(event);
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
const PENDING = path.join(STATE_DIR, 'pending-queue.md');

function seedCreds() {
  fsState.files.set(
    CREDS,
    'Server: https://stage.example.com\nAgent ID: agent-1\nAPI Key: key-xyz\n',
  );
}

function seedPending(gameId) {
  fsState.files.set(PENDING, `game: ${gameId}\nqueuedAt: 2026-04-22T09:00:00.000Z\n`);
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
      registerTool: (tool) => tools.push(tool),
      registerService: (svc) => services.push(svc),
      registerHook: () => {},
      ...overrides,
    },
  };
}

async function drainMicrotasks() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function findPollSvc(captured) {
  return captured.services.find((s) => s.id === 'steamedclaw-queue-poll-service');
}

function findAgentSvc(captured) {
  return captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
}

async function invokeQueueMatch(captured, gameId) {
  const tool = captured.tools.find((t) => t.name === 'queue_match');
  expect(tool).toBeTruthy();
  const result = await tool.execute('tc', { gameId });
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

beforeEach(() => {
  fsState.files.clear();
  fsState.writes.length = 0;
  mocks.http.calls.length = 0;
  mocks.http.responder = null;
  wsInstances.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────────────
// queue_match tool — pending-queue marker behaviour
// ──────────────────────────────────────────────────────────────────────

describe('queue_match writes/clears pending-queue.md', () => {
  it('on {status:queued}, writes game + queuedAt to pending-queue.md', async () => {
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const payload = await invokeQueueMatch(captured, 'tic-tac-toe');
    expect(payload.status).toBe('queued');
    const pending = fsState.files.get(PENDING);
    expect(pending).toContain('game: tic-tac-toe');
    expect(pending).toMatch(/queuedAt: \d{4}-\d{2}-\d{2}T/);
  });

  it('on {status:matched}, clears any stale pending-queue.md', async () => {
    seedCreds();
    seedPending('nim');
    setResponse(() => ({ status: 200, data: { status: 'matched', matchId: 'm-a' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const payload = await invokeQueueMatch(captured, 'tic-tac-toe');
    expect(payload.status).toBe('matched');
    expect(fsState.files.get(PENDING)).toBe('No pending queue.\n');
  });

  it('on error responses, does NOT write a pending-queue marker', async () => {
    seedCreds();
    setResponse(() => ({ status: 404, data: { error: 'game_not_found' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeQueueMatch(captured, 'does-not-exist');
    expect(fsState.files.has(PENDING)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// agent-ws handler — pending-queue marker clearing on push
// ──────────────────────────────────────────────────────────────────────

describe('match_found push clears pending-queue.md', () => {
  it('clearing the marker fires alongside writeCurrentMatch on first match_found', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = findAgentSvc(captured);
    await agentSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    ws.readyState = 1;
    ws.emit('open');
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'match_found', matchId: 'm-1', gameId: 'tic-tac-toe' })),
    );
    expect(fsState.files.get(CURRENT)).toContain('match: m-1');
    expect(fsState.files.get(PENDING)).toBe('No pending queue.\n');
    await agentSvc.stop();
  });

  it('duplicate match_found for an already-active matchId still clears marker (idempotent)', async () => {
    seedCreds();
    fsState.files.set(CURRENT, 'match: m-same\ngame: tic-tac-toe\nseq: 0\n');
    seedPending('tic-tac-toe');
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = findAgentSvc(captured);
    await agentSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    ws.readyState = 1;
    ws.emit('open');
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'match_found', matchId: 'm-same', gameId: 'tic-tac-toe' }),
      ),
    );
    expect(captured.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(fsState.files.get(PENDING)).toBe('No pending queue.\n');
    await agentSvc.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Poll service behaviour
// ──────────────────────────────────────────────────────────────────────

describe('queue-poll service — core response matrix', () => {
  it('does nothing when started with no pending marker (no HTTP call)', async () => {
    seedCreds();
    setResponse(() => {
      throw new Error('should not poll');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.http.calls.length).toBe(0);
    await pollSvc.stop();
  });

  it('on boot with an existing pending marker, polls once /ws/agent stays closed (30 s)', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 2 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    // Nothing at t=0; first poll at t=30 s.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(mocks.http.calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    await drainMicrotasks();
    expect(mocks.http.calls.length).toBe(1);
    const call = mocks.http.calls[0];
    expect(call.opts.method).toBe('GET');
    expect(call.opts.path).toBe('/api/matchmaking/status?gameId=tic-tac-toe');
    expect(call.opts.hostname).toBe('stage.example.com');
    expect(call.opts.headers.Authorization).toBe('Bearer key-xyz');
    expect(call.opts.headers['User-Agent']).toMatch(/^steamedclaw-plugin\/\d/);
    await pollSvc.stop();
  });

  it('URL-encodes the gameId in the status query', async () => {
    seedCreds();
    seedPending('murder-mystery-5');
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(mocks.http.calls[0].opts.path).toBe('/api/matchmaking/status?gameId=murder-mystery-5');
    await pollSvc.stop();
  });

  it('on {status:matched}, writes current-game.md, wakes agent, clears marker, fires matchSvc.onMatchFoundExternal', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 200, data: { status: 'matched', matchId: 'm-poll' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    const spy = vi.spyOn(matchSvc, 'onMatchFoundExternal');
    await pollSvc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(fsState.files.get(CURRENT)).toContain('match: m-poll');
    expect(fsState.files.get(CURRENT)).toContain('game: tic-tac-toe');
    expect(fsState.files.get(PENDING)).toBe('No pending queue.\n');
    expect(captured.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    await pollSvc.stop();
  });

  it('on {status:not_queued}, clears marker and stops polling without further requests', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 200, data: { status: 'not_queued' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(fsState.files.get(PENDING)).toBe('No pending queue.\n');
    const callCountAfterFirst = mocks.http.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.http.calls.length).toBe(callCountAfterFirst);
    await pollSvc.stop();
  });

  it('on {status:queued}, keeps polling at the 30 s ceiling (no aggressive retry)', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 3 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    // First poll at +30 s.
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(mocks.http.calls.length).toBe(1);
    // No second poll before the next 30 s tick (pin: ceiling is respected).
    await vi.advanceTimersByTimeAsync(28_000);
    expect(mocks.http.calls.length).toBe(1);
    // Second poll lands.
    await vi.advanceTimersByTimeAsync(2000);
    await drainMicrotasks();
    expect(mocks.http.calls.length).toBe(2);
    await pollSvc.stop();
  });
});

describe('queue-poll service — defensive branches', () => {
  it('on missing credentials mid-cycle, reschedules without issuing a request', async () => {
    // Marker present but credentials.md was deleted out from under the
    // plugin (e.g. operator rotation). tick() must stay at the 30 s
    // cadence and not poll without auth.
    seedPending('tic-tac-toe');
    setResponse(() => {
      throw new Error('should not poll without creds');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(mocks.http.calls.length).toBe(0);
    // Restoring creds between ticks lets the next poll proceed normally.
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(mocks.http.calls.length).toBe(1);
    await pollSvc.stop();
  });
});

describe('queue-poll service — error handling', () => {
  it('on 401, clears marker and stops (subsequent ticks do not poll)', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 401, data: { error: 'unauthorized' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(mocks.http.calls.length).toBe(1);
    expect(fsState.files.get(PENDING)).toBe('No pending queue.\n');
    // A second marker written afterwards must not re-arm the stopped service.
    seedPending('nim');
    pollSvc.notifyMarkerWritten();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.http.calls.length).toBe(1);
    await pollSvc.stop();
  });

  it('on 5xx, stays at the 30 s cadence and keeps the marker (transient)', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 503, data: { error: 'server_busy' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(30_000);
    await drainMicrotasks();
    // Two polls across ~60 s — no faster retry.
    expect(mocks.http.calls.length).toBe(2);
    expect(fsState.files.get(PENDING)).toContain('game: tic-tac-toe');
    await pollSvc.stop();
  });

  it('on request network error, retries on the normal 30 s schedule (no tight loop)', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => {
      throw new Error('ECONNREFUSED');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(30_000);
    await drainMicrotasks();
    expect(mocks.http.calls.length).toBe(2);
    await pollSvc.stop();
  });
});

describe('queue-poll service — /ws/agent open/close coupling', () => {
  it('on agent-ws open signal, cancels the scheduled poll before it fires', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    // A tick is scheduled at t=30 s. At t=10 s, /ws/agent opens — cancel.
    await vi.advanceTimersByTimeAsync(10_000);
    pollSvc.onAgentWsOpen();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.http.calls.length).toBe(0);
    await pollSvc.stop();
  });

  it('on agent-ws close signal with a marker present, re-arms the cycle', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    // Open immediately → poll cancelled.
    pollSvc.onAgentWsOpen();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.http.calls.length).toBe(0);
    // Close → re-arm. First poll 30 s later.
    pollSvc.onAgentWsClosed();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(mocks.http.calls.length).toBe(1);
    await pollSvc.stop();
  });

  it('a full /ws/agent OPEN transition (from the real agent-ws socket) cancels the poll', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = findAgentSvc(captured);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    await agentSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    expect(ws).toBeTruthy();
    ws.readyState = 1;
    ws.emit('open');
    // A poll was scheduled at t=30 s. OPEN fired at t=0. After 60 s, no poll.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.http.calls.length).toBe(0);
    await agentSvc.stop();
    await pollSvc.stop();
  });
});

describe('queue-poll service — idempotency and race coverage', () => {
  it('does not re-write current-game.md or re-call onMatchFoundExternal when match already live (push-then-poll race)', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    // Simulate a match_found push landing before the poll resolves.
    fsState.files.set(CURRENT, 'match: m-live\ngame: tic-tac-toe\nseq: 0\n');
    setResponse(() => ({ status: 200, data: { status: 'matched', matchId: 'm-live' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    const spy = vi.spyOn(matchSvc, 'onMatchFoundExternal');
    await pollSvc.start();
    const writesBefore = fsState.writes.filter((w) => w[0] === CURRENT).length;
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    // current-game.md must not be re-written for the same matchId.
    const writesAfter = fsState.writes.filter((w) => w[0] === CURRENT).length;
    expect(writesAfter).toBe(writesBefore);
    // matchSvc must not be re-wired for a match already active.
    expect(spy).not.toHaveBeenCalled();
    // Heartbeat wake must not fire again.
    expect(captured.requestHeartbeatNow).not.toHaveBeenCalled();
    // Marker is still cleared (stale by definition).
    expect(fsState.files.get(PENDING)).toBe('No pending queue.\n');
    await pollSvc.stop();
  });

  it('notifyMarkerWritten triggers a scheduled tick when /ws/agent is not open', async () => {
    seedCreds();
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    // No marker — no poll would fire.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.http.calls.length).toBe(0);
    // Write marker and nudge — the next poll fires at +30 s.
    seedPending('tic-tac-toe');
    pollSvc.notifyMarkerWritten();
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(mocks.http.calls.length).toBe(1);
    await pollSvc.stop();
  });

  it('stop() prevents any further polls even if a tick was scheduled', async () => {
    seedCreds();
    seedPending('tic-tac-toe');
    setResponse(() => ({ status: 200, data: { status: 'queued', position: 1 } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    await pollSvc.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.http.calls.length).toBe(0);
  });
});

describe('queue-poll service — wiring into queue_match', () => {
  it('a queue_match call that returns queued nudges the poll service to schedule a tick', async () => {
    seedCreds();
    let callIdx = 0;
    setResponse(() => {
      callIdx += 1;
      // First call is POST /api/matchmaking/queue; second+ are the status polls.
      if (callIdx === 1) {
        return { status: 200, data: { status: 'queued', position: 1 } };
      }
      return { status: 200, data: { status: 'matched', matchId: 'm-late' } };
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    await pollSvc.start();
    // No marker yet — the poll cycle is paused.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      mocks.http.calls.filter((c) => c.opts.path.startsWith('/api/matchmaking/status')).length,
    ).toBe(0);
    // queue_match lands a 'queued' — writes marker + nudges.
    const res = await invokeQueueMatch(captured, 'tic-tac-toe');
    expect(res.status).toBe('queued');
    // First status poll at +30 s.
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    const statusCalls = mocks.http.calls.filter((c) =>
      c.opts.path.startsWith('/api/matchmaking/status'),
    );
    expect(statusCalls.length).toBe(1);
    await pollSvc.stop();
  });
});

describe('queue-poll service — source-shape regressions', () => {
  it('poll service id is exposed under a distinct, stable identifier', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const pollSvc = findPollSvc(captured);
    expect(pollSvc).toBeTruthy();
    expect(pollSvc.id).toBe('steamedclaw-queue-poll-service');
    expect(typeof pollSvc.start).toBe('function');
    expect(typeof pollSvc.stop).toBe('function');
    expect(typeof pollSvc.onAgentWsOpen).toBe('function');
    expect(typeof pollSvc.onAgentWsClosed).toBe('function');
    expect(typeof pollSvc.notifyMarkerWritten).toBe('function');
  });
});
