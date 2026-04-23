import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 — mocked-runtime tests for the claim surface under LLM-driven
 * registration (#387 as reshaped by #390): claim.md + operatorNotice are
 * produced synchronously inside the register_agent tool's response,
 * rather than deferred to the next tool call.
 *
 * Shares the node:fs + node:http(s) + ws mock harness pattern used by
 * registration.test.mjs so the plugin doesn't touch the real filesystem
 * or network. Covers:
 *
 *   - claim.md is written on register_agent success with Announced:true
 *     from the start.
 *   - Info-level logs emit the claim URL and verification code.
 *   - register_agent response carries operatorNotice with the claim URL
 *     + verification code + the "Link me to your operator account"
 *     framing for the LLM to relay.
 *   - Empty claim_url in the server response skips writing claim.md but
 *     still returns a success with operatorNotice null.
 *   - Empty verification_code writes claim.md without the code and
 *     operatorNotice omits the "(verification code: …)" suffix.
 *   - Write-once: if claim.md already exists, the tool never rewrites it.
 *   - Subsequent tool calls after registration do NOT carry operatorNotice
 *     (the deferred-merge path is deleted).
 *   - Pre-existing credentials.md causes register_agent to short-circuit
 *     without a POST or a claim.md rewrite.
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
      this.readyState = 0;
    }
    close() {
      this.closed = true;
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

const { fsState } = mocks;

const path = await import('node:path');
const os = await import('node:os');
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.config', 'steamedclaw-state');
const CREDS = path.join(STATE_DIR, 'credentials.md');
const CLAIM = path.join(STATE_DIR, 'claim.md');

function setResponse(fn) {
  mocks.http.responder = fn;
}

function setRegistrationResponse(overrides = {}) {
  setResponse(({ opts }) => {
    if (opts.path === '/api/agents' && opts.method === 'POST') {
      return {
        status: 201,
        data: {
          id: 'agent-new-1',
          apiKey: 'key-secret',
          claim_url: 'https://stage.example.com/claim?agent=agent-new-1',
          verification_code: 'sc-verify-abcd1234abcd1234',
          ...overrides,
        },
      };
    }
    if (opts.path === '/api/matchmaking/queue' && opts.method === 'POST') {
      return { status: 200, data: { status: 'queued', position: 1 } };
    }
    if (opts.path?.startsWith('/api/games/') && opts.path?.endsWith('/rules')) {
      return {
        status: 200,
        data: { gameId: 'tic-tac-toe', version: '1.0', content: 'rules body' },
      };
    }
    throw new Error(`unhandled mock request: ${opts.method} ${opts.path}`);
  });
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

async function invokeTool(captured, name, args = {}) {
  const tool = captured.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  const result = await tool.execute('tool-call', args);
  const text = result.content?.[0]?.text;
  return { result, payload: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  fsState.files.clear();
  fsState.writes.length = 0;
  mocks.http.calls.length = 0;
  mocks.http.responder = null;
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('claim surface under LLM-driven registration (#387 + #390)', () => {
  it('writes claim.md with Status:unclaimed + Announced:true on register_agent success', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeTool(captured, 'register_agent', { name: 'NewAgent' });

    const claim = fsState.files.get(CLAIM);
    expect(claim).toBeTruthy();
    expect(claim).toContain('Claim URL: https://stage.example.com/claim?agent=agent-new-1');
    expect(claim).toContain('Verification code: sc-verify-abcd1234abcd1234');
    expect(claim).toMatch(/^Registered: \d{4}-\d{2}-\d{2}T/m);
    expect(claim).toContain('Status: unclaimed');
    // Under #390 the notice fires in the tool response directly, so the
    // Announced flag is true from the start — no deferred flip.
    expect(claim).toContain('Announced: true');
    expect(fsState.files.get(CREDS)).toContain('Agent ID: agent-new-1');
  });

  it('logs the claim URL and verification code at info level on registration', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeTool(captured, 'register_agent', { name: 'NewAgent' });

    const infoLines = captured.logger.info.mock.calls.map((c) => String(c[0]));
    expect(infoLines.some((l) => /OPERATOR ACTION: claim this agent at/.test(l))).toBe(true);
    expect(
      infoLines.some((l) => l.includes('https://stage.example.com/claim?agent=agent-new-1')),
    ).toBe(true);
    expect(infoLines.some((l) => /verification code: sc-verify-abcd1234abcd1234/.test(l))).toBe(
      true,
    );
  });

  it('register_agent response carries operatorNotice with claim URL and verification code', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeTool(captured, 'register_agent', { name: 'NewAgent' });

    expect(payload.ok).toBe(true);
    expect(typeof payload.operatorNotice).toBe('string');
    expect(payload.operatorNotice).toContain('https://stage.example.com/claim?agent=agent-new-1');
    expect(payload.operatorNotice).toContain('verification code: sc-verify-abcd1234abcd1234');
    expect(payload.operatorNotice).toMatch(/I registered on SteamedClaw/);
    expect(payload.claimUrl).toBe('https://stage.example.com/claim?agent=agent-new-1');
    expect(payload.verificationCode).toBe('sc-verify-abcd1234abcd1234');
  });

  it('does NOT attach operatorNotice to subsequent tool calls after registration', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeTool(captured, 'register_agent', { name: 'NewAgent' });

    const { payload: queuePayload } = await invokeTool(captured, 'queue_match', {
      gameId: 'tic-tac-toe',
    });
    expect(queuePayload.ok).toBe(true);
    expect(queuePayload).not.toHaveProperty('operatorNotice');

    const { payload: rulesPayload } = await invokeTool(captured, 'get_rules', {
      gameId: 'tic-tac-toe',
    });
    expect(rulesPayload.ok).toBe(true);
    expect(rulesPayload).not.toHaveProperty('operatorNotice');
  });

  it('short-circuits with already_registered (and no claim.md rewrite) when credentials exist', async () => {
    // Seed pre-existing credentials + claim.md. register_agent must not
    // POST and must not rewrite the existing claim.
    fsState.files.set(
      CREDS,
      'Server: https://stage.example.com\nAgent ID: pre-existing\nAPI Key: key-pre\nName: PreExisting\n',
    );
    fsState.files.set(
      CLAIM,
      'Claim URL: https://stage.example.com/claim?agent=pre-existing\n' +
        'Verification code: sc-verify-pre\n' +
        'Registered: 2026-04-20T00:00:00.000Z\n' +
        'Status: unclaimed\n' +
        'Announced: true\n',
    );
    setResponse(() => {
      throw new Error('should not POST');
    });

    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeTool(captured, 'register_agent', { name: 'AttemptedName' });

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('already_registered');
    expect(payload.name).toBe('PreExisting');
    expect(mocks.http.calls.length).toBe(0);
    // Surviving claim.md untouched.
    expect(fsState.files.get(CLAIM)).toContain('pre-existing');
    expect(fsState.files.get(CLAIM)).toContain('sc-verify-pre');
  });

  it('write-once: if claim.md pre-exists but credentials.md is gone, a second registration does not overwrite claim', async () => {
    fsState.files.set(
      CLAIM,
      'Claim URL: https://stage.example.com/claim?agent=pre-existing\n' +
        'Verification code: sc-verify-pre\n' +
        'Registered: 2026-04-20T00:00:00.000Z\n' +
        'Status: unclaimed\n' +
        'Announced: true\n',
    );
    // Fresh POST path: no credentials.md, so register_agent POSTs.
    setRegistrationResponse({ id: 'agent-rereg', apiKey: 'key-rereg' });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeTool(captured, 'register_agent', { name: 'ReRegAttempt' });

    // The surviving claim.md kept its original URL and Announced state.
    expect(fsState.files.get(CLAIM)).toContain('pre-existing');
    expect(fsState.files.get(CLAIM)).not.toContain('agent-rereg');
    expect(fsState.files.get(CLAIM)).toContain('Announced: true');
    // Credentials were written fresh.
    expect(fsState.files.get(CREDS)).toContain('Agent ID: agent-rereg');
  });

  it('pins the Registered timestamp against the current wallclock under fake timers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-22T12:34:56.789Z'));
    try {
      setRegistrationResponse();
      const { default: entry } = await import('../index.js');
      const { api, captured } = makeMockApi();
      entry.register(api);
      await invokeTool(captured, 'register_agent', { name: 'NewAgent' });

      const claim = fsState.files.get(CLAIM);
      expect(claim).toContain('Registered: 2026-04-22T12:34:56.789Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT write claim.md when server response omits claim_url (empty string)', async () => {
    setRegistrationResponse({ claim_url: '', verification_code: '' });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeTool(captured, 'register_agent', { name: 'NewAgent' });

    // Registration wrote credentials but did NOT write claim.md.
    expect(fsState.files.get(CREDS)).toContain('Agent ID: agent-new-1');
    expect(fsState.files.has(CLAIM)).toBe(false);
    // Success payload carries null claim fields.
    expect(payload.ok).toBe(true);
    expect(payload.claimUrl).toBeNull();
    expect(payload.verificationCode).toBeNull();
    expect(payload.operatorNotice).toBe('');
  });

  it('writes claim.md with empty Verification code field when server sent URL but no code', async () => {
    setRegistrationResponse({ verification_code: '' });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeTool(captured, 'register_agent', { name: 'NewAgent' });

    const claim = fsState.files.get(CLAIM);
    expect(claim).toContain('Claim URL: https://stage.example.com/claim');
    expect(claim).toMatch(/^Verification code: *$/m);

    const infoLines = captured.logger.info.mock.calls.map((c) => String(c[0]));
    expect(infoLines.some((l) => /OPERATOR ACTION/.test(l))).toBe(true);
    expect(infoLines.some((l) => /verification code:/.test(l))).toBe(false);

    // operatorNotice still fires, with no "(verification code: …)" suffix.
    expect(payload.operatorNotice).toContain('https://stage.example.com/claim');
    expect(payload.operatorNotice).not.toMatch(/verification code:/);
  });
});
