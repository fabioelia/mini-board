import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  jiraConfig, laneForStatus, statusForLane, parseIssues, applyIssues,
  runJiraSync, harvestJiraSync, pushJiraTransition,
  reconcileLanes, applyLaneConfig, pushJiraComment, pushJiraLabel,
} from '../src/jira.js';

const board = {
  board: { name: 'Test' }, defaults: {}, actions: {}, sync: {},
  jira: { project: 'NP', push_moves: true },
  columns: [
    { id: 'inbox', title: 'Inbox' },
    { id: 'agent', title: 'Doing', jira_status: 'In Progress' },
    { id: 'review', title: 'Review', jira_status: 'In Review' },
    { id: 'done', title: 'Done', jira_status: 'Done' },
  ],
};

function makeState() {
  return {
    next_id: 2,
    cards: {
      'mb-1': {
        title: 'Existing ticket card', type: 'ticket', column: 'inbox',
        refs: { pr: null, ticket: 'NP-42', slack: null },
        sessions: [], flags: [], log: [], created: 'x', updated: 'x',
      },
    },
  };
}

test('lane mapping lives on columns, case-insensitive', () => {
  assert.equal(laneForStatus(board, 'In Review'), 'review');
  assert.equal(laneForStatus(board, 'in review'), 'review');
  assert.equal(laneForStatus(board, 'Blocked'), null);
  assert.equal(statusForLane(board, 'agent'), 'In Progress');
  assert.equal(statusForLane(board, 'inbox'), null);
  assert.equal(jiraConfig(board).enabled, true);
  assert.equal(jiraConfig({ ...board, jira: undefined }).enabled, false);
});

test('parseIssues validates and normalizes', () => {
  const good = JSON.stringify({ issues: [
    { key: 'np-7', summary: 'Do thing', status: 'In Review', url: 'https://j/NP-7', priority: 'High' },
    { key: '', summary: 'bad', status: 'X' },
  ] });
  const { issues, invalid } = parseIssues(good);
  assert.equal(invalid, false);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, 'NP-7');
  assert.equal(parseIssues('junk').invalid, true);
});

test('parseIssues: raw JSON wins even when a string value embeds a fenced block', () => {
  // the config issue's description typically carries ```yaml ... ``` — that
  // inner fence must not be mistaken for a fenced response wrapper
  const payload = JSON.stringify({
    statuses: ['To Do', 'In Progress'],
    config: 'Rules live below.\n\n```yaml\nlanes:\n  "In Progress":\n    max_visits: 2\n```\nKeep open.',
    issues: [{ key: 'NP-1', summary: 'A', status: 'To Do', url: null, priority: null }],
  });
  const res = parseIssues(payload);
  assert.equal(res.invalid, false);
  assert.equal(res.issues.length, 1);
  assert.match(res.config, /```yaml/);
  assert.deepEqual(res.statuses, ['To Do', 'In Progress']);
});

test('parseIssues: still unwraps a response fenced in markdown', () => {
  const fenced = '```json\n' + JSON.stringify({ issues: [{ key: 'NP-2', summary: 'B', status: 'To Do' }] }) + '\n```';
  const res = parseIssues(fenced);
  assert.equal(res.invalid, false);
  assert.equal(res.issues[0].key, 'NP-2');
});

test('applyIssues: creates new cards in status lane, moves existing, counts unmapped', () => {
  const state = makeState();
  const { created, moved, unmapped } = applyIssues(board, state, [
    { key: 'NP-42', summary: 'Existing ticket card', status: 'In Review', url: null, priority: null },
    { key: 'NP-99', summary: 'Brand new issue', status: 'In Progress', url: null, priority: 'High' },
    { key: 'NP-50', summary: 'Weird status', status: 'Blocked', url: null, priority: null },
  ]);
  // existing card moved to its status lane
  assert.equal(state.cards['mb-1'].column, 'review');
  assert.equal(state.cards['mb-1'].jira_status, 'In Review');
  assert.deepEqual(moved.map((m) => m.to), ['review']);
  // new issue → new card in mapped lane with origin
  assert.equal(created.length, 2);
  const fresh = Object.values(state.cards).find((c) => c.refs.ticket === 'NP-99');
  assert.equal(fresh.column, 'agent');
  assert.equal(fresh.origin.source, 'jira');
  // unmapped status lands in first lane, counted
  assert.equal(unmapped, 1);
  const weird = Object.values(state.cards).find((c) => c.refs.ticket === 'NP-50');
  assert.equal(weird.column, 'inbox');
  // re-apply is idempotent: no new cards, no moves
  const again = applyIssues(board, state, [
    { key: 'NP-42', summary: 'Existing ticket card', status: 'In Review', url: null, priority: null },
  ]);
  assert.equal(again.created.length + again.moved.length, 0);
});

test('archived cards are not resurrected by sync', () => {
  const state = makeState();
  state.cards['mb-1'].archived = true;
  const { created, moved } = applyIssues(board, state, [
    { key: 'NP-42', summary: 'x', status: 'In Review', url: null, priority: null },
  ]);
  assert.equal(created.length + moved.length, 0);
  assert.equal(state.cards['mb-1'].column, 'inbox');
});

test('runJiraSync + harvest lifecycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-jira-'));
  const state = makeState();
  assert.match(runJiraSync(root, { ...board, jira: undefined }, state).error, /no jira: block/);
  const res = runJiraSync(root, board, state);
  assert.equal(res.background, true);
  assert.match(runJiraSync(root, board, state).error, /already running/);
  assert.equal(harvestJiraSync(root, board, state), null);
  const out = JSON.stringify({
    type: 'result', subtype: 'success', session_id: 's-j',
    result: JSON.stringify({ issues: [{ key: 'NP-1', summary: 'New', status: 'In Progress' }] }),
  });
  fs.appendFileSync(path.join(root, state.pending_jira.log), `\n${out}\n`);
  const fin = harvestJiraSync(root, board, state);
  assert.equal(fin.ok, true);
  assert.equal(fin.created.length, 1);
  assert.match(state.jira.last_summary, /1 new/);
  assert.ok(state.jira.last_log);
});

function scratchBoardFile(cols) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-jira-'));
  fs.writeFileSync(path.join(root, 'board.yml'),
    `# my comment\ncolumns:\n${cols.map((c) => `  - id: ${c.id}\n    title: ${c.title}${c.jira_status ? `\n    jira_status: ${c.jira_status}` : ''}`).join('\n')}\n`);
  return root;
}

test('reconcileLanes: Jira statuses become lanes, locals preserved', () => {
  const b = { columns: [{ id: 'paused', title: 'Paused' }, { id: 'review', title: 'Review', jira_status: 'In Review' }] };
  const root = scratchBoardFile(b.columns);
  const created = reconcileLanes(root, b, ['To Do', 'In Review', 'Done']);
  assert.deepEqual(created, ['to-do', 'done']);
  assert.equal(laneForStatus(b, 'To Do'), 'to-do'); // in-memory board updated too
  const text = fs.readFileSync(path.join(root, 'board.yml'), 'utf8');
  assert.match(text, /# my comment/); // comments survive
  assert.match(text, /jira_status: To Do/);
  // idempotent
  assert.deepEqual(reconcileLanes(root, b, ['To Do', 'Done']), []);
});

test('applyLaneConfig: config parked in the Jira issue lands on lanes', () => {
  const b = {
    columns: [
      { id: 'agent', title: 'Doing', jira_status: 'In Progress' },
      { id: 'review', title: 'Review', jira_status: 'In Review' },
    ],
  };
  const root = scratchBoardFile(b.columns);
  const config = [
    'Some prose above the block.',
    '```yaml',
    'lanes:',
    '  "In Progress":',
    '    on_enter:',
    '      - name: Start Work',
    '        run: claude -p {{prompt}} --output-format stream-json --verbose',
    '        background: true',
    '    on_done: In Review',
    '    max_visits: 3',
    '```',
  ].join('\n');
  const { applied, error } = applyLaneConfig(root, b, config);
  assert.equal(error, null);
  assert.deepEqual(applied, ['agent']);
  const reloaded = fs.readFileSync(path.join(root, 'board.yml'), 'utf8');
  assert.match(reloaded, /name: Start Work/);
  assert.match(reloaded, /on_done: review/); // status name resolved to lane id
  assert.match(reloaded, /max_visits: 3/);
  assert.match(applyLaneConfig(root, b, 'not: yaml: at: all: [').error, /not valid YAML/);
});

test('pushJiraComment / pushJiraLabel respect config gates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-jira-'));
  const state = makeState();
  // gates off → nothing
  assert.equal(pushJiraComment(root, board, state, 'mb-1', 'did the thing'), null);
  assert.equal(pushJiraLabel(root, board, state, 'mb-1', 'mb-paused'), null);
  // gates on → background push + card log entry
  const on = { ...board, jira: { ...board.jira, comments: true, labels: true } };
  assert.ok(pushJiraComment(root, on, state, 'mb-1', 'did the thing').log);
  assert.match(state.cards['mb-1'].log.at(-1).text, /posting run summary to NP-42/);
  assert.ok(pushJiraLabel(root, on, state, 'mb-1', 'mb-paused').log);
  assert.match(state.cards['mb-1'].log.at(-1).text, /adding label "mb-paused"/);
  // no ticket ref → nothing even when enabled
  state.cards['mb-1'].refs.ticket = null;
  assert.equal(pushJiraComment(root, on, state, 'mb-1', 'x'), null);
});

test('pushJiraTransition fires only when mapped, needed, and enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-jira-'));
  const state = makeState();
  // unmapped lane → no push
  assert.equal(pushJiraTransition(root, board, state, 'mb-1', 'inbox'), null);
  // mapped lane → push, optimistic status stamp, log entry
  const res = pushJiraTransition(root, board, state, 'mb-1', 'review');
  assert.equal(res.pushed, 'In Review');
  assert.equal(state.cards['mb-1'].jira_status, 'In Review');
  assert.match(state.cards['mb-1'].log.at(-1).text, /pushing NP-42/);
  // already in that status → no duplicate push
  assert.equal(pushJiraTransition(root, board, state, 'mb-1', 'review'), null);
  // push disabled → nothing
  const off = { ...board, jira: { ...board.jira, push_moves: false } };
  assert.equal(pushJiraTransition(root, off, state, 'mb-1', 'done'), null);
});
