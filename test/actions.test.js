import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildContext, cardContext, runAction, extractSessionId, attachSession,
  harvestSessions, actionsForMove, namedAction, DEFAULT_ACTIONS,
} from '../src/actions.js';

const board = {
  board: { name: 'Test' },
  defaults: {},
  actions: {},
  sync: {},
  columns: [
    { id: 'inbox' },
    { id: 'agent', on_enter: [{ run: 'echo entered {{card.id}}' }] },
    { id: 'done', on_leave: ['echo left {{card.id}}'] },
  ],
};

function makeState() {
  return {
    next_id: 2,
    cards: {
      'mb-1': {
        title: 'Fix flake', type: 'pr', column: 'inbox',
        refs: { pr: 'https://github.com/o/r/pull/9', ticket: 'NP-1', slack: null },
        sessions: [{ id: 'sess-old', label: 'initial', at: '2026-07-01T00:00:00Z' }],
        flags: [], log: [], created: '2026-07-01T00:00:00Z', updated: '2026-07-01T00:00:00Z',
      },
    },
  };
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mb-act-'));
}

test('cardContext digests the card for an agent', () => {
  const state = makeState();
  const ctx = cardContext(board, 'mb-1', state.cards['mb-1'], 'do the thing');
  assert.match(ctx, /mb-1/);
  assert.match(ctx, /Fix flake/);
  assert.match(ctx, /PR: https:\/\/github.com\/o\/r\/pull\/9/);
  assert.match(ctx, /Instruction: do the thing/);
});

test('buildContext exposes latest session and refs', () => {
  const state = makeState();
  const ctx = buildContext(board, 'mb-1', state.cards['mb-1'], { message: 'hello' });
  assert.equal(ctx.card.session, 'sess-old');
  assert.equal(ctx.card.ticket, 'NP-1');
  assert.equal(ctx.message, 'hello');
});

test('runAction foreground: runs, logs, captures session from stdout', () => {
  const root = makeRoot();
  const state = makeState();
  const action = {
    run: 'echo {{message}} && echo \'{"session_id":"sess-new"}\'',
    capture_session: true,
  };
  const res = runAction(root, board, state, 'mb-1', action, { message: 'hi there' });
  assert.equal(res.ok, true);
  assert.match(res.output, /hi there/);
  const card = state.cards['mb-1'];
  assert.equal(card.sessions.at(-1).id, 'sess-new');
  assert.equal(card.log.at(-1).kind, 'session');
});

test('runAction refuses fire without a session', () => {
  const root = makeRoot();
  const state = makeState();
  state.cards['mb-1'].sessions = [];
  const res = runAction(root, board, state, 'mb-1', DEFAULT_ACTIONS.fire_comment, { message: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no Claude session/);
});

test('runAction dry-run only renders the command', () => {
  const root = makeRoot();
  const state = makeState();
  const res = runAction(root, board, state, 'mb-1', { run: 'echo {{card.id}}' }, {}, { dryRun: true });
  assert.equal(res.dryRun, true);
  assert.equal(res.cmd, "echo 'mb-1'");
  assert.equal(state.cards['mb-1'].log.length, 0);
});

test('background action + harvestSessions: sid attaches early, reply lands on finish', async () => {
  const root = makeRoot();
  const state = makeState();
  // stream-json style: init event (with session id) arrives first
  const action = { run: 'echo \'{"type":"system","subtype":"init","session_id":"sess-bg"}\'', background: true, capture_session: true };
  const res = runAction(root, board, state, 'mb-1', action, {});
  assert.equal(res.background, true);
  assert.ok(state.cards['mb-1'].pending_session_logs.length === 1);

  // give the detached child a beat to write its output
  await new Promise((r) => setTimeout(r, 300));
  const h1 = harvestSessions(root, state);
  assert.equal(h1.found, 1);
  assert.deepEqual(h1.completed, []); // sid alone isn't completion
  assert.equal(state.cards['mb-1'].sessions.at(-1).id, 'sess-bg');
  // run not finished yet — still tracked so the UI shows "agent working"
  assert.equal(state.cards['mb-1'].pending_session_logs.length, 1);

  // the final result event lands → agent reply logged, tracking cleared
  const rel = state.cards['mb-1'].pending_session_logs[0];
  fs.appendFileSync(path.join(root, rel), '\n{"type":"result","subtype":"success","result":"All done — opened PR #7.","session_id":"sess-bg"}\n');
  const h2 = harvestSessions(root, state);
  assert.equal(h2.found, 1);
  assert.deepEqual(h2.completed, ['mb-1']); // successful result → flow candidate
  assert.equal(state.cards['mb-1'].pending_session_logs, undefined);
  const lastSession = state.cards['mb-1'].log.filter((e) => e.kind === 'session').at(-1);
  assert.match(lastSession.text, /All done — opened PR #7/);
});

test('harvestSessions: quiet run times out with a visible failure entry', () => {
  const root = makeRoot();
  const state = makeState();
  fs.mkdirSync(path.join(root, '.mini-board/logs'), { recursive: true });
  const rel = `.mini-board/logs/mb-1-${Date.now() - 16 * 60_000}-agent.log`;
  fs.writeFileSync(path.join(root, rel), '# started, then nothing\n');
  state.cards['mb-1'].pending_session_logs = [rel];
  const h = harvestSessions(root, state);
  assert.equal(h.found, 1);
  assert.deepEqual(h.completed, []); // timeout is not success
  assert.equal(state.cards['mb-1'].pending_session_logs, undefined);
  assert.match(state.cards['mb-1'].log.at(-1).text, /no result after 15m/);
});

test('attachSession dedupes', () => {
  const card = { sessions: [], log: [], updated: '' };
  assert.equal(attachSession(card, 's1', 'a'), true);
  assert.equal(attachSession(card, 's1', 'b'), false);
  assert.equal(card.sessions.length, 1);
});

test('extractSessionId', () => {
  assert.equal(extractSessionId('{"type":"result","session_id":"abc-123"}'), 'abc-123');
  assert.equal(extractSessionId('{"session_id" : "x"}'), 'x');
  assert.equal(extractSessionId('nothing here'), null);
});

test('actionsForMove collects on_leave then on_enter', () => {
  const actions = actionsForMove(board, 'done', 'agent');
  assert.deepEqual(actions.map((a) => a.name), ['on_leave:done', 'on_enter:agent']);
});

test('namedAction falls back to defaults, board overrides win', () => {
  assert.match(namedAction(board, 'new_agent').run, /claude -p/);
  const custom = { ...board, actions: { new_agent: 'echo custom {{prompt}}' } };
  assert.match(namedAction(custom, 'new_agent').run, /custom/);
  assert.equal(namedAction(board, 'nope'), null);
});
