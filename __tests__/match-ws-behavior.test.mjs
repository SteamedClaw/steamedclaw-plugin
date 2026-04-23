import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 — mocked-runtime tests for the Path 3 WS plugin.
 *
 * The plugin is imported with `node:fs` and `ws` stubbed via `vi.hoisted`
 * so each test drives the two services (match-ws and agent-ws) against
 * synthetic file state and synthetic WS traffic. No server, no network.
 */

const mocks = vi.hoisted(() => ({
  fsState: { files: new Map(), writes: [] },
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
      mocks.wsInstances.push(this);
    }
    close(code, reason) {
      this.closed = true;
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
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const requestHeartbeatNow = vi.fn();
  return {
    captured: { services, logger, requestHeartbeatNow },
    api: {
      registrationMode: 'full',
      pluginConfig: { server: 'https://stage.example.com' },
      logger,
      runtime: { system: { requestHeartbeatNow } },
      registerTool: vi.fn(),
      registerService: (svc) => services.push(svc),
      registerHook: () => {},
      ...overrides,
    },
  };
}

async function drainMicrotasks() {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  fsState.files.clear();
  fsState.writes.length = 0;
  wsInstances.length = 0;
  // Only fake the timers the plugin uses for reconnect scheduling — leave
  // setImmediate/queueMicrotask real so the fake WS close event and our
  // drainMicrotasks helper still resolve.
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('plugin registration surface (Path 3)', () => {
  it('registers three services and six LLM tools (register_agent + queue_match + get_turn + take_turn + get_rules + get_strategy) in full mode', async () => {
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    expect(captured.services.map((s) => s.id).sort()).toEqual([
      'steamedclaw-agent-ws-service',
      'steamedclaw-queue-poll-service',
      'steamedclaw-ws-match-service',
    ]);
    expect(api.registerTool).toHaveBeenCalledTimes(6);
    const names = api.registerTool.mock.calls.map((c) => c[0].name).sort();
    expect(names).toEqual([
      'get_rules',
      'get_strategy',
      'get_turn',
      'queue_match',
      'register_agent',
      'take_turn',
    ]);
  });

  it('registers all six tools but no WS services in non-full registration mode', async () => {
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi({ registrationMode: 'setup' });
    entry.register(api);
    expect(captured.services).toHaveLength(0);
    expect(api.registerTool).toHaveBeenCalledTimes(6);
    const names = api.registerTool.mock.calls.map((c) => c[0].name).sort();
    expect(names).toEqual([
      'get_rules',
      'get_strategy',
      'get_turn',
      'queue_match',
      'register_agent',
      'take_turn',
    ]);
  });
});

describe('match-ws service behavior', () => {
  it('opens /ws/game/:matchId and wakes the agent on your_turn', async () => {
    seedCreds();
    seedMatch('m-99', 'tic-tac-toe', 1);
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');

    await matchSvc.start();
    await drainMicrotasks();

    const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-99'));
    expect(ws).toBeTruthy();
    expect(ws.opts.headers.Authorization).toBe('Bearer key-xyz');
    expect(ws.opts.headers['User-Agent']).toMatch(/^steamedclaw-plugin\/\d/);

    ws.emit('open');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 2 })));

    expect(captured.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(fsState.files.get(CURRENT)).toContain('seq: 2');

    await matchSvc.stop();
  });

  it('ignores your_turn pushes with non-advancing sequence', async () => {
    seedCreds();
    seedMatch('m-11', 'nim', 5);
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-11'));
    ws.emit('open');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 6 })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 6 })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'your_turn', sequence: 4 })));
    expect(captured.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    await matchSvc.stop();
  });

  it('clears current-game.md, wakes, and closes 1000 on game_over', async () => {
    seedCreds();
    seedMatch('m-done', 'tic-tac-toe', 9);
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/game/m-done'));
    expect(ws.closed).toBe(false);

    ws.emit('open');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'game_over', winner: 'agent-1' })));

    expect(captured.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(fsState.files.get(CURRENT)).toBe('No active game.\n');
    expect(ws.closed).toBe(true);

    await matchSvc.stop();
  });

  it('exposes onMatchFoundExternal that triggers an immediate tick', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    expect(typeof matchSvc.onMatchFoundExternal).toBe('function');

    await matchSvc.start();
    await drainMicrotasks();

    // No match yet — no game socket.
    expect(wsInstances.find((w) => w.url.includes('/ws/game/'))).toBeUndefined();

    // Write current-game.md out of band, then call the hook. The hook
    // runs tick() synchronously (no 5-s wait), which opens the socket.
    seedMatch('m-hook', 'nim', 0);
    await matchSvc.onMatchFoundExternal();
    await drainMicrotasks();

    expect(wsInstances.find((w) => w.url.endsWith('/ws/game/m-hook'))).toBeTruthy();

    await matchSvc.stop();
  });

  it('schedules a reconnect on non-1000 close', async () => {
    seedCreds();
    seedMatch('m-drop', 'tic-tac-toe', 0);
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    await matchSvc.start();
    await drainMicrotasks();
    const firstInstances = wsInstances.length;

    // Simulate an unclean drop — code 1006, no reason.
    wsInstances[0].emit('close', 1006, Buffer.from(''));

    // Advance past the first retry step (base=1000ms).
    await vi.advanceTimersByTimeAsync(1500);
    expect(wsInstances.length).toBeGreaterThan(firstInstances);
    await matchSvc.stop();
  });
});

describe('agent-ws service behavior', () => {
  it('opens /ws/agent with bearer auth', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    await agentSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    expect(ws).toBeTruthy();
    expect(ws.opts.headers.Authorization).toBe('Bearer key-xyz');
    await agentSvc.stop();
  });

  it('writes current-game.md and wakes on match_found', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    await agentSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    ws.emit('open');
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'match_found',
          matchId: 'm-new',
          gameId: 'tic-tac-toe',
        }),
      ),
    );
    expect(fsState.files.get(CURRENT)).toContain('match: m-new');
    expect(fsState.files.get(CURRENT)).toContain('game: tic-tac-toe');
    expect(captured.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    await agentSvc.stop();
  });

  it('is idempotent on a duplicate match_found for the same matchId', async () => {
    seedCreds();
    seedMatch('m-same', 'tic-tac-toe', 0);
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    await agentSvc.start();
    await drainMicrotasks();
    const ws = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    ws.emit('open');
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'match_found', matchId: 'm-same', gameId: 'tic-tac-toe' }),
      ),
    );
    expect(captured.requestHeartbeatNow).not.toHaveBeenCalled();
    await agentSvc.stop();
  });

  it('logs the capability-missing notice only once on repeated 404s', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    await agentSvc.start();
    await drainMicrotasks();
    const ws0 = wsInstances.find((w) => w.url.endsWith('/ws/agent'));

    ws0.emit('unexpected-response', {}, { statusCode: 404 });
    ws0.emit('unexpected-response', {}, { statusCode: 404 });

    const warns = captured.logger.info.mock.calls
      .map((c) => c[0])
      .filter((m) => typeof m === 'string' && m.includes('upgrade rejected'));
    expect(warns.length).toBe(1);

    await agentSvc.stop();
  });

  it('applies jitter to the reconnect delay', async () => {
    seedCreds();
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(1); // jitter = 1.25
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    await agentSvc.start();
    await drainMicrotasks();
    const ws0 = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    ws0.emit('close', 1006, Buffer.from(''));

    // Base 1000ms * 2**0 * 1.25 = 1250ms. At 1200ms the reconnect has not
    // yet fired; at 1300ms it has.
    await vi.advanceTimersByTimeAsync(1200);
    let agentSockets = wsInstances.filter((w) => w.url.endsWith('/ws/agent'));
    expect(agentSockets.length).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    agentSockets = wsInstances.filter((w) => w.url.endsWith('/ws/agent'));
    expect(agentSockets.length).toBe(2);

    randSpy.mockRestore();
    await agentSvc.stop();
  });

  it('handles a `replaced` message without waking or rewriting state', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    await agentSvc.start();
    await drainMicrotasks();
    const ws0 = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    ws0.emit('open');
    ws0.emit('message', Buffer.from(JSON.stringify({ type: 'replaced' })));
    expect(captured.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(fsState.files.has(CURRENT)).toBe(false);
    await agentSvc.stop();
  });

  it('does not reconnect on a clean 1000 close (replaced/service-stop)', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    await agentSvc.start();
    await drainMicrotasks();
    const ws0 = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    ws0.emit('close', 1000, Buffer.from('replaced'));

    await vi.advanceTimersByTimeAsync(60_000);
    const agentSockets = wsInstances.filter((w) => w.url.endsWith('/ws/agent'));
    expect(agentSockets.length).toBe(1);
    await agentSvc.stop();
  });

  it('opens /ws/game/:matchId immediately on match_found without advancing timers', async () => {
    seedCreds();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    await matchSvc.start();
    await agentSvc.start();
    await drainMicrotasks();

    // No match seeded yet — match-ws must not have opened a game socket.
    expect(wsInstances.find((w) => w.url.includes('/ws/game/'))).toBeUndefined();

    const agentWs = wsInstances.find((w) => w.url.endsWith('/ws/agent'));
    expect(agentWs).toBeTruthy();
    agentWs.emit('open');
    agentWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'match_found', matchId: 'm-fast', gameId: 'tic-tac-toe' }),
      ),
    );

    // Drain microtasks only; do NOT advance the fake timer for the 5-s
    // poll. The wire between agent-ws and match-ws must fire the
    // match-ws tick synchronously via onMatchFoundExternal.
    await drainMicrotasks();

    const gameWs = wsInstances.find((w) => w.url.endsWith('/ws/game/m-fast'));
    expect(gameWs).toBeTruthy();

    await matchSvc.stop();
    await agentSvc.stop();
  });
});
