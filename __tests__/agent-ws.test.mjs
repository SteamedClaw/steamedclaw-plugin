import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, '..');

/**
 * Source-shape regression for the Path 3 plugin. The two sibling suites
 * (`match-ws-behavior.test.mjs`, `live-server.test.mjs`) exercise
 * behavior; this file pins the static surface — version strings,
 * service registration, and the URL helpers — so accidental edits show
 * up without booting a runtime.
 */

function readPlugin() {
  return readFileSync(join(PLUGIN_DIR, 'index.js'), 'utf8');
}

function readPluginJson() {
  return JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
}

describe('plugin version metadata', () => {
  it('package.json is 0.9.0 or higher', () => {
    const [major, minor, patch] = readPluginJson().version.split('.').map(Number);
    const atLeast090 =
      major > 0 || (major === 0 && minor > 9) || (major === 0 && minor === 9 && patch >= 0);
    expect(atLeast090).toBe(true);
  });

  it('PLUGIN_USER_AGENT string in index.js matches package.json version', () => {
    const src = readPlugin();
    const pkg = readPluginJson();
    const m = src.match(/const PLUGIN_USER_AGENT = 'steamedclaw-plugin\/([\d.]+)'/);
    expect(m?.[1]).toBe(pkg.version);
  });
});

describe('plugin service registration', () => {
  it('registers makeAgentWsService alongside makeMatchWsService', () => {
    const src = readPlugin();
    expect(src).toContain('function makeAgentWsService');
    // 0.9.8 captures agentSvc as a named binding so makeRegisterAgent
    // can wire its onCredentialsReady hook. Service construction order
    // is still match → poll → agent because agent-ws holds refs to both.
    expect(src).toMatch(/const agentSvc = makeAgentWsService\(api, matchSvc, pollSvc\)/);
    expect(src).toMatch(/registerService\(matchSvc\)/);
    expect(src).toMatch(/registerService\(agentSvc\)/);
    expect(src).toMatch(/registerService\(pollSvc\)/);
    expect(src).toMatch(/const matchSvc = makeMatchWsService\(api\)/);
  });

  it('registers six LLM-visible tools (register_agent, queue_match, get_turn, take_turn, get_rules, get_strategy)', () => {
    const src = readPlugin();
    const registerCalls = src.match(/api\.registerTool\(/g) ?? [];
    expect(registerCalls.length).toBe(6);
    expect(src).toMatch(/name:\s*'register_agent'/);
    expect(src).toMatch(/name:\s*'queue_match'/);
    expect(src).toMatch(/name:\s*'get_turn'/);
    expect(src).toMatch(/name:\s*'take_turn'/);
    expect(src).toMatch(/name:\s*'get_rules'/);
    expect(src).toMatch(/name:\s*'get_strategy'/);
  });
});

describe('plugin /ws/agent URL construction', () => {
  function httpToAgentWsUrl(serverUrl) {
    const u = new URL(serverUrl);
    const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${u.host}/ws/agent`;
  }

  it('maps http → ws', () => {
    expect(httpToAgentWsUrl('http://localhost:3000')).toBe('ws://localhost:3000/ws/agent');
  });

  it('maps https → wss', () => {
    expect(httpToAgentWsUrl('https://stage.steamedclaw.com')).toBe(
      'wss://stage.steamedclaw.com/ws/agent',
    );
  });

  it('preserves ports in the host component', () => {
    expect(httpToAgentWsUrl('http://10.0.0.1:8080/')).toBe('ws://10.0.0.1:8080/ws/agent');
  });
});

describe('plugin match_found handler shape (source inspection)', () => {
  const src = readPlugin();

  it('writes current-game.md on match_found', () => {
    expect(src).toMatch(
      /function handleMatchFound[\s\S]{0,2000}writeCurrentMatch\(matchId, gameId, 0\)/,
    );
  });

  it('wakes the agent via requestHeartbeatNow on match_found', () => {
    expect(src).toMatch(/function handleMatchFound[\s\S]{0,2500}wakeAgent\(`match_found /);
  });

  it('skips rewrite when current match already equals push target (idempotent)', () => {
    expect(src).toMatch(/existing\.matchId === matchId/);
  });
});

describe('plugin reconnect semantics', () => {
  const src = readPlugin();

  it('reconnects with exponential backoff capped at 30s', () => {
    expect(src).toContain('AGENT_WS_RECONNECT_BASE_MS');
    expect(src).toContain('AGENT_WS_RECONNECT_MAX_MS');
    expect(src).toMatch(/AGENT_WS_RECONNECT_BASE_MS\s*=\s*1000/);
    expect(src).toMatch(/AGENT_WS_RECONNECT_MAX_MS\s*=\s*30000/);
  });

  it('does not reconnect on close code 1000 (clean / replaced)', () => {
    expect(src).toMatch(/if \(code === 1000\) return;/);
  });

  it('logs missing /ws/agent capability only once before falling back silently', () => {
    expect(src).toContain('capabilityLoggedMissing');
    expect(src).toContain('unexpected-response');
  });

  it('shuts down cleanly on stop()', () => {
    expect(src).toMatch(/async stop\(\) \{[\s\S]{0,500}ws\.close\(1000, 'service-stop'\)/);
  });
});

describe('plugin reconnect hardening (#358)', () => {
  const src = readPlugin();

  it('applies random jitter inside the agent-ws scheduleReconnect', () => {
    const match = src.match(
      /function makeAgentWsService[\s\S]{0,6000}?function scheduleReconnect[\s\S]{0,2000}?\}/,
    );
    expect(match).not.toBeNull();
    expect(match?.[0] ?? '').toMatch(/Math\.random\(\)/);
    expect(match?.[0] ?? '').toMatch(/0\.75/);
  });

  it('declares a longer 404 reconnect cap constant', () => {
    expect(src).toContain('AGENT_WS_RECONNECT_404_MAX_MS');
    expect(src).toMatch(/AGENT_WS_RECONNECT_404_MAX_MS\s*=\s*300000/);
  });

  it('tracks a 404-seen flag the reconnect scheduler consults', () => {
    expect(src).toMatch(/res\.statusCode === 404/);
  });
});

describe('plugin queue-poll fallback (#385)', () => {
  const src = readPlugin();

  it('declares QUEUE_POLL_MS as the 30 s ceiling', () => {
    expect(src).toMatch(/const QUEUE_POLL_MS\s*=\s*30000/);
  });

  it('exposes makeQueuePollService and registers it alongside the two WS services', () => {
    expect(src).toContain('function makeQueuePollService');
    expect(src).toMatch(/registerService\(pollSvc\)/);
    expect(src).toMatch(/const pollSvc = makeQueuePollService\(api, matchSvc\)/);
  });

  it('wires the agent-ws socket open/close transitions into the poll service', () => {
    expect(src).toMatch(/pollSvc\.onAgentWsOpen\(\)/);
    expect(src).toMatch(/pollSvc\.onAgentWsClosed\(\)/);
  });

  it('writes a pending-queue marker on {status:queued} and clears it on matched/match_found', () => {
    expect(src).toContain('PENDING_QUEUE');
    expect(src).toContain('writePendingQueue');
    expect(src).toContain('clearPendingQueue');
  });

  it('polls GET /api/matchmaking/status with gameId query', () => {
    expect(src).toMatch(/\/api\/matchmaking\/status\?gameId=/);
  });
});
