// `mb web` — a zero-dependency local server for the drag-and-drop board.
// State on disk stays the source of truth: every request re-reads the files,
// so the CLI and the web UI can be used side by side.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  BOARD_FILE, loadBoard, loadState, saveState, createCard, resolveCard, moveCard,
  logEntry, getColumn,
} from './store.js';
import { computeAttention, attentionList } from './attention.js';
import { actionsForMove, namedAction, runAction, harvestSessions } from './actions.js';
import { syncAll } from './sync.js';
import { resolveConnectors, checkConnectors, verifyClaude } from './connectors.js';
import { boardSources, runPull, harvestPulls } from './sources.js';
import { nowIso } from './util.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

function boardPayload(root) {
  const board = loadBoard(root);
  const state = loadState(root);
  const sessions = harvestSessions(root, state);
  const pulls = harvestPulls(root, board, state);
  if (sessions || pulls.length) saveState(root, state);
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
    setup: setupPayload(board, state),
    generated: nowIso(),
  };
}

// Connector tiles + sources, with last-known status from state.
function setupPayload(board, state) {
  let sessionCount = 0;
  let sessionCards = 0;
  for (const card of Object.values(state.cards)) {
    if (card.sessions?.length) { sessionCount += card.sessions.length; sessionCards++; }
  }
  return {
    connectors: resolveConnectors(board).map((c) => ({
      id: c.id, kind: c.kind, title: c.title, description: c.description,
      setup: c.setup, instructions: c.instructions, needs_env: c.needs_env ?? [],
      status: state.connectors?.[c.id] ?? null,
      ...(c.id === 'claude' ? { sessions: sessionCount, session_cards: sessionCards } : {}),
    })),
    sources: boardSources(board).map((s) => ({
      ...s,
      status: state.sources?.[s.id] ?? null,
      pulling: (state.pending_pulls ?? []).some((p) => p.source === s.id),
    })),
  };
}

// Add or update a source in board.yml surgically, preserving the rest of the
// file (comments included) via the YAML document API.
function saveSource(root, def) {
  const file = path.join(root, BOARD_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const node = doc.createNode({
    id: def.id,
    title: def.title,
    prompt: def.prompt,
    tools: def.tools,
    column: def.column,
    ...(def.enabled === false ? { enabled: false } : {}),
  });
  const seq = doc.get('sources');
  if (!seq || !seq.items) {
    doc.set('sources', doc.createNode([node]));
  } else {
    const idx = seq.items.findIndex((item) => item?.get?.('id') === def.id);
    if (idx >= 0) seq.items[idx] = node;
    else seq.items.push(node);
  }
  fs.writeFileSync(file, doc.toString());
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
      if (req.method === 'POST' && url.pathname === '/api/connectors/check') {
        const board = loadBoard(root);
        const state = loadState(root);
        const statuses = checkConnectors(board, state);
        state.connectors = { ...state.connectors, ...statuses };
        saveState(root, state);
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/connectors/verify') {
        const state = loadState(root);
        const result = verifyClaude();
        if (result.ok) {
          state.connectors ??= {};
          state.connectors.claude = { ...state.connectors.claude, verified: nowIso() };
          saveState(root, state);
        }
        json(res, result.ok ? 200 : 502, { ok: result.ok, detail: result.detail, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/source/pull') {
        const { source } = await readBody(req);
        const board = loadBoard(root);
        const state = loadState(root);
        const result = runPull(root, board, state, source, { background: true });
        saveState(root, state);
        json(res, result.ok ? 200 : 400, { ...result, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/source/save') {
        const body = await readBody(req);
        const id = String(body.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
        if (!id) return json(res, 400, { error: 'source id required' });
        if (!body.prompt?.trim()) return json(res, 400, { error: 'prompt required' });
        const board = loadBoard(root);
        const column = body.column || board.columns[0].id;
        if (!getColumn(board, column)) return json(res, 400, { error: `unknown column "${column}"` });
        saveSource(root, {
          id,
          title: String(body.title ?? id).trim() || id,
          prompt: body.prompt.trim(),
          tools: Array.isArray(body.tools) ? body.tools.filter(Boolean) : [],
          column,
          enabled: body.enabled !== false,
        });
        json(res, 200, { ok: true, id, ...boardPayload(root) });
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
