import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.MB_NO_SPAWN = '1'; // never launch real claude runs / hit real Jira
delete process.env.JIRA_EMAIL;
delete process.env.JIRA_API_TOKEN;

import { buildHandoffDoc, pushJiraHandoff, jiraOrigin, HANDOFF_DIR } from '../src/handoff.js';
import { applyIssues } from '../src/jira.js';
import { syncCard } from '../src/sync.js';

const board = {
  board: { name: 'Test' },
  defaults: { ticket_url: 'https://acme.atlassian.net/browse/' },
  actions: {}, sync: {},
  jira: { project: 'NP', push_moves: true, board_url: 'http://localhost:4400' },
  columns: [
    { id: 'inbox', title: 'Inbox' },
    { id: 'backlog', title: 'Backlog', jira_status: 'Backlog' },
    { id: 'agent', title: 'Doing', jira_status: 'In Progress' },
    { id: 'done', title: 'Done', jira_status: 'Done' },
  ],
};

function makeState() {
  return {
    next_id: 2,
    cards: {
      'mb-1': {
        title: 'Fix the widget', type: 'ticket', column: 'agent',
        refs: { pr: 'org/repo#7', ticket: 'NP-42', slack: null },
        sessions: [{ id: 'sess-abc', label: 'initial', at: '2026-07-09T00:00:00Z' }],
        flags: [],
        log: [
          { at: '2026-07-09T00:00:00Z', kind: 'create', text: 'created in "inbox"' },
          { at: '2026-07-09T01:00:00Z', kind: 'move', text: 'inbox → agent' },
          { at: '2026-07-09T02:00:00Z', kind: 'session', text: 'Implemented the fix, PR opened.' },
        ],
        created: 'x', updated: 'x',
      },
    },
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mb-handoff-'));
}

test('jiraOrigin derives the site from defaults.ticket_url', () => {
  assert.equal(jiraOrigin(board), 'https://acme.atlassian.net');
  assert.equal(jiraOrigin({ defaults: {} }), null);
  assert.equal(jiraOrigin({ defaults: { ticket_url: 'not a url' } }), null);
});

test('buildHandoffDoc carries refs, sessions with viewer links, summary, and full timeline', () => {
  const doc = buildHandoffDoc(board, makeState(), 'mb-1');
  assert.match(doc, /# Handoff — NP-42: Fix the widget/);
  assert.match(doc, /stage: \*\*Doing\*\*/);
  assert.match(doc, /- Ticket: NP-42/);
  assert.match(doc, /- PR: org\/repo#7/);
  assert.match(doc, /http:\/\/localhost:4400\/session\/sess-abc/);
  assert.match(doc, /## Latest agent summary\n\nImplemented the fix, PR opened\./);
  // every log entry appears in the timeline, in order
  assert.match(doc, /\*\*create\*\* — created in "inbox"[\s\S]*\*\*move\*\* — inbox → agent[\s\S]*\*\*session\*\*/);
});

test('pushJiraHandoff without REST creds writes the file and queues a comment push', () => {
  const root = tmpRoot();
  const state = makeState();
  const res = pushJiraHandoff(root, board, state, 'mb-1');
  assert.equal(res.mode, 'comment');
  const file = path.join(root, HANDOFF_DIR, 'mb-handoff-NP-42.md');
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf8'), /# Handoff — NP-42/);
  // a push log exists (spawn itself suppressed by MB_NO_SPAWN)
  const logs = fs.readdirSync(path.join(root, '.mini-board/logs'));
  assert.ok(logs.some((f) => f.startsWith('handoff-mb-1-')));
  assert.ok(state.cards['mb-1'].log.some((e) => e.kind === 'jira' && /handoff posted/.test(e.text)));
});

test('pushJiraHandoff is a no-op for ticketless cards and jira-less boards', () => {
  const root = tmpRoot();
  const state = makeState();
  state.cards['mb-1'].refs.ticket = null;
  assert.equal(pushJiraHandoff(root, board, state, 'mb-1'), null);
  assert.equal(pushJiraHandoff(root, { ...board, jira: undefined }, makeState(), 'mb-1'), null);
});

test('pushJiraHandoff with REST creds reports attachment mode (network suppressed by MB_NO_SPAWN)', () => {
  process.env.JIRA_EMAIL = 'a@b.c';
  process.env.JIRA_API_TOKEN = 'tok';
  try {
    const res = pushJiraHandoff(tmpRoot(), board, makeState(), 'mb-1');
    assert.equal(res.mode, 'attachment');
  } finally {
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
  }
});

test('applyIssues reports the source lane on Jira-driven moves', () => {
  const state = makeState();
  const { moved } = applyIssues(board, state, [
    { key: 'NP-42', summary: 'Fix the widget', status: 'Backlog', url: null, priority: null },
  ], false);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].from, 'agent');
  assert.equal(moved[0].to, 'backlog');
});

test('syncCard reports the source lane on auto_move', async () => {
  const b = { ...board, sync: { auto_move: { pr_merged: 'done' } } };
  const state = makeState();
  const exec = async () => ({
    status: 0,
    stdout: JSON.stringify({ state: 'MERGED', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'UNKNOWN', statusCheckRollup: [], url: 'u', title: 't', updatedAt: 'now' }),
    stderr: '',
  });
  const res = await syncCard(b, state, 'mb-1', { exec });
  assert.equal(res.moved, 'done');
  assert.equal(res.from, 'agent');
});
