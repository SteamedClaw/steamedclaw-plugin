// Credentials + claim persistence for the SteamedClaw plugin.
//
// DATA DIR: credentials live under ~/.config/steamedclaw-state/ — the same path
// the SteamedClaw skill uses, so an operator who moves between the skill and this
// plugin keeps one registered identity instead of forking a second agent.
//
// The credentials lifecycle: credentials.md is written by the register tool;
// claim.md is the write-once operator claim link. Live match/turn state lives in
// the coordinator's module scope (coordinator.mjs), not on disk — only durable
// identity is persisted here.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DATA_DIR = path.join(os.homedir(), '.config', 'steamedclaw-state');
export const CREDENTIALS = path.join(DATA_DIR, 'credentials.md');
export const CLAIM = path.join(DATA_DIR, 'claim.md');

export function readCredentials() {
  if (!fs.existsSync(CREDENTIALS)) return null;
  const text = fs.readFileSync(CREDENTIALS, 'utf8');
  const server = (text.match(/^Server:\s*(.+)$/m) || [])[1]?.trim();
  const agentId = (text.match(/^Agent ID:\s*(.+)$/m) || [])[1]?.trim();
  const apiKey = (text.match(/^API Key:\s*(.+)$/m) || [])[1]?.trim();
  const name = (text.match(/^Name:\s*(.+)$/m) || [])[1]?.trim() || null;
  if (!server || !agentId || !apiKey) return null;
  if (agentId.includes('not registered') || apiKey.includes('not registered')) return null;
  return { server, agentId, apiKey, name };
}

// H2 (087 security review): credentials.md holds the API key and claim.md holds
// the claim URL + verification code — both must be owner-only so a co-tenant on a
// shared host can't read the key or hijack the claim. Create the dir 0700 and the
// files 0600 (the standard plaintext-token convention; mirrors OpenClaw's own
// credential-file discipline). Both writers are create-only paths (register
// short-circuits on existing creds; claim is write-once), so the create-time
// `mode` reliably applies to every FRESH registration. `mode` is honored only at
// creation, so hardenStatePermissions() below backfills installs that registered
// under a pre-1.0.1 version (0.9.x or 1.0.0). `mode` is a no-op on Windows — harmless.
export function writeCredentials(server, agentId, apiKey, name) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const nameLine = name ? `Name: ${name}\n` : '';
  fs.writeFileSync(
    CREDENTIALS,
    `Server: ${server}\nAgent ID: ${agentId}\nAPI Key: ${apiKey}\n${nameLine}`,
    { mode: 0o600 },
  );
}

// claim.md — the operator-facing claim link, persisted write-once on
// registration so the operator can link the new agent to their SteamedClaw
// account even if they miss the register tool's response.
// Write-once: a second register attempt (credentials deleted externally but
// claim.md survived) must not clobber the original claim URL.
export function writeClaimIfAbsent(claimUrl, verificationCode) {
  if (fs.existsSync(CLAIM)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    CLAIM,
    `Claim URL: ${claimUrl}\n` +
      `Verification code: ${verificationCode || ''}\n` +
      `Registered: ${new Date().toISOString()}\n` +
      `Status: unclaimed\n`,
    { mode: 0o600 },
  );
}

// H2 backfill: create-time `mode` (above) does not retroactively fix a dir/file
// that already exists, so an install that registered under 0.9.x or 1.0.0 keeps
// its loose perms. Chmod owner-only at module load, best-effort. The skill's 088
// fix (`hardenStatePermissions` in steamedclaw-helper.js) does the same for this
// SHARED data dir, so hardening is deterministic regardless of which writer —
// skill or plugin — touches the dir first. chmod is a no-op on Windows.
function hardenStatePermissions() {
  try {
    fs.chmodSync(DATA_DIR, 0o700);
  } catch {
    /* best-effort: dir may not exist yet */
  }
  for (const file of [CREDENTIALS, CLAIM]) {
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    } catch {
      /* best-effort */
    }
  }
}
hardenStatePermissions();
