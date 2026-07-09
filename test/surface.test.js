import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  surfaceConfig, buildEnrichPrompt, parseSurface, applySurface, runEnrich, harvestEnrich,
} from '../src/surface.js';

const board = {
  board: { name: 'Test' }, defaults: {}, actions: {}, sync: {},
  columns: [{ id: 'inbox', title: 'Inbox' }],
};

function makeState() {
  return {
    next_id: 2,
    cards: {
      'mb-1': {
        title: 'Ship the thing', type: 'ticket', column: 'inbox',
        refs: { pr: null, ticket: 'NP-42', slack: null },
        sessions: [], flags: [], log: [{ at: 'x', kind: 'comment', text: 'from planning' }],
        created: 'x', updated: 'x',
      },
    },
  };
}

test('surfaceConfig defaults', () => {
  assert.deepEqual(surfaceConfig(board).tools, ['github', 'atlassian', 'slack']);
  assert.deepEqual(surfaceConfig({ ...board, surface: { tools: ['github'] } }).tools, ['github']);
});

test('buildEnrichPrompt includes card, refs, contract', () => {
  const state = makeState();
  const p = buildEnrichPrompt(board, 'mb-1', state.cards['mb-1'], 'include preview link');
  assert.match(p, /mb-1: "Ship the thing"/);
  assert.match(p, /Ticket: NP-42/);
  assert.match(p, /"summary"/);
  assert.match(p, /include preview link/);
});

test('parseSurface: validates, clamps, filters bad links', () => {
  const good = JSON.stringify({
    summary: 'PR is in review, one check failing.',
    facts: { Status: 'In review', '': '', Empty: null, Checks: '1 failing' },
    links: [
      { label: 'PR #9', url: 'https://g/pull/9' },
      { label: 'evil', url: 'javascript:alert(1)' },
    ],
    refs: { pr: 'https://g/pull/9' },
  });
  const { surface, refs, invalid } = parseSurface(good);
  assert.equal(invalid, false);
  assert.match(surface.summary, /in review/);
  assert.deepEqual(Object.keys(surface.facts), ['Status', 'Checks']);
  assert.equal(surface.links.length, 1); // javascript: dropped
  assert.equal(refs.pr, 'https://g/pull/9');
  assert.equal(parseSurface('no json here').invalid, true);
  assert.equal(parseSurface(JSON.stringify({ facts: {} })).invalid, true); // summary required
});

test('applySurface fills refs without overwriting', () => {
  const state = makeState();
  const card = state.cards['mb-1'];
  applySurface(card, {
    surface: { summary: 's', facts: {}, links: [], updated: 'now' },
    refs: { pr: 'https://g/pull/9', ticket: 'NP-999' },
  });
  assert.equal(card.refs.pr, 'https://g/pull/9');
  assert.equal(card.refs.ticket, 'NP-42'); // not overwritten
  assert.equal(card.surface.summary, 's');
});

test('runEnrich + harvestEnrich lifecycle, including invalid result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-surf-'));
  const state = makeState();
  const res = runEnrich(root, board, state, 'mb-1');
  assert.equal(res.background, true);
  assert.ok(state.cards['mb-1'].pending_enrich);
  assert.match(runEnrich(root, board, state, 'mb-1').error, /already running/);
  assert.equal(harvestEnrich(root, board, state), 0); // still running

  const out = JSON.stringify({
    type: 'result', subtype: 'success', session_id: 's-e',
    result: JSON.stringify({ summary: 'Ticket NP-42 in review; PR #9 open.', facts: { Status: 'In review' }, links: [], refs: {} }),
  });
  fs.appendFileSync(path.join(root, state.cards['mb-1'].pending_enrich.log), `\n${out}\n`);
  assert.equal(harvestEnrich(root, board, state), 1);
  const card = state.cards['mb-1'];
  assert.equal(card.pending_enrich, undefined);
  assert.match(card.surface.summary, /NP-42 in review/);
  assert.match(card.log.at(-1).text, /details refreshed/);
});

test('harvestEnrich times out quiet runs visibly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-surf-'));
  fs.mkdirSync(path.join(root, '.mini-board/logs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mini-board/logs/enrich-x.log'), 'nothing');
  const state = makeState();
  state.cards['mb-1'].pending_enrich = { log: '.mini-board/logs/enrich-x.log', started: '2026-07-08T00:00:00Z' };
  assert.equal(harvestEnrich(root, board, state), 1);
  assert.equal(state.cards['mb-1'].pending_enrich, undefined);
  assert.match(state.cards['mb-1'].log.at(-1).text, /went quiet/);
});
