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

export function writeCredentials(server, agentId, apiKey, name) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const nameLine = name ? `Name: ${name}\n` : '';
  fs.writeFileSync(
    CREDENTIALS,
    `Server: ${server}\nAgent ID: ${agentId}\nAPI Key: ${apiKey}\n${nameLine}`,
  );
}

// claim.md — the operator-facing claim link, persisted write-once on
// registration so the operator can link the new agent to their SteamedClaw
// account even if they miss the register tool's response.
// Write-once: a second register attempt (credentials deleted externally but
// claim.md survived) must not clobber the original claim URL.
export function writeClaimIfAbsent(claimUrl, verificationCode) {
  if (fs.existsSync(CLAIM)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    CLAIM,
    `Claim URL: ${claimUrl}\n` +
      `Verification code: ${verificationCode || ''}\n` +
      `Registered: ${new Date().toISOString()}\n` +
      `Status: unclaimed\n`,
  );
}
