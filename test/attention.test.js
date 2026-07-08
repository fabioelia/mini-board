import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAttention, attentionList } from '../src/attention.js';

const board = {
  board: {},
  defaults: {},
  actions: {},
  sync: { auto_move: { pr_merged: 'merged', pr_closed: 'done' } },
  columns: [
    { id: 'inbox', title: 'Inbox', attention: true },
    { id: 'agent', title: 'Agent', stale_after: '4h' },
    { id: 'waiting', title: 'Waiting' },
    { id: 'merged', title: 'Merged' },
    { id: 'done', title: 'Done' },
  ],
};

const NOW = Date.parse('2026-07-08T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

function card(overrides = {}) {
  return { title: 't', type: 'task', column: 'waiting', flags: [], updated: hoursAgo(0), ...overrides };
}

test('attention column always flags', () => {
  const reasons = computeAttention(board, card({ column: 'inbox' }), NOW);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0].reason, /triage/);
});

test('stale_after fires only past the limit', () => {
  assert.equal(computeAttention(board, card({ column: 'agent', updated: hoursAgo(2) }), NOW).length, 0);
  const stale = computeAttention(board, card({ column: 'agent', updated: hoursAgo(6) }), NOW);
  assert.equal(stale.length, 1);
  assert.match(stale[0].reason, /stale/);
});

test('manual flags surface', () => {
  const reasons = computeAttention(board, card({ flags: [{ reason: 'ping QA', source: 'manual' }] }), NOW);
  assert.deepEqual(reasons.map((r) => r.reason), ['ping QA']);
});

test('pr: changes requested + failing ci + conflict', () => {
  const reasons = computeAttention(
    board,
    card({ pr_state: { state: 'OPEN', review: 'CHANGES_REQUESTED', checks: 'failing', mergeable: 'CONFLICTING' } }),
    NOW,
  );
  assert.equal(reasons.length, 3);
  const text = reasons.map((r) => r.reason).join(' | ');
  assert.match(text, /changes requested/);
  assert.match(text, /CI failing/);
  assert.match(text, /merge conflict/);
});

test('pr approved and green => ready to merge', () => {
  const reasons = computeAttention(
    board,
    card({ pr_state: { state: 'OPEN', review: 'APPROVED', checks: 'passing', mergeable: 'MERGEABLE' } }),
    NOW,
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0].reason, /ready to merge/);
});

test('pr merged: quiet in the auto_move target, loud elsewhere', () => {
  const merged = { state: 'MERGED', review: 'APPROVED', checks: 'passing' };
  assert.equal(computeAttention(board, card({ column: 'merged', pr_state: merged }), NOW).length, 0);
  const loud = computeAttention(board, card({ column: 'waiting', pr_state: merged }), NOW);
  assert.equal(loud.length, 1);
  assert.match(loud[0].reason, /merged/);
});

test('attentionList sorts and filters', () => {
  const state = {
    cards: {
      'mb-1': card({ column: 'waiting' }), // quiet
      'mb-2': card({ column: 'inbox', updated: hoursAgo(1) }), // 1 reason
      'mb-3': card({
        column: 'agent',
        updated: hoursAgo(10),
        pr_state: { state: 'OPEN', review: 'NONE', checks: 'failing' },
      }), // 2 reasons
      'mb-4': { ...card({ column: 'inbox' }), archived: true }, // hidden
    },
  };
  const list = attentionList(board, state, NOW);
  assert.deepEqual(list.map((e) => e.id), ['mb-3', 'mb-2']);
});
