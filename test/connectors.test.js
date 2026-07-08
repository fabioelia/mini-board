import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_CONNECTORS, resolveConnectors, parseMcpList, checkConnectors, missingEnv,
} from '../src/connectors.js';

test('builtins cover the four tiles', () => {
  assert.deepEqual(BUILTIN_CONNECTORS.map((c) => c.id), ['claude', 'slack', 'atlassian', 'gdrive']);
});

test('resolveConnectors merges overrides and adds custom tiles', () => {
  const board = {
    connectors: {
      slack: { setup: 'claude mcp add slack -- my-other-slack' },
      sentry: { title: 'Sentry MCP', setup: 'claude mcp add sentry …' },
    },
  };
  const conns = resolveConnectors(board);
  assert.equal(conns.find((c) => c.id === 'slack').setup, 'claude mcp add slack -- my-other-slack');
  const sentry = conns.find((c) => c.id === 'sentry');
  assert.equal(sentry.kind, 'mcp');
  assert.equal(sentry.mcp, 'sentry');
});

test('parseMcpList reads connected and failed servers', () => {
  const out = `Checking MCP server health...

slack: npx -y @modelcontextprotocol/server-slack - ✓ Connected
atlassian: https://mcp.atlassian.com/v1/sse (SSE) - ✗ Failed to connect
`;
  const servers = parseMcpList(out);
  assert.equal(servers.slack.connected, true);
  assert.equal(servers.atlassian.connected, false);
  assert.equal(servers.gdrive, undefined);
});

test('checkConnectors: full picture from stubbed shell', () => {
  const exec = (cmd) => {
    if (cmd.includes('--version')) return { status: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
    if (cmd.includes('mcp list')) {
      return { status: 0, stdout: 'slack: npx … - ✓ Connected\natlassian: … - ✗ Failed to connect\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
  const state = { connectors: { claude: { verified: '2026-07-08T00:00:00Z' } } };
  const statuses = checkConnectors({ connectors: {} }, state, { exec });
  assert.equal(statuses.claude.configured, true);
  assert.equal(statuses.claude.connected, true); // previously verified
  assert.equal(statuses.slack.connected, true);
  assert.equal(statuses.atlassian.configured, true);
  assert.equal(statuses.atlassian.connected, false);
  assert.equal(statuses.gdrive.configured, false);
  assert.match(statuses.gdrive.detail, /not registered/);
});

test('checkConnectors: claude CLI missing', () => {
  const exec = () => ({ status: 127, stdout: '', stderr: 'not found' });
  const statuses = checkConnectors({ connectors: {} }, {}, { exec });
  assert.equal(statuses.claude.configured, false);
  assert.match(statuses.slack.detail, /claude CLI not found/);
});

test('missingEnv', () => {
  const slack = BUILTIN_CONNECTORS.find((c) => c.id === 'slack');
  assert.deepEqual(missingEnv(slack, {}), ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID']);
  assert.deepEqual(missingEnv(slack, { SLACK_BOT_TOKEN: 'x', SLACK_TEAM_ID: 'y' }), []);
  assert.deepEqual(missingEnv(BUILTIN_CONNECTORS.find((c) => c.id === 'atlassian'), {}), []);
});
