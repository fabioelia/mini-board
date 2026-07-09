import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  triageConfig, triageCandidates, buildTriagePrompt, parseDecisions,
  applyDecisions, runTriage, harvestTriage,
} from '../src/triage.js';

const board = {
  board: { name: 'Test' },
  defaults: {},
  actions: {},
  sync: {},
  triage: { columns: ['inbox'], tools: ['github'] },
  columns: [
    { id: 'inbox', title: 'Inbox', attention: true },
    { id: 'agent', title: 'Agent Working', on_enter: [{ name: 'Dispatch agent', run: 'claude -p …' }] },
    { id: 'waiting-pr', title: 'Waiting on PR' },
  ],
};

function makeState() {
  return {
    next_id: 3,
    cards: {
      'mb-1': {
        title: 'Fix login flakiness', type: 'task', column: 'inbox',
        refs: { pr: null, ticket: null, slack: 'https://s/p1' },
        sessions: [], flags: [], log: [{ at: 'x', kind: 'comment', text: 'from #eng-help' }],
        created: 'x', updated: 'x',
      },
      'mb-2': {
        title: 'Already placed', type: 'pr', column: 'waiting-pr',
        refs: { pr: 'https://g/pull/2', ticket: null, slack: null },
        sessions: [], flags: [], log: [], created: 'x', updated: 'x',
      },
    },
  };
}

test('triageConfig defaults to attention lanes when columns not set', () => {
  const cfg = triageConfig({ ...board, triage: {} });
  assert.deepEqual(cfg.columns, ['inbox']);
  assert.equal(cfg.enabled, true);
});

test('triageCandidates: only triage-lane cards, skips busy/archived', () => {
  const state = makeState();
  state.cards['mb-1'].pending_session_logs = ['x.log'];
  assert.equal(triageCandidates(board, state).length, 0);
  delete state.cards['mb-1'].pending_session_logs;
  const ids = triageCandidates(board, state).map((c) => c.id);
  assert.deepEqual(ids, ['mb-1']);
});

test('buildTriagePrompt includes lanes, cards, and the contract', () => {
  const state = makeState();
  const prompt = buildTriagePrompt(board, state, triageCandidates(board, state), 'infra goes right');
  assert.match(prompt, /- inbox: "Inbox" \(triage lane/);
  assert.match(prompt, /entering runs: Dispatch agent/);
  assert.match(prompt, /mb-1 "Fix login flakiness"/);
  assert.match(prompt, /"decisions"/);
  assert.match(prompt, /infra goes right/);
});

test('parseDecisions: strict, fenced, junk', () => {
  const good = JSON.stringify({ decisions: [{ card: 'mb-1', column: 'waiting-pr', reason: 'r', confidence: 0.9 }] });
  assert.equal(parseDecisions(good).decisions.length, 1);
  assert.equal(parseDecisions('```json\n' + good + '\n```').decisions.length, 1);
  assert.equal(parseDecisions('not json').invalid, true);
});

test('applyDecisions: moves with reason, fills refs without overwriting, respects confidence', () => {
  const state = makeState();
  const { moved, updated, skipped } = applyDecisions(board, state, [
    { card: 'mb-1', column: 'waiting-pr', refs: { pr: 'https://g/pull/7', slack: 'https://s/OVERWRITE' }, reason: 'PR #7 open for this', confidence: 0.9 },
    { card: 'mb-2', column: 'inbox', reason: 'guessing', confidence: 0.3 }, // below threshold
    { card: 'mb-404', column: 'inbox', reason: 'ghost', confidence: 1 },
  ]);
  assert.deepEqual(moved, [{ id: 'mb-1', to: 'waiting-pr', reason: 'PR #7 open for this' }]);
  assert.equal(updated.length, 0);
  assert.equal(skipped, 2);
  const c = state.cards['mb-1'];
  assert.equal(c.column, 'waiting-pr');
  assert.equal(c.refs.pr, 'https://g/pull/7');
  assert.equal(c.refs.slack, 'https://s/p1'); // existing ref not overwritten
  assert.match(c.log.at(-1).text, /triage: PR #7 open/);
  assert.equal(state.cards['mb-2'].column, 'waiting-pr'); // low-confidence move ignored
});

test('runTriage + harvestTriage: background lifecycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-triage-'));
  const state = makeState();
  const res = runTriage(root, board, state);
  assert.equal(res.background, true);
  assert.ok(state.pending_triage);
  assert.equal(state.triage.last_status, 'running');
  // double-start refused
  assert.match(runTriage(root, board, state).error, /already running/);
  // not done yet
  assert.equal(harvestTriage(root, board, state), null);
  // simulate the agent finishing
  const out = JSON.stringify({
    type: 'result', subtype: 'success', session_id: 's-tri',
    result: JSON.stringify({ decisions: [{ card: 'mb-1', column: 'waiting-pr', reason: 'found PR', confidence: 1 }] }),
  });
  fs.appendFileSync(path.join(root, state.pending_triage.log), `\n${out}\n`);
  const fin = harvestTriage(root, board, state);
  assert.equal(fin.ok, true);
  assert.equal(fin.moved.length, 1);
  assert.equal(state.pending_triage, undefined);
  assert.equal(state.cards['mb-1'].column, 'waiting-pr');
  assert.match(state.triage.last_summary, /1 moved/);
});

test('runTriage: nothing to do when triage lanes are empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-triage-'));
  const state = makeState();
  state.cards['mb-1'].column = 'agent';
  const res = runTriage(root, board, state);
  assert.equal(res.empty, true);
});
