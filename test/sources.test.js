import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toolAllowList, boardSources, buildPullPrompt, buildPullCommand,
  extractResultJson, parseCards, ingestCards, runPull, harvestPulls,
} from '../src/sources.js';

const board = {
  board: { name: 'Test' },
  defaults: {},
  actions: {},
  sync: {},
  columns: [{ id: 'inbox' }, { id: 'doing' }],
  sources: [
    { id: 'feedback', title: 'Slack feedback', prompt: 'Scan #user-feedback for new issues.', tools: ['slack'] },
    { id: 'prs', prompt: 'PRs assigned to me', tools: ['github'], column: 'doing', enabled: false },
  ],
};

function emptyState() {
  return { next_id: 1, cards: {} };
}

function claudeStdout(cards, extra = {}) {
  return JSON.stringify({
    type: 'result', subtype: 'success',
    result: JSON.stringify({ cards }),
    session_id: 'sess-pull-1', ...extra,
  });
}

test('toolAllowList maps aliases and passes patterns through', () => {
  assert.deepEqual(toolAllowList(['slack', 'atlassian', 'gdrive']), ['mcp__slack', 'mcp__atlassian', 'mcp__gdrive']);
  assert.deepEqual(toolAllowList(['github']), ['Bash(gh:*)']);
  assert.deepEqual(toolAllowList(['mcp__custom__thing', 'Bash(kubectl:*)']), ['mcp__custom__thing', 'Bash(kubectl:*)']);
  assert.deepEqual(toolAllowList(['sentry']), ['mcp__sentry']);
});

test('boardSources applies defaults', () => {
  const sources = boardSources(board);
  assert.equal(sources[0].column, 'inbox'); // first column default
  assert.equal(sources[0].title, 'Slack feedback');
  assert.equal(sources[1].title, 'prs'); // id fallback
  assert.equal(sources[1].enabled, false);
});

test('buildPullPrompt includes task, contract, and existing cards', () => {
  const state = emptyState();
  state.cards['mb-1'] = {
    title: 'Old issue', refs: { pr: null, ticket: 'NP-1', slack: null },
    origin: { source: 'feedback', key: 'slack-123' },
  };
  const prompt = buildPullPrompt(board, state, boardSources(board)[0]);
  assert.match(prompt, /Task: Scan #user-feedback/);
  assert.match(prompt, /"cards"/); // the JSON contract
  assert.match(prompt, /dedupe_key=slack-123/);
  assert.match(prompt, /ticket=NP-1/);
  assert.match(prompt, /ONLY a JSON object/);
});

test('buildPullCommand quotes prompt and sets allowed tools', () => {
  const cmd = buildPullCommand(boardSources(board)[0], 'the prompt');
  assert.match(cmd, /^claude -p 'the prompt' --output-format json/);
  assert.match(cmd, /--allowedTools 'mcp__slack'/);
});

test('extractResultJson finds the result line amid noise', () => {
  const noisy = ['npm warn something', claudeStdout([]), ''].join('\n');
  const obj = extractResultJson(noisy);
  assert.equal(obj.session_id, 'sess-pull-1');
  assert.equal(extractResultJson('no json here'), null);
  assert.equal(extractResultJson('{"not":"a result"}'), null);
});

test('parseCards: strict json, fenced json, junk', () => {
  const good = parseCards('{"cards":[{"title":"Fix it","type":"slack","dedupe_key":"k1"}]}');
  assert.equal(good.cards.length, 1);
  assert.equal(good.cards[0].dedupe_key, 'k1');

  const fenced = parseCards('Here you go:\n```json\n{"cards":[{"title":"A","dedupe_key":"k"}]}\n```');
  assert.equal(fenced.cards.length, 1);

  const dropped = parseCards('{"cards":[{"title":""},{"title":"ok"}]}');
  assert.equal(dropped.cards.length, 1);
  assert.equal(dropped.dropped, 1);
  assert.equal(dropped.cards[0].dedupe_key, 'ok'); // falls back to title

  assert.equal(parseCards('total garbage').invalid, true);
});

test('ingestCards dedupes by origin key and by ref', () => {
  const state = emptyState();
  const source = boardSources(board)[0];
  const items = [
    { title: 'New slack issue', type: 'slack', slack: 'https://s/p1', dedupe_key: 's1', note: 'from Sam' },
    { title: 'PR follow-up', type: 'pr', pr: 'https://g/pull/9', dedupe_key: 'p9' },
  ];
  const first = ingestCards(board, state, source, items);
  assert.equal(first.created.length, 2);
  const card = state.cards[first.created[0]];
  assert.deepEqual(card.origin, { source: 'feedback', key: 's1' });
  assert.equal(card.column, 'inbox');
  assert.equal(card.log.some((e) => e.kind === 'source'), true);

  // same keys again -> all skipped
  const again = ingestCards(board, state, source, items);
  assert.deepEqual(again, { created: [], skipped: 2 });

  // different key but same PR ref -> ref dedupe
  const refDup = ingestCards(board, state, source, [{ title: 'x', pr: 'https://g/pull/9', dedupe_key: 'other' }]);
  assert.equal(refDup.skipped, 1);

  // archived cards still block their origin key
  state.cards[first.created[0]].archived = true;
  const archivedDup = ingestCards(board, state, source, [items[0]]);
  assert.equal(archivedDup.skipped, 1);
});

test('runPull sync: executes command and ingests cards', () => {
  const state = emptyState();
  let seenCmd = null;
  const exec = (cmd) => {
    seenCmd = cmd;
    return { status: 0, stdout: claudeStdout([{ title: 'Found thing', type: 'task', dedupe_key: 'f1' }]), stderr: '' };
  };
  const res = runPull('/tmp', board, state, 'feedback', { exec });
  assert.equal(res.ok, true);
  assert.deepEqual(res.created, ['mb-1']);
  assert.match(seenCmd, /--allowedTools 'mcp__slack'/);
  assert.equal(state.sources.feedback.last_status, 'ok');
  assert.equal(state.sources.feedback.last_session, 'sess-pull-1');
});

test('runPull unknown source / claude failure', () => {
  const state = emptyState();
  assert.equal(runPull('/tmp', board, state, 'nope', {}).ok, false);
  const res = runPull('/tmp', board, state, 'feedback', {
    exec: () => ({ status: 1, stdout: '', stderr: 'not logged in' }),
  });
  assert.equal(res.ok, false);
  assert.equal(state.sources.feedback.last_status, 'error');
});

test('runPull dry-run returns the command only', () => {
  const state = emptyState();
  const res = runPull('/tmp', board, state, 'feedback', { dryRun: true });
  assert.equal(res.dryRun, true);
  assert.match(res.cmd, /^claude -p /);
  assert.equal(Object.keys(state.cards).length, 0);
});

test('background pull + harvestPulls ingests when output lands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-src-'));
  const state = emptyState();
  // use a source whose "claude" is a stub echo via a custom board
  const stubBoard = {
    ...board,
    sources: [{
      id: 'feedback', prompt: 'scan', tools: [],
      claude_args: '', // command still starts with claude; stub it on PATH? no — write log manually below
    }],
  };
  const res = runPull(root, stubBoard, state, 'feedback', { background: true });
  assert.equal(res.background, true);
  assert.equal(state.pending_pulls.length, 1);
  assert.equal(state.sources.feedback.last_status, 'running');

  // not done yet: harvest keeps it pending
  assert.deepEqual(harvestPulls(root, stubBoard, state), []);
  assert.equal(state.pending_pulls.length, 1);

  // simulate the pull finishing by appending claude's stdout to the log
  fs.appendFileSync(path.join(root, state.pending_pulls[0].log), '\n' + claudeStdout([{ title: 'BG thing', dedupe_key: 'bg1' }]) + '\n');
  const finished = harvestPulls(root, stubBoard, state);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].ok, true);
  assert.equal(state.pending_pulls, undefined);
  assert.equal(Object.values(state.cards)[0].title, 'BG thing');
});

test('harvestPulls times out stale pulls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-src-'));
  fs.mkdirSync(path.join(root, '.mini-board/logs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mini-board/logs/pull-x.log'), 'still nothing');
  const state = {
    ...emptyState(),
    pending_pulls: [{ source: 'feedback', log: '.mini-board/logs/pull-x.log', started: '2026-07-08T00:00:00Z' }],
  };
  const finished = harvestPulls(root, board, state, Date.parse('2026-07-08T01:00:00Z'));
  assert.equal(finished.length, 1);
  assert.equal(finished[0].ok, false);
  assert.equal(state.sources.feedback.last_status, 'error');
});
