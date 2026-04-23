import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier 1 — mocked-runtime tests for the `register_agent` tool (#390).
 *
 * The plugin is imported with `node:fs`, `ws`, `node:http`, and
 * `node:https` stubbed via `vi.hoisted`. Drives the tool's execute
 * function directly — no service lifecycle involved except via the
 * onCredentialsReady hooks the tool invokes on success.
 *
 * Covers every response branch:
 *   - already_registered short-circuit when credentials.md exists
 *   - POSTs {name} when only name given; POSTs {name, model} when both
 *   - credentials.md / claim.md writes on 201
 *   - operatorNotice carries claim URL + verification code
 *   - onCredentialsReady() called on match-ws, agent-ws, poll-ws
 *   - name_taken (409), invalid_name (400), network_error, register_failed
 *   - parallel de-duplication (two invocations → one POST)
 *   - Authorization header NOT sent (registration is unauthenticated)
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
      this.readyState = 0;
      mocks.wsInstances.push(this);
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

const { fsState, wsInstances } = mocks;

const path = await import('node:path');
const os = await import('node:os');
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.config', 'steamedclaw-state');
const CREDS = path.join(STATE_DIR, 'credentials.md');
const CLAIM = path.join(STATE_DIR, 'claim.md');

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
    throw new Error(`unhandled mock request: ${opts.method} ${opts.path}`);
  });
}

async function drainMicrotasks() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

async function invokeRegisterAgent(captured, args) {
  const tool = captured.tools.find((t) => t.name === 'register_agent');
  if (!tool) throw new Error('register_agent tool not registered');
  const result = await tool.execute('tc', args);
  const text = result.content?.[0]?.text;
  return { result, payload: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  fsState.files.clear();
  fsState.writes.length = 0;
  wsInstances.length = 0;
  mocks.http.calls.length = 0;
  mocks.http.responder = null;
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('register_agent tool (#390)', () => {
  it('short-circuits with already_registered when credentials.md exists (no HTTP POST)', async () => {
    fsState.files.set(
      CREDS,
      'Server: https://stage.example.com\nAgent ID: existing-id\nAPI Key: existing-key\nName: Preregistered\n',
    );
    setResponse(() => {
      throw new Error('should not POST');
    });

    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: 'SomeOther' });

    expect(mocks.http.calls.length).toBe(0);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('already_registered');
    expect(payload.name).toBe('Preregistered');
    expect(payload.message).toMatch(/Already registered/);
  });

  it('POSTs {name} to /api/agents when only name is given', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: 'NewAgent' });

    expect(mocks.http.calls.length).toBe(1);
    const call = mocks.http.calls[0];
    expect(call.opts.method).toBe('POST');
    expect(call.opts.hostname).toBe('stage.example.com');
    expect(call.opts.path).toBe('/api/agents');
    expect(JSON.parse(call.body)).toEqual({ name: 'NewAgent' });
    expect(payload.ok).toBe(true);
    expect(payload.name).toBe('NewAgent');
    expect(payload.model).toBeNull();
  });

  it('POSTs {name, model} when both are given', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, {
      name: 'ModeledAgent',
      model: 'claude-opus-4-7',
    });

    expect(JSON.parse(mocks.http.calls[0].body)).toEqual({
      name: 'ModeledAgent',
      model: 'claude-opus-4-7',
    });
    expect(payload.model).toBe('claude-opus-4-7');
  });

  it('writes credentials.md with Server/Agent ID/API Key/Name on 201', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeRegisterAgent(captured, { name: 'NewAgent' });

    const creds = fsState.files.get(CREDS);
    expect(creds).toContain('Server: https://stage.example.com');
    expect(creds).toContain('Agent ID: agent-new-1');
    expect(creds).toContain('API Key: key-secret');
    expect(creds).toContain('Name: NewAgent');
  });

  it('writes claim.md with Announced:true from the start on 201', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeRegisterAgent(captured, { name: 'NewAgent' });

    const claim = fsState.files.get(CLAIM);
    expect(claim).toBeTruthy();
    expect(claim).toContain('Claim URL: https://stage.example.com/claim?agent=agent-new-1');
    expect(claim).toContain('Verification code: sc-verify-abcd1234abcd1234');
    expect(claim).toMatch(/^Registered: \d{4}-\d{2}-\d{2}T/m);
    expect(claim).toContain('Status: unclaimed');
    expect(claim).toContain('Announced: true');
  });

  it('success response carries operatorNotice, claimUrl, verificationCode', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: 'NewAgent' });

    expect(payload.ok).toBe(true);
    expect(payload.claimUrl).toBe('https://stage.example.com/claim?agent=agent-new-1');
    expect(payload.verificationCode).toBe('sc-verify-abcd1234abcd1234');
    expect(typeof payload.operatorNotice).toBe('string');
    expect(payload.operatorNotice).toMatch(/I registered on SteamedClaw/);
    expect(payload.operatorNotice).toContain('https://stage.example.com/claim?agent=agent-new-1');
    expect(payload.operatorNotice).toContain('verification code: sc-verify-abcd1234abcd1234');
  });

  it('calls onCredentialsReady() on all three services on successful registration', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const matchSvc = captured.services.find((s) => s.id === 'steamedclaw-ws-match-service');
    const agentSvc = captured.services.find((s) => s.id === 'steamedclaw-agent-ws-service');
    const pollSvc = captured.services.find((s) => s.id === 'steamedclaw-queue-poll-service');
    const matchSpy = vi.spyOn(matchSvc, 'onCredentialsReady');
    const agentSpy = vi.spyOn(agentSvc, 'onCredentialsReady');
    const pollSpy = vi.spyOn(pollSvc, 'onCredentialsReady');

    await invokeRegisterAgent(captured, { name: 'NewAgent' });
    await drainMicrotasks();

    expect(matchSpy).toHaveBeenCalledTimes(1);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  it('returns name_taken with nameAttempted and message on 409', async () => {
    setResponse(() => ({ status: 409, data: { error: 'name_taken' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: 'Taken' });

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('name_taken');
    expect(payload.nameAttempted).toBe('Taken');
    expect(payload.message).toMatch(/"Taken" is already taken/);
    expect(payload.message).toMatch(/Pick a different name/);
    // No credentials written.
    expect(fsState.files.has(CREDS)).toBe(false);
  });

  it('returns invalid_name with nameAttempted on 400', async () => {
    setResponse(() => ({ status: 400, data: { error: 'invalid_name' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: '!!bad!!' });

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('invalid_name');
    expect(payload.nameAttempted).toBe('!!bad!!');
    expect(payload.message).toMatch(/Name is invalid/);
    expect(fsState.files.has(CREDS)).toBe(false);
  });

  it('returns network_error on thrown error during POST', async () => {
    setResponse(() => {
      throw new Error('ECONNREFUSED');
    });
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: 'NetFailName' });

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('network_error');
    expect(payload.message).toMatch(/Network error/);
    expect(payload.message).toMatch(/ECONNREFUSED/);
    expect(fsState.files.has(CREDS)).toBe(false);
  });

  it('returns register_failed with httpStatus on other non-2xx', async () => {
    setResponse(() => ({ status: 503, data: { error: 'upstream_busy' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: 'BusyName' });

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('register_failed');
    expect(payload.httpStatus).toBe(503);
    expect(payload.message).toMatch(/HTTP 503/);
    expect(fsState.files.has(CREDS)).toBe(false);
  });

  it('de-duplicates parallel calls: two invocations produce one POST and share the result', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const [a, b] = await Promise.all([
      invokeRegisterAgent(captured, { name: 'RaceAgent' }),
      invokeRegisterAgent(captured, { name: 'RaceAgent' }),
    ]);

    expect(mocks.http.calls.length).toBe(1);
    // Both resolve to the same success payload (one of the two may see
    // already_registered if its readCredentials read lands after the
    // write — which doesn't happen in this mock harness because both
    // enter before inFlight settles).
    expect(a.payload.ok).toBe(true);
    expect(b.payload.ok).toBe(true);
    expect(a.payload.id).toBe(b.payload.id);
  });

  it('does not send Authorization header (registration is unauthenticated)', async () => {
    setRegistrationResponse();
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    await invokeRegisterAgent(captured, { name: 'UnauthAgent' });

    const call = mocks.http.calls[0];
    expect(call.opts.headers.Authorization).toBeUndefined();
    expect(call.opts.headers['Content-Type']).toBe('application/json');
    expect(call.opts.headers['User-Agent']).toMatch(/^steamedclaw-plugin\/\d/);
  });

  it('returns config_error when plugin config is missing server', async () => {
    setResponse(() => {
      throw new Error('should not POST');
    });
    const { default: entry } = await import('../index.js');
    // Default makeMockApi sets server; override with empty config.
    const { api, captured } = makeMockApi({ pluginConfig: {} });
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: 'NoServer' });

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('config_error');
    expect(payload.message).toMatch(/Plugin config missing "server"/);
    expect(mocks.http.calls.length).toBe(0);
    expect(fsState.files.has(CREDS)).toBe(false);
  });

  it('returns register_failed (httpStatus:201) when 201 response is missing id/apiKey', async () => {
    setResponse(() => ({ status: 201, data: { id: 'only-id' } }));
    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: 'BrokenServerAgent' });

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('register_failed');
    expect(payload.httpStatus).toBe(201);
    expect(payload.message).toMatch(/missing id\/apiKey/);
    // No credentials written.
    expect(fsState.files.has(CREDS)).toBe(false);
  });

  it('already_registered returns generic message when existing credentials.md has no Name line', async () => {
    // Older credentials.md format (pre-#390) has no Name line. The
    // tool should still short-circuit correctly with a generic message.
    fsState.files.set(
      CREDS,
      'Server: https://stage.example.com\nAgent ID: legacy-id\nAPI Key: legacy-key\n',
    );
    setResponse(() => {
      throw new Error('should not POST');
    });

    const { default: entry } = await import('../index.js');
    const { api, captured } = makeMockApi();
    entry.register(api);
    const { payload } = await invokeRegisterAgent(captured, { name: 'SomeName' });

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('already_registered');
    expect(payload.name).toBeNull();
    // Generic message without the named "Already registered as X" variant.
    expect(payload.message).toBe('Already registered. Use queue_match, get_turn, etc.');
    expect(mocks.http.calls.length).toBe(0);
  });
});
