import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findRoot, loadBoard, loadState, saveState, createCard, resolveCard, moveCard,
} from '../src/store.js';

const BOARD = `
board: { name: Test }
columns:
  - id: inbox
  - id: doing
    title: Doing
  - id: done
`;

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-test-'));
  fs.writeFileSync(path.join(dir, 'board.yml'), BOARD);
  return dir;
}

test('findRoot walks up to board.yml', () => {
  const root = makeRoot();
  const nested = path.join(root, 'a/b');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRoot(nested), root);
  assert.equal(findRoot(os.tmpdir()), null);
});

test('loadBoard validates and defaults titles', () => {
  const root = makeRoot();
  const board = loadBoard(root);
  assert.equal(board.columns[0].title, 'inbox');
  assert.equal(board.columns[1].title, 'Doing');
});

test('create, save, reload, resolve, move', () => {
  const root = makeRoot();
  const board = loadBoard(root);
  const state = loadState(root);

  const { id, card } = createCard(board, state, { title: 'Fix auth flake', pr: '123' });
  assert.equal(id, 'mb-1');
  assert.equal(card.type, 'pr'); // inferred from pr ref
  assert.equal(card.column, 'inbox');
  saveState(root, state);

  const reloaded = loadState(root);
  assert.equal(reloaded.cards['mb-1'].title, 'Fix auth flake');
  assert.equal(reloaded.next_id, 2);

  // resolve by id, number, and unique title substring
  assert.equal(resolveCard(reloaded, 'mb-1').id, 'mb-1');
  assert.equal(resolveCard(reloaded, '1').id, 'mb-1');
  assert.equal(resolveCard(reloaded, 'auth').id, 'mb-1');
  assert.equal(resolveCard(reloaded, 'nope'), null);

  const res = moveCard(board, reloaded, 'mb-1', 'doing');
  assert.deepEqual({ from: res.from, to: res.to, moved: res.moved }, { from: 'inbox', to: 'doing', moved: true });
  assert.equal(reloaded.cards['mb-1'].column, 'doing');
  const last = reloaded.cards['mb-1'].log.at(-1);
  assert.equal(last.kind, 'move');

  // no-op move
  assert.equal(moveCard(board, reloaded, 'mb-1', 'doing').moved, false);
  // bad column throws
  assert.throws(() => moveCard(board, reloaded, 'mb-1', 'nah'), /unknown column/);
});

test('ambiguous title match throws', () => {
  const root = makeRoot();
  const board = loadBoard(root);
  const state = loadState(root);
  createCard(board, state, { title: 'fix login' });
  createCard(board, state, { title: 'fix logout' });
  assert.throws(() => resolveCard(state, 'fix'), /matches multiple/);
});

test('type inference for ticket/slack/task', () => {
  const root = makeRoot();
  const board = loadBoard(root);
  const state = loadState(root);
  assert.equal(createCard(board, state, { title: 'a', ticket: 'NP-1' }).card.type, 'ticket');
  assert.equal(createCard(board, state, { title: 'b', slack: 'https://s' }).card.type, 'slack');
  assert.equal(createCard(board, state, { title: 'c' }).card.type, 'task');
});
