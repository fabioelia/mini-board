// Connector tiles: the things a blank board needs wired up before sources can
// pull — the Claude CLI itself (auth), and the MCP servers (Slack, Atlassian,
// Google Drive, …) that source prompts use as tools. Built-in defaults below;
// board.yml `connectors:` overrides or extends them by id.

import { spawn } from 'node:child_process';
import { nowIso } from './util.js';

export const BUILTIN_CONNECTORS = [
  {
    id: 'claude',
    kind: 'auth',
    title: 'Claude',
    description:
      'The Claude Code CLI — fires and resumes the sessions behind every card, and runs source pulls.',
    setup: null, // login is interactive; instructions only
    instructions:
      'Install: npm install -g @anthropic-ai/claude-code (see https://code.claude.com). ' +
      'Then run `claude` once to log in, or export ANTHROPIC_API_KEY. ' +
      'Verify from here with: mb connect claude --verify',
  },
  {
    id: 'slack',
    kind: 'mcp',
    mcp: 'slack',
    title: 'Slack MCP',
    description: 'Lets source prompts read Slack channels and threads.',
    needs_env: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    setup:
      'claude mcp add slack -s user -e SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN -e SLACK_TEAM_ID=$SLACK_TEAM_ID -- npx -y @modelcontextprotocol/server-slack',
    instructions:
      'Create a Slack app with a bot token (xoxb-…) at api.slack.com/apps and invite it to the channels you care about. ' +
      'SLACK_TEAM_ID is your workspace id (starts with T). ' +
      'Using a different Slack MCP server? Override this tile in board.yml under connectors: slack:.',
  },
  {
    id: 'atlassian',
    kind: 'mcp',
    mcp: 'atlassian',
    title: 'Atlassian MCP',
    description: 'Jira + Confluence via Atlassian’s hosted MCP server (OAuth).',
    setup: 'claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp -s user',
    instructions:
      'After adding the server, run `claude`, type /mcp, pick atlassian, and complete the OAuth flow in the browser.',
  },
  {
    id: 'gdrive',
    kind: 'mcp',
    mcp: 'gdrive',
    title: 'Google Drive MCP',
    description: 'Lets source prompts search and read Google Drive files.',
    setup: 'claude mcp add gdrive -s user -- npx -y @modelcontextprotocol/server-gdrive',
    instructions:
      'The server needs Google OAuth credentials on first run (see its README for the credentials file). ' +
      'Prefer a hosted Drive MCP? Override this tile in board.yml under connectors: gdrive:.',
  },
];

// Merge board.yml `connectors:` (a map keyed by id) over the built-ins.
// Unknown ids become custom MCP tiles.
export function resolveConnectors(board) {
  const overrides = board.connectors ?? {};
  const out = BUILTIN_CONNECTORS.map((c) => ({ ...c, ...(overrides[c.id] ?? {}) }));
  for (const [id, def] of Object.entries(overrides)) {
    if (!BUILTIN_CONNECTORS.some((c) => c.id === id)) {
      out.push({ id, kind: 'mcp', mcp: id, title: id, description: '', ...def });
    }
  }
  return out;
}

// Non-blocking: returns a promise so the caller (the single-threaded web
// server, mostly) keeps serving while `claude` runs — a verify can take
// minutes. Same {status, stdout, stderr} shape as before.
function defaultExec(cmd, timeout = 30_000, env = undefined) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], { timeout, ...(env ? { env } : {}) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ status: 1, stdout, stderr: stderr || String(err.message) }));
    // On timeout the child is killed and `code` is null → treated as non-zero.
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

// Parse `claude mcp list` output. Lines look roughly like:
//   slack: npx -y @modelcontextprotocol/server-slack - ✓ Connected
//   Atlassian: https://mcp.atlassian.com/v1/mcp (HTTP) - ! Needs authentication
//   claude.ai JIRA: https://mcp.atlassian.com/v1/sse - ✗ Failed to connect
// Server names can be any case and contain spaces; keys are lowercased so
// lookups are case-insensitive.
export function parseMcpList(text) {
  const servers = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([^:]+):\s+(.+)$/.exec(line.trim());
    if (!m || !m[2].includes(' - ')) continue; // health lines always have "<target> - <status>"
    const detail = m[2].trim();
    servers[m[1].trim().toLowerCase()] = {
      name: m[1].trim(),
      detail,
      connected: /✓|✔|connected/i.test(detail) && !/✗|✘|failed|error|needs auth/i.test(detail),
      needs_auth: /needs auth/i.test(detail),
    };
  }
  return servers;
}

// Probe reality: is the claude CLI there, and which MCP servers does it see?
// Returns {id: {configured, connected, detail, checked}} for every connector.
export async function checkConnectors(board, state, { exec = defaultExec } = {}) {
  const connectors = resolveConnectors(board);
  const statuses = {};

  const ver = await exec('claude --version');
  const installed = ver.status === 0;
  const version = installed ? ver.stdout.trim().split('\n')[0] : null;

  let mcp = {};
  if (installed) mcp = parseMcpList((await exec('claude mcp list', 60_000)).stdout);

  for (const c of connectors) {
    if (c.kind === 'auth') {
      const verified = state.connectors?.claude?.verified ?? null;
      statuses[c.id] = {
        configured: installed,
        connected: installed && !!verified,
        detail: installed
          ? `${version}${verified ? ` · auth verified ${verified}` : ' · auth unverified (mb connect claude --verify)'}`
          : 'claude CLI not found on PATH',
        checked: nowIso(),
        ...(verified ? { verified } : {}),
      };
    } else {
      const hit = mcp[String(c.mcp ?? c.id).toLowerCase()];
      statuses[c.id] = {
        configured: !!hit,
        connected: !!hit?.connected,
        detail: !installed
          ? 'claude CLI not found on PATH'
          : hit
            ? `${hit.detail}${hit.needs_auth ? ' — run `claude`, type /mcp, and authenticate' : ''}`
            : `not registered (claude mcp list has no "${c.mcp ?? c.id}")`,
        checked: nowIso(),
      };
    }
  }
  return statuses;
}

// Definitive auth check: a real (tiny) headless run.
export async function verifyClaude({ exec = defaultExec } = {}) {
  const res = await exec('claude -p "Reply with exactly: ok" --output-format json', 180_000);
  if (res.status !== 0) {
    return { ok: false, detail: (res.stderr || res.stdout || 'claude exited non-zero').trim().slice(0, 300) };
  }
  try {
    const data = JSON.parse(res.stdout.trim().split('\n').findLast((l) => l.startsWith('{')));
    return { ok: true, session: data.session_id ?? null, detail: String(data.result ?? '').slice(0, 100) };
  } catch {
    return { ok: false, detail: 'could not parse claude output' };
  }
}

// Run a connector's setup command (e.g. `claude mcp add …`) on behalf of the
// UI. `values` are user-supplied env vars (from the web form) — only keys the
// connector declares in needs_env are honored, layered over the process env
// for the setup command's shell. Returns a discriminated result: manual (no
// setup command), missing env, failed, or ok — the caller renders it, we
// never throw.
export async function setupConnector(board, id, { exec = defaultExec, env = process.env, values = {} } = {}) {
  const conn = resolveConnectors(board).find((c) => c.id === id);
  if (!conn) return { ok: false, error: `unknown connector "${id}"` };
  if (!conn.setup) {
    return { ok: false, manual: true, instructions: conn.instructions ?? 'no setup command — configure it manually' };
  }
  const effective = { ...env };
  for (const key of conn.needs_env ?? []) {
    if (typeof values[key] === 'string' && values[key].trim()) effective[key] = values[key].trim();
  }
  const missing = missingEnv(conn, effective);
  if (missing.length) {
    // `setup_cmd`, not `setup` — the API response merges this with the board
    // payload, which already has a `setup` key.
    return { ok: false, missing, setup_cmd: conn.setup, instructions: conn.instructions ?? null };
  }
  const res = await exec(conn.setup, 120_000, effective);
  if (res.status !== 0) {
    const output = (res.stderr || res.stdout || '').trim();
    // `claude mcp add` refuses to re-add a server (even case-insensitively) —
    // that means it's set up; don't present it as a failure.
    if (/already exists/i.test(output)) {
      return { ok: true, instructions: conn.instructions ?? null, note: 'server was already registered' };
    }
    return { ok: false, error: `setup exited ${res.status}`, output: output.slice(-400) };
  }
  return { ok: true, instructions: conn.instructions ?? null };
}

// Missing env vars for a connector's setup command, if it declares any.
export function missingEnv(connector, env = process.env) {
  return (connector.needs_env ?? []).filter((k) => !env[k]);
}
