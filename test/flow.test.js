import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flowConfig, maxVisitsFor, guardedMove, applyFlow } from '../src/flow.js';

const board = {
  board: { name: 'Test' }, defaults: {}, actions: {}, sync: {},
  flow: { paused: 'paused', max_visits: 2 },
  columns: [
    { id: 'inbox', title: 'Inbox' },
    { id: 'agent', title: 'Agent', on_done: 'waiting-pr', on_enter: [{ name: 'fire', run: 'echo fired {{card.id}}' }] },
    { id: 'waiting-pr', title: 'Waiting on PR' },
    { id: 'paused', title: 'Paused' },
  ],
};

function makeState(column = 'agent') {
  return {
    next_id: 2,
    cards: {
      'mb-1': {
        title: 'x', type: 'task', column,
        refs: { pr: null, ticket: null, slack: null },
        sessions: [], flags: [], log: [], created: 'x', updated: 'x',
      },
    },
  };
}

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mb-flow-'));

test('flowConfig + maxVisitsFor: lane override beats board default', () => {
  assert.equal(flowConfig(board).paused, 'paused');
  assert.equal(maxVisitsFor(board, 'agent'), 2);
  const b2 = { ...board, columns: board.columns.map((c) => (c.id === 'agent' ? { ...c, max_visits: 5 } : c)) };
  assert.equal(maxVisitsFor(b2, 'agent'), 5);
});

test('applyFlow: done in lane funnels to on_done and fires the transition actions', () => {
  const state = makeState('agent');
  const moves = applyFlow(root(), board, state, ['mb-1']);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].to, 'waiting-pr');
  assert.equal(moves[0].paused, false);
  assert.equal(state.cards['mb-1'].column, 'waiting-pr');
  assert.match(state.cards['mb-1'].log.map((e) => e.text).join('\n'), /done → "waiting-pr"/);
});

test('applyFlow: chained lane fires the target on_enter (pipeline)', () => {
  // waiting-pr with on_done into agent (which has an on_enter action)
  const b2 = {
    ...board,
    columns: board.columns.map((c) => (c.id === 'waiting-pr' ? { ...c, on_done: 'agent' } : c)),
  };
  const state = makeState('waiting-pr');
  const moves = applyFlow(root(), b2, state, ['mb-1']);
  assert.equal(state.cards['mb-1'].column, 'agent');
  assert.equal(moves[0].actions.length, 1); // agent's on_enter fired
  assert.equal(moves[0].actions[0].ok, true);
});

test('guardedMove: exceeding max_visits parks the card in paused with a flag', () => {
  const state = makeState('agent');
  state.cards['mb-1'].lane_visits = { 'waiting-pr': 2 }; // already been there twice
  const res = guardedMove(board, state, 'mb-1', 'waiting-pr');
  assert.equal(res.paused, true);
  assert.equal(state.cards['mb-1'].column, 'paused');
  assert.match(state.cards['mb-1'].flags.at(-1).reason, /loop guard/);
});

test('guardedMove: no paused lane → flag in place', () => {
  const b2 = { ...board, flow: { paused: 'nope' }, columns: board.columns.filter((c) => c.id !== 'paused') };
  const state = makeState('agent');
  state.cards['mb-1'].lane_visits = { 'waiting-pr': 2 };
  const res = guardedMove(b2, state, 'mb-1', 'waiting-pr');
  assert.equal(res.paused, true);
  assert.equal(state.cards['mb-1'].column, 'agent'); // stayed
  assert.match(state.cards['mb-1'].log.at(-1).text, /flagged in place/);
});

test('applyFlow: skips cards with another run still pending, bad targets stay put', () => {
  const state = makeState('agent');
  state.cards['mb-1'].pending_session_logs = ['still-going.log'];
  assert.equal(applyFlow(root(), board, state, ['mb-1']).length, 0);
  assert.equal(state.cards['mb-1'].column, 'agent');

  const b2 = { ...board, columns: board.columns.map((c) => (c.id === 'agent' ? { ...c, on_done: 'ghost' } : c)) };
  const state2 = makeState('agent');
  assert.equal(applyFlow(root(), b2, state2, ['mb-1']).length, 0);
  assert.match(state2.cards['mb-1'].log.at(-1).text, /unknown lane "ghost"/);
});

test('lane_visits increments on every entry (via moveCard through guardedMove)', () => {
  const state = makeState('inbox');
  guardedMove(board, state, 'mb-1', 'agent');
  assert.equal(state.cards['mb-1'].lane_visits.agent, 1);
  guardedMove(board, state, 'mb-1', 'inbox');
  guardedMove(board, state, 'mb-1', 'agent');
  assert.equal(state.cards['mb-1'].lane_visits.agent, 2);
  // third entry → parked
  guardedMove(board, state, 'mb-1', 'inbox');
  const res = guardedMove(board, state, 'mb-1', 'agent');
  assert.equal(res.paused, true);
  assert.equal(state.cards['mb-1'].column, 'paused');
});
