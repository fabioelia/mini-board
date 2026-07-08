// Connector tiles: the things a blank board needs wired up before sources can
// pull — the Claude CLI itself (auth), and the MCP servers (Slack, Atlassian,
// Google Drive, …) that source prompts use as tools. Built-in defaults below;
// board.yml `connectors:` overrides or extends them by id.

import { spawnSync } from 'node:child_process';
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
      'Create a Slack app with a bot token (xoxb-…), invite it to the channels you care about, ' +
      'export SLACK_BOT_TOKEN and SLACK_TEAM_ID, then run the setup command. ' +
      'Using a different Slack MCP server? Override this tile in board.yml under connectors: slack:.',
  },
  {
    id: 'atlassian',
    kind: 'mcp',
    mcp: 'atlassian',
    title: 'Atlassian MCP',
    description: 'Jira + Confluence via Atlassian’s hosted MCP server (OAuth).',
    setup: 'claude mcp add --transport sse atlassian https://mcp.atlassian.com/v1/sse -s user',
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

function defaultExec(cmd, timeout = 30_000) {
  const res = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// Parse `claude mcp list` output. Lines look roughly like:
//   slack: npx -y @modelcontextprotocol/server-slack - ✓ Connected
//   atlassian: https://mcp.atlassian.com/v1/sse (SSE) - ✗ Failed to connect
export function parseMcpList(text) {
  const servers = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([\w][\w.-]*):\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const detail = m[2].trim();
    servers[m[1]] = {
      detail,
      connected: /✓|connected/i.test(detail) && !/✗|failed|error/i.test(detail),
    };
  }
  return servers;
}

// Probe reality: is the claude CLI there, and which MCP servers does it see?
// Returns {id: {configured, connected, detail, checked}} for every connector.
export function checkConnectors(board, state, { exec = defaultExec } = {}) {
  const connectors = resolveConnectors(board);
  const statuses = {};

  const ver = exec('claude --version');
  const installed = ver.status === 0;
  const version = installed ? ver.stdout.trim().split('\n')[0] : null;

  let mcp = {};
  if (installed) mcp = parseMcpList(exec('claude mcp list', 60_000).stdout);

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
      const hit = mcp[c.mcp ?? c.id];
      statuses[c.id] = {
        configured: !!hit,
        connected: !!hit?.connected,
        detail: !installed
          ? 'claude CLI not found on PATH'
          : hit
            ? hit.detail
            : `not registered (claude mcp list has no "${c.mcp ?? c.id}")`,
        checked: nowIso(),
      };
    }
  }
  return statuses;
}

// Definitive auth check: a real (tiny) headless run.
export function verifyClaude({ exec = defaultExec } = {}) {
  const res = exec('claude -p "Reply with exactly: ok" --output-format json', 180_000);
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

// Missing env vars for a connector's setup command, if it declares any.
export function missingEnv(connector, env = process.env) {
  return (connector.needs_env ?? []).filter((k) => !env[k]);
}
