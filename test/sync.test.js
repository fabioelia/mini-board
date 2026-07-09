import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrRef, summarizeChecks, syncCard, syncAll } from '../src/sync.js';

const board = {
  board: {}, defaults: { repo: 'acme/widgets' }, actions: {},
  sync: { auto_move: { pr_merged: 'merged', pr_closed: 'done' } },
  columns: [{ id: 'waiting' }, { id: 'merged' }, { id: 'done' }],
};

function makeState(pr = '42') {
  return {
    next_id: 2,
    cards: {
      'mb-1': {
        title: 'x', type: 'pr', column: 'waiting', refs: { pr },
        sessions: [], flags: [], log: [], created: '2026-07-01T00:00:00Z', updated: '2026-07-01T00:00:00Z',
      },
    },
  };
}

function fakeGh(data) {
  const calls = [];
  const exec = (args) => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify(data), stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

test('parsePrRef: url, repo#n, bare number with default repo', () => {
  assert.deepEqual(parsePrRef('https://github.com/o/r/pull/12'), { repo: 'o/r', number: '12' });
  assert.deepEqual(parsePrRef('acme/widgets#7'), { repo: 'acme/widgets', number: '7' });
  assert.deepEqual(parsePrRef('42', { repo: 'a/b' }), { repo: 'a/b', number: '42' });
  assert.deepEqual(parsePrRef('#42', { repo: 'a/b' }), { repo: 'a/b', number: '42' });
  assert.equal(parsePrRef('42', {}), null);
});

test('summarizeChecks', () => {
  assert.equal(summarizeChecks([]), 'none');
  assert.equal(summarizeChecks(undefined), 'none');
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'NEUTRAL' }]), 'passing');
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'failing');
  assert.equal(summarizeChecks([{ conclusion: '', state: 'IN_PROGRESS' }]), 'pending');
});

test('syncCard stamps pr_state and logs on change', async () => {
  const state = makeState();
  const exec = fakeGh({
    state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE',
    statusCheckRollup: [{ conclusion: 'FAILURE' }], url: 'https://github.com/acme/widgets/pull/42',
    title: 'Fix x', updatedAt: '2026-07-08T00:00:00Z',
  });
  const res = await syncCard(board, state, 'mb-1', { exec });
  assert.equal(res.changed, true);
  assert.equal(res.moved, null);
  const card = state.cards['mb-1'];
  assert.equal(card.pr_state.review, 'CHANGES_REQUESTED');
  assert.equal(card.pr_state.checks, 'failing');
  assert.equal(card.log.at(-1).kind, 'sync');
  // default repo used for bare-number ref
  assert.deepEqual(exec.calls[0].slice(0, 5), ['pr', 'view', '42', '-R', 'acme/widgets']);

  // second sync with identical data: no new log entry
  const logLen = card.log.length;
  const res2 = await syncCard(board, state, 'mb-1', { exec });
  assert.equal(res2.changed, false);
  assert.equal(card.log.length, logLen);
});

test('syncCard auto-moves on merge, and not with autoMove:false', async () => {
  const merged = fakeGh({
    state: 'MERGED', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'UNKNOWN',
    statusCheckRollup: [], url: 'u', title: 't', updatedAt: 'x',
  });
  const state = makeState();
  const res = await syncCard(board, state, 'mb-1', { exec: merged });
  assert.equal(res.moved, 'merged');
  assert.equal(state.cards['mb-1'].column, 'merged');

  const state2 = makeState();
  const res2 = await syncCard(board, state2, 'mb-1', { exec: merged, autoMove: false });
  assert.equal(res2.moved, null);
  assert.equal(state2.cards['mb-1'].column, 'waiting');
});

test('syncCard auto-moves failing-CI PRs to the remediation lane', async () => {
  const ciBoard = {
    ...board,
    sync: { auto_move: { pr_checks_failing: 'agent' } },
    columns: [...board.columns, { id: 'agent' }],
  };
  const failing = fakeGh({
    state: 'OPEN', isDraft: false, reviewDecision: '',
    statusCheckRollup: [{ conclusion: 'FAILURE' }],
  });
  const state = makeState();
  const res = await syncCard(ciBoard, state, 'mb-1', { exec: failing });
  assert.equal(res.moved, 'agent');
  assert.match(state.cards['mb-1'].log.at(-1).text, /CI failing/);
});

test('syncCard auto-moves approved open PRs, but not drafts', async () => {
  const apBoard = {
    ...board,
    sync: { auto_move: { pr_merged: 'merged', pr_approved: 'follow-up' } },
    columns: [...board.columns, { id: 'follow-up' }],
  };
  const approved = fakeGh({ state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [] });
  const state = makeState();
  const res = await syncCard(apBoard, state, 'mb-1', { exec: approved });
  assert.equal(res.moved, 'follow-up');
  assert.equal(state.cards['mb-1'].column, 'follow-up');
  assert.match(state.cards['mb-1'].log.at(-1).text, /PR approved/);

  // drafts stay put even when approved
  const draft = fakeGh({ state: 'OPEN', isDraft: true, reviewDecision: 'APPROVED', statusCheckRollup: [] });
  const state2 = makeState();
  const res2 = await syncCard(apBoard, state2, 'mb-1', { exec: draft });
  assert.equal(res2.moved, null);
  assert.equal(state2.cards['mb-1'].column, 'waiting');
});

test('syncCard surfaces gh errors without touching the card', async () => {
  const state = makeState();
  const exec = () => ({ status: 1, stdout: '', stderr: 'no pull requests found' });
  const res = await syncCard(board, state, 'mb-1', { exec });
  assert.match(res.error, /no pull requests found/);
  assert.equal(state.cards['mb-1'].pr_state, undefined);
});

test('syncAll skips archived cards and cards without PR refs', async () => {
  const state = makeState();
  state.cards['mb-2'] = { ...state.cards['mb-1'], refs: {}, archived: false };
  state.cards['mb-3'] = { ...state.cards['mb-1'], archived: true };
  const exec = fakeGh({ state: 'OPEN', statusCheckRollup: [], url: 'u', title: 't', updatedAt: 'x' });
  const results = await syncAll(board, state, { exec });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'mb-1');
});
