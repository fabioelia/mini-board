// board.yml (config, human-owned) + state.yml (cards, tool-owned) live side by
// side in the board root. Everything reads/writes through here.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { nowIso } from './util.js';

export const BOARD_FILE = 'board.yml';
export const STATE_FILE = 'state.yml';
export const LOG_DIR = '.mini-board/logs';

export const CARD_TYPES = ['pr', 'ticket', 'slack', 'task'];

// Walk up from cwd until we find board.yml (like git finding .git).
export function findRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, BOARD_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadBoard(root) {
  const file = path.join(root, BOARD_FILE);
  const board = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  if (!Array.isArray(board.columns) || board.columns.length === 0) {
    throw new Error(`${file} must define a non-empty "columns" list`);
  }
  for (const col of board.columns) {
    if (!col.id) throw new Error(`every column in ${file} needs an "id"`);
    col.title ??= col.id;
  }
  board.board ??= {};
  board.defaults ??= {};
  board.actions ??= {};
  board.sync ??= {};
  return board;
}

export function getColumn(board, id) {
  return board.columns.find((c) => c.id === id) ?? null;
}

export function loadState(root) {
  const file = path.join(root, STATE_FILE);
  if (!fs.existsSync(file)) return { next_id: 1, cards: {} };
  const state = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  state.next_id ??= 1;
  state.cards ??= {};
  return state;
}

export function saveState(root, state) {
  const file = path.join(root, STATE_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, YAML.stringify(state, { lineWidth: 0 }));
  fs.renameSync(tmp, file);
}

export function logEntry(card, kind, text, extra = {}) {
  card.log ??= [];
  card.log.push({ at: nowIso(), kind, text, ...extra });
  card.updated = nowIso();
}

export function createCard(board, state, fields) {
  const id = `mb-${state.next_id++}`;
  const column = fields.column ?? board.columns[0].id;
  if (!getColumn(board, column)) throw new Error(`unknown column "${column}"`);
  const card = {
    title: fields.title,
    type: CARD_TYPES.includes(fields.type) ? fields.type : inferType(fields),
    column,
    project: fields.project ?? board.defaults.project ?? null,
    refs: {
      pr: fields.pr ?? null,
      ticket: fields.ticket ?? null,
      slack: fields.slack ?? null,
    },
    sessions: [],
    flags: [],
    archived: false,
    created: nowIso(),
    updated: nowIso(),
    log: [],
  };
  if (fields.session) {
    card.sessions.push({ id: fields.session, label: 'initial', at: nowIso() });
  }
  logEntry(card, 'create', `created in "${column}"`);
  if (fields.note) logEntry(card, 'comment', fields.note);
  state.cards[id] = card;
  return { id, card };
}

function inferType(fields) {
  if (fields.pr) return 'pr';
  if (fields.ticket) return 'ticket';
  if (fields.slack) return 'slack';
  return 'task';
}

// Resolve "mb-3", "3", or a unique case-insensitive title substring.
export function resolveCard(state, ref) {
  if (!ref) return null;
  const norm = /^\d+$/.test(ref) ? `mb-${ref}` : ref;
  if (state.cards[norm]) return { id: norm, card: state.cards[norm] };
  const needle = String(ref).toLowerCase();
  const hits = Object.entries(state.cards).filter(
    ([, c]) => !c.archived && c.title.toLowerCase().includes(needle),
  );
  if (hits.length === 1) return { id: hits[0][0], card: hits[0][1] };
  if (hits.length > 1) {
    throw new Error(
      `"${ref}" matches multiple cards: ${hits.map(([id]) => id).join(', ')} — use the id`,
    );
  }
  return null;
}

export function moveCard(board, state, id, toColumn) {
  const card = state.cards[id];
  if (!card) throw new Error(`no card ${id}`);
  const col = getColumn(board, toColumn);
  if (!col) throw new Error(`unknown column "${toColumn}"`);
  const from = card.column;
  if (from === toColumn) return { from, to: toColumn, moved: false };
  card.column = toColumn;
  logEntry(card, 'move', `${from} → ${toColumn}`, { from, to: toColumn });
  return { from, to: toColumn, moved: true };
}

export function activeCards(state) {
  return Object.entries(state.cards).filter(([, c]) => !c.archived);
}

export function latestSession(card) {
  return card.sessions?.length ? card.sessions[card.sessions.length - 1] : null;
}

export function ensureLogDir(root) {
  const dir = path.join(root, LOG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
