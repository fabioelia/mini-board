// `mb web` — a zero-dependency local server for the drag-and-drop board.
// State on disk stays the source of truth: every request re-reads the files,
// so the CLI and the web UI can be used side by side.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadBoard, loadState, saveState, createCard, resolveCard, moveCard,
  logEntry, getColumn,
} from './store.js';
import { computeAttention, attentionList } from './attention.js';
import { actionsForMove, namedAction, runAction, harvestSessions } from './actions.js';
import { syncAll } from './sync.js';
import { nowIso } from './util.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

function boardPayload(root) {
  const board = loadBoard(root);
  const state = loadState(root);
  if (harvestSessions(root, state) > 0) saveState(root, state);
  const cards = Object.entries(state.cards)
    .filter(([, c]) => !c.archived)
    .map(([id, card]) => ({ id, ...card, attention: computeAttention(board, card) }));
  return {
    board: {
      name: board.board?.name ?? 'mini-board',
      group_by: board.board?.group_by ?? 'none',
      columns: board.columns.map((c) => ({ id: c.id, title: c.title, attention: !!c.attention })),
    },
    cards,
    attention_count: attentionList(board, state).length,
    generated: nowIso(),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function startServer(root, port = 4400) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(WEB_DIR, 'index.html')));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        json(res, 200, boardPayload(root));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/move') {
        const { card: ref, column, actions: fire = true, comment } = await readBody(req);
        const board = loadBoard(root);
        const state = loadState(root);
        const hit = resolveCard(state, ref);
        if (!hit) return json(res, 404, { error: `no card "${ref}"` });
        if (!getColumn(board, column)) return json(res, 400, { error: `unknown column "${column}"` });
        const from = hit.card.column;
        if (comment) logEntry(hit.card, 'comment', String(comment));
        const { moved } = moveCard(board, state, hit.id, column);
        const actionResults = [];
        if (moved && fire) {
          for (const action of actionsForMove(board, from, column)) {
            const r = runAction(root, board, state, hit.id, action, { from, to: column, message: comment });
            actionResults.push({ cmd: r.cmd, ok: r.ok, background: !!r.background, error: r.error });
          }
        }
        saveState(root, state);
        json(res, 200, { ok: true, moved, actions: actionResults, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/comment') {
        const { card: ref, text, fire = false } = await readBody(req);
        if (!text?.trim()) return json(res, 400, { error: 'empty comment' });
        const board = loadBoard(root);
        const state = loadState(root);
        const hit = resolveCard(state, ref);
        if (!hit) return json(res, 404, { error: `no card "${ref}"` });
        logEntry(hit.card, 'comment', text.trim());
        let fired = null;
        if (fire) {
          const action = namedAction(board, 'fire_comment');
          const r = runAction(root, board, state, hit.id, action, { message: text.trim() });
          fired = { cmd: r.cmd, ok: r.ok, background: !!r.background, error: r.error };
        }
        saveState(root, state);
        json(res, 200, { ok: true, fired, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/agent') {
        const { card: ref, instruction } = await readBody(req);
        const board = loadBoard(root);
        const state = loadState(root);
        const hit = resolveCard(state, ref);
        if (!hit) return json(res, 404, { error: `no card "${ref}"` });
        if (instruction?.trim()) logEntry(hit.card, 'comment', `(to new agent) ${instruction.trim()}`);
        const action = namedAction(board, 'new_agent');
        const r = runAction(root, board, state, hit.id, action, { instruction: instruction?.trim() || undefined });
        saveState(root, state);
        json(res, 200, { ok: r.ok, fired: { cmd: r.cmd, ok: r.ok, background: !!r.background, error: r.error }, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/add') {
        const body = await readBody(req);
        if (!body.title?.trim()) return json(res, 400, { error: 'title required' });
        const board = loadBoard(root);
        const state = loadState(root);
        const { id } = createCard(board, state, {
          title: body.title.trim(),
          type: body.type,
          pr: body.pr || null,
          ticket: body.ticket || null,
          slack: body.slack || null,
          column: body.column || undefined,
          project: body.project || undefined,
          note: body.note || undefined,
        });
        saveState(root, state);
        json(res, 200, { ok: true, id, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const board = loadBoard(root);
        const state = loadState(root);
        let results;
        try {
          results = syncAll(board, state);
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
        saveState(root, state);
        json(res, 200, { ok: true, results, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/flag') {
        const { card: ref, reason, clear = false } = await readBody(req);
        const state = loadState(root);
        const hit = resolveCard(state, ref);
        if (!hit) return json(res, 404, { error: `no card "${ref}"` });
        if (clear) {
          hit.card.flags = [];
          logEntry(hit.card, 'flag', 'cleared flags');
        } else {
          if (!reason?.trim()) return json(res, 400, { error: 'reason required' });
          hit.card.flags ??= [];
          hit.card.flags.push({ reason: reason.trim(), at: nowIso(), source: 'manual' });
          logEntry(hit.card, 'flag', reason.trim());
        }
        saveState(root, state);
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/archive') {
        const { card: ref } = await readBody(req);
        const state = loadState(root);
        const hit = resolveCard(state, ref);
        if (!hit) return json(res, 404, { error: `no card "${ref}"` });
        hit.card.archived = true;
        logEntry(hit.card, 'archive', 'archived');
        saveState(root, state);
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`mini-board web UI → http://localhost:${port}`);
    console.log('(state stays in board.yml / state.yml — the CLI keeps working alongside)');
  });
  return server;
}
