// `mb web` — a zero-dependency local server for the drag-and-drop board.
// State on disk stays the source of truth: every request re-reads the files,
// so the CLI and the web UI can be used side by side.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  BOARD_FILE, LOG_DIR, loadBoard, loadState, saveState, createCard, resolveCard, moveCard,
  logEntry, getColumn,
} from './store.js';
import { computeAttention, attentionList } from './attention.js';
import { actionsForMove, namedAction, runAction, harvestSessions } from './actions.js';
import { syncAll } from './sync.js';
import { resolveConnectors, checkConnectors, verifyClaude, setupConnector } from './connectors.js';
import { boardSources, runPull, harvestPulls, parsePullActivity } from './sources.js';
import { runTriage, harvestTriage, triageConfig } from './triage.js';
import { runEnrich, harvestEnrich, surfaceConfig } from './surface.js';
import { applyFlow } from './flow.js';
import {
  runJiraSync, harvestJiraSync, jiraConfig, pushJiraTransition, pushJiraCreate,
  harvestJiraCreates, pushJiraConfig, pushSessionProgress,
} from './jira.js';
import { nowIso, parseDuration } from './util.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

function boardPayload(root) {
  const board = loadBoard(root);
  const state = loadState(root);
  const { found: sessions, completed } = harvestSessions(root, state);
  const flowMoves = applyFlow(root, board, state, completed);
  const pulls = harvestPulls(root, board, state);
  const triage = harvestTriage(root, board, state);
  const enriched = harvestEnrich(root, board, state);
  const jira = harvestJiraSync(root, board, state);
  const filed = harvestJiraCreates(root, state);
  const progress = pushSessionProgress(root, board, state);
  if (sessions || flowMoves.length || pulls.length || triage || enriched || jira || filed || progress) saveState(root, state);
  const cards = Object.entries(state.cards)
    .filter(([, c]) => !c.archived)
    .map(([id, card]) => ({ id, ...card, attention: computeAttention(board, card) }));
  const ACCENTS = ['#a8a29a', '#0d9488', '#ea580c', '#7c3aed', '#16a34a', '#1d4ed8', '#9a3412'];
  const actionSummaries = (list = []) =>
    list.map((a, i) => {
      const run = typeof a === 'string' ? a : a.run ?? '';
      const name = (typeof a === 'object' && a.name) || run.trim().split(/\s+/).slice(0, 2).join(' ');
      return {
        name, run, index: i,
        background: typeof a === 'object' && !!a.background,
        capture_session: typeof a === 'object' && !!a.capture_session,
        instruction: (typeof a === 'object' && a.instruction) || null,
      };
    });
  return {
    board: {
      name: board.board?.name ?? 'mini-board',
      group_by: board.board?.group_by ?? 'none',
      ticket_url: board.defaults?.ticket_url ?? null,
      columns: board.columns.map((c, i) => ({
        id: c.id,
        title: c.title,
        attention: !!c.attention,
        stale_after: c.stale_after ?? null,
        jira_status: c.jira_status ?? null,
        on_done: c.on_done ?? null,
        max_visits: c.max_visits ?? null,
        accent: c.accent ?? ACCENTS[i % ACCENTS.length],
        on_enter: actionSummaries(c.on_enter),
        on_leave: actionSummaries(c.on_leave),
      })),
    },
    cards,
    attention_count: attentionList(board, state).length,
    setup: setupPayload(board, state),
    sync_watch: state.sync_watch ?? null,
    sync_every: board.sync?.every ?? '5m',
    triage: { ...(state.triage ?? {}), running: !!state.pending_triage },
    triage_config: triageConfig(board),
    surface_config: surfaceConfig(board),
    jira: { ...(state.jira ?? {}), running: !!state.pending_jira },
    jira_config: jiraConfig(board),
    claude_config: { model: board.claude?.model ?? null, effort: board.claude?.effort ?? null, args: board.claude?.args ?? null },
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
      pull_started: (state.pending_pulls ?? []).find((p) => p.source === s.id)?.started ?? null,
      history: (state.sources?.[s.id]?.history ?? []).slice(0, 8),
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

// Add, replace, or move a column action (automation) in board.yml surgically,
// like saveSource. `orig` identifies the entry being edited; omitted → append.
function saveAutomation(root, { column, trigger, name, run, background, capture_session, instruction, orig }) {
  const file = path.join(root, BOARD_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const cols = doc.get('columns');
  const findCol = (id) => cols?.items?.find((c) => c?.get?.('id') === id);

  // editing an existing entry that changed column/trigger → remove the old one
  if (orig && (orig.column !== column || orig.trigger !== trigger)) {
    removeAutomation(doc, orig);
    orig = null;
  }
  const colNode = findCol(column);
  if (!colNode) throw new Error(`unknown column "${column}"`);
  const node = doc.createNode({
    ...(name ? { name } : {}),
    run,
    ...(instruction ? { instruction } : {}),
    ...(background ? { background: true } : {}),
    ...(capture_session ? { capture_session: true } : {}),
  });
  const seq = colNode.get(trigger);
  if (!seq || !seq.items) colNode.set(trigger, doc.createNode([node]));
  else if (orig && orig.index >= 0 && orig.index < seq.items.length) seq.items[orig.index] = node;
  else seq.items.push(node);
  fs.writeFileSync(file, doc.toString());
}

function removeAutomation(doc, { column, trigger, index }) {
  const cols = doc.get('columns');
  const colNode = cols?.items?.find((c) => c?.get?.('id') === column);
  const seq = colNode?.get(trigger);
  if (!seq?.items || index < 0 || index >= seq.items.length) throw new Error('automation not found');
  seq.items.splice(index, 1);
  if (!seq.items.length) colNode.delete(trigger);
}

function deleteAutomation(root, ref) {
  const file = path.join(root, BOARD_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  removeAutomation(doc, ref);
  fs.writeFileSync(file, doc.toString());
}

// Column (swim lane) management — same surgical board.yml editing as sources
// and automations, so comments survive.
function saveColumn(root, { orig_id, title, accent, attention, stale_after, on_done, max_visits, jira_status }) {
  const file = path.join(root, BOARD_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const cols = doc.get('columns');
  if (orig_id) {
    const node = cols?.items?.find((c) => c?.get?.('id') === orig_id);
    if (!node) throw new Error(`unknown column "${orig_id}"`);
    node.set('title', title);
    const setOrDelete = (key, val) => (val ? node.set(key, val) : node.has(key) && node.delete(key));
    setOrDelete('accent', accent);
    setOrDelete('stale_after', stale_after);
    setOrDelete('attention', attention || undefined);
    setOrDelete('on_done', on_done);
    setOrDelete('max_visits', max_visits || undefined);
    setOrDelete('jira_status', jira_status);
    fs.writeFileSync(file, doc.toString());
    return orig_id;
  }
  // new lane: id from the title, de-duped
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lane';
  let id = base;
  for (let n = 2; cols.items.some((c) => c?.get?.('id') === id); n++) id = `${base}-${n}`;
  cols.items.push(doc.createNode({
    id, title,
    ...(accent ? { accent } : {}),
    ...(stale_after ? { stale_after } : {}),
    ...(attention ? { attention: true } : {}),
    ...(on_done ? { on_done } : {}),
    ...(max_visits ? { max_visits } : {}),
    ...(jira_status ? { jira_status } : {}),
  }));
  fs.writeFileSync(file, doc.toString());
  return id;
}

function moveColumn(root, id, dir) {
  const file = path.join(root, BOARD_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const items = doc.get('columns').items;
  const i = items.findIndex((c) => c?.get?.('id') === id);
  if (i < 0) throw new Error(`unknown column "${id}"`);
  const j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= items.length) return; // already at the edge
  [items[i], items[j]] = [items[j], items[i]];
  fs.writeFileSync(file, doc.toString());
}

// Persist triage settings into board.yml (replaces the triage: block).
function saveTriageConfig(root, cfg) {
  const file = path.join(root, BOARD_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  doc.set('triage', doc.createNode({
    ...(cfg.enabled === false ? { enabled: false } : {}),
    columns: cfg.columns,
    tools: cfg.tools,
    ...(cfg.instruction ? { instruction: cfg.instruction } : {}),
  }));
  fs.writeFileSync(file, doc.toString());
}

function deleteColumn(root, id) {
  const file = path.join(root, BOARD_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const items = doc.get('columns').items;
  if (items.length <= 1) throw new Error('cannot delete the last lane');
  const i = items.findIndex((c) => c?.get?.('id') === id);
  if (i < 0) throw new Error(`unknown column "${id}"`);
  items.splice(i, 1);
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
  // Any board.yml mutation re-parks the FULL config on the Jira config issue
  // (debounced — a burst of edits becomes one push). The ticket is the source
  // of truth; the local file is just the working copy.
  let configPushTimer = null;
  const queueConfigPush = () => {
    const board = loadBoard(root);
    const cfg = jiraConfig(board);
    if (!cfg.enabled || !cfg.config_issue) return;
    clearTimeout(configPushTimer);
    configPushTimer = setTimeout(() => {
      try { pushJiraConfig(root, loadBoard(root)); } catch (err) { console.error(`jira config push failed: ${err.message}`); }
    }, 10_000);
    configPushTimer.unref?.();
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(WEB_DIR, 'index.html')));
        return;
      }
      // Standalone session viewer — the URL that Jira comments link to.
      // Renders the run transcript and live-polls while the run is going.
      if (req.method === 'GET' && /^\/session\/[A-Za-z0-9-]+$/.test(url.pathname)) {
        const sid = url.pathname.split('/')[2];
        const state = loadState(root);
        const hit = Object.entries(state.cards).find(([, c]) => (c.sessions ?? []).some((s) => s.id === sid));
        const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (!hit) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><body style="font-family:ui-monospace,monospace;background:#111;color:#ddd;padding:40px">no card carries session <b>${esc(sid)}</b> — it may predate the board or live in another checkout</body>`);
          return;
        }
        const [cardId, card] = hit;
        const ticketUrl = card.refs?.ticket ? `${loadBoard(root).defaults?.ticket_url ?? ''}${card.refs.ticket}` : null;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(card.title)} · session</title>
<style>
  body{font-family:ui-monospace,SFMono-Regular,monospace;background:#101014;color:#d6d6dc;margin:0;padding:28px;font-size:13px;line-height:1.5}
  h1{font-size:15px;margin:0 0 2px} .sub{color:#8a8a94;margin-bottom:18px} .sub a{color:#7dd3c8}
  .ev{padding:5px 10px;border-left:2px solid #2a2a33;margin:3px 0;white-space:pre-wrap;word-break:break-word}
  .ev.text{border-color:#0d9488;color:#e8e8ee} .ev.tool{border-color:#7c3aed;color:#b9a8e8}
  .ev.tool_result{border-color:#3a3a44;color:#8a8a94} .ev.init{border-color:#1d4ed8;color:#93b4f5}
  .ev.result{border-color:#16a34a;color:#86efac;font-weight:600} .ev.error{border-color:#b91c1c;color:#fca5a5}
  #status{position:fixed;top:14px;right:18px;color:#8a8a94}.live{color:#34d399}
</style></head><body>
<h1>${esc(card.title)}</h1>
<div class="sub">card ${esc(cardId)} · lane ${esc(card.column)} · session ${esc(sid)}${ticketUrl ? ` · <a href="${esc(ticketUrl)}">${esc(card.refs.ticket)}</a>` : ''} · <a href="/">board</a></div>
<div id="status">…</div><div id="events"></div>
<script>
  const render = (d) => {
    document.getElementById('status').innerHTML = d.running ? '<span class="live">● live</span>' : 'finished';
    document.getElementById('events').innerHTML = (d.events || []).map((e) =>
      '<div class="ev ' + e.kind + '">' + e.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>').join('');
    if (d.running) setTimeout(tick, 4000);
    else if (!(d.events || []).length) document.getElementById('events').textContent = 'no transcript found — the run log may have been cleaned up';
  };
  const tick = () => fetch('/api/session/activity?card=${encodeURIComponent(cardId)}&session=${encodeURIComponent(sid)}').then((r) => r.json()).then(render);
  tick();
</script></body></html>`);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        json(res, 200, boardPayload(root));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/run/activity') {
        const kind = url.searchParams.get('kind'); // triage | source
        const id = url.searchParams.get('id');
        const state = loadState(root);
        let logRel = null;
        let running = false;
        if (kind === 'triage') {
          running = !!state.pending_triage;
          logRel = state.pending_triage?.log ?? state.triage?.last_log ?? null;
        } else if (kind === 'jira') {
          running = !!state.pending_jira;
          logRel = state.pending_jira?.log ?? state.jira?.last_log ?? null;
        } else if (kind === 'source') {
          const pending = (state.pending_pulls ?? []).find((p) => p.source === id);
          running = !!pending;
          logRel = pending?.log ?? state.sources?.[id]?.last_log ?? null;
        }
        if (!logRel) {
          // runs from before log paths were recorded: newest matching log file
          const prefix = kind === 'triage' ? 'triage-' : kind === 'jira' ? 'jira-' : `pull-${id}-`;
          try {
            const f = fs.readdirSync(path.join(root, LOG_DIR))
              .filter((x) => x.startsWith(prefix) && !x.startsWith('jira-push-')).sort().pop();
            if (f) logRel = path.join(LOG_DIR, f);
          } catch { /* no logs dir */ }
        }
        let events = [];
        if (logRel) {
          try { events = parsePullActivity(fs.readFileSync(path.join(root, logRel), 'utf8')); }
          catch { /* log rotated away */ }
        }
        json(res, 200, { kind, id, running, log: logRel, events });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/session/activity') {
        const cardId = url.searchParams.get('card');
        const sid = url.searchParams.get('session');
        const state = loadState(root);
        const card = state.cards[cardId];
        if (!card) return json(res, 404, { error: `no card "${cardId}"` });
        // run logs are named <card>-<ts>-<label>.log; newest first, and if a
        // session id is given, pick the log that actually contains it
        const dir = path.join(root, LOG_DIR);
        let hit = null;
        try {
          const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${cardId}-`)).sort().reverse();
          for (const f of files) {
            const text = fs.readFileSync(path.join(dir, f), 'utf8');
            if (!sid || text.includes(sid)) { hit = { file: f, text }; break; }
          }
        } catch { /* no logs dir yet */ }
        const running = !!hit && (card.pending_session_logs ?? []).some((rel) => rel.endsWith(hit.file));
        json(res, 200, {
          card: cardId,
          log: hit ? path.join(LOG_DIR, hit.file) : null,
          running,
          events: hit ? parsePullActivity(hit.text) : [],
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/source/activity') {
        const id = url.searchParams.get('source');
        const state = loadState(root);
        const pending = (state.pending_pulls ?? []).find((p) => p.source === id);
        const history = state.sources?.[id]?.history ?? [];
        // live log if running, else the most recent run that kept one
        const logRel = pending?.log ?? history.find((h) => h.log)?.log;
        let events = [];
        if (logRel) {
          try { events = parsePullActivity(fs.readFileSync(path.join(root, logRel), 'utf8')); }
          catch { /* log rotated away — history alone still renders */ }
        }
        json(res, 200, { source: id, running: !!pending, started: pending?.started ?? null, events, history });
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
        // board → Jira: dragging into a status-mapped lane transitions the
        // issue — or FILES one if the card doesn't have a ticket yet (inbox
        // promotion: once it leaves inbox, it's a Jira ticket).
        const jiraPush = moved
          ? (state.cards[hit.id]?.refs?.ticket
            ? pushJiraTransition(root, board, state, hit.id, column)
            : pushJiraCreate(root, board, state, hit.id, column))
          : null;
        saveState(root, state);
        json(res, 200, { ok: true, moved, actions: actionResults, jira_push: jiraPush?.pushed ?? null, ...boardPayload(root) });
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
      if (req.method === 'POST' && url.pathname === '/api/jira/sync') {
        const board = loadBoard(root);
        const state = loadState(root);
        const result = runJiraSync(root, board, state);
        saveState(root, state);
        json(res, result.ok ? 200 : 409, { ok: result.ok, error: result.error, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/jira/config') {
        const body = await readBody(req);
        const file = path.join(root, BOARD_FILE);
        const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
        const project = String(body.project ?? '').trim();
        const jql = String(body.jql ?? '').trim();
        if (body.enabled === false) {
          if (doc.has('jira')) doc.delete('jira');
        } else {
          doc.set('jira', doc.createNode({
            ...(project ? { project } : {}),
            ...(jql ? { jql } : {}),
            push_moves: body.push_moves !== false,
            ...(body.lanes_from_jira ? { lanes_from_jira: true } : {}),
            ...(String(body.config_issue ?? '').trim() ? { config_issue: String(body.config_issue).trim().toUpperCase() } : {}),
            ...(body.comments ? { comments: true } : {}),
            ...(body.labels ? { labels: true } : {}),
            ...(body.allow_remote_actions ? { allow_remote_actions: true } : {}),
            ...(body.reconcile === false ? { reconcile: false } : {}),
            ...(String(body.board_url ?? '').trim() ? { board_url: String(body.board_url).trim().replace(/\/+$/, '') } : {}),
            ...(body.create_tickets === false ? { create_tickets: false } : {}),
            ...(String(body.instruction ?? '').trim() ? { instruction: String(body.instruction).trim() } : {}),
          }));
        }
        fs.writeFileSync(file, doc.toString());
        queueConfigPush();
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/claude/config') {
        const body = await readBody(req);
        const effort = String(body.effort ?? '').trim();
        if (effort && !['low', 'medium', 'high'].includes(effort)) {
          return json(res, 400, { error: 'effort must be low, medium, or high' });
        }
        const file = path.join(root, BOARD_FILE);
        const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
        const model = String(body.model ?? '').trim();
        const args = String(body.args ?? '').trim();
        if (!model && !effort && !args) {
          if (doc.has('claude')) doc.delete('claude');
        } else {
          doc.set('claude', doc.createNode({
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(args ? { args } : {}),
          }));
        }
        fs.writeFileSync(file, doc.toString());
        queueConfigPush();
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/surface/config') {
        const body = await readBody(req);
        const file = path.join(root, BOARD_FILE);
        const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
        doc.set('surface', doc.createNode({
          tools: (Array.isArray(body.tools) ? body.tools : []).map(String),
          ...(String(body.instruction ?? '').trim() ? { instruction: String(body.instruction).trim() } : {}),
        }));
        fs.writeFileSync(file, doc.toString());
        queueConfigPush();
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/triage/config') {
        const body = await readBody(req);
        const board = loadBoard(root);
        const columns = (Array.isArray(body.columns) ? body.columns : []).filter((c) => getColumn(board, c));
        if (!columns.length) return json(res, 400, { error: 'pick at least one lane to triage' });
        saveTriageConfig(root, {
          enabled: body.enabled !== false,
          columns,
          tools: (Array.isArray(body.tools) ? body.tools : []).map(String),
          instruction: String(body.instruction ?? '').trim() || null,
        });
        queueConfigPush();
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/triage') {
        const board = loadBoard(root);
        const state = loadState(root);
        const result = runTriage(root, board, state);
        saveState(root, state);
        json(res, result.ok ? 200 : 409, { ...result, log: undefined, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/card/enrich') {
        const { card: ref } = await readBody(req);
        const board = loadBoard(root);
        const state = loadState(root);
        const hit = resolveCard(state, ref);
        if (!hit) return json(res, 404, { error: `no card "${ref}"` });
        const result = runEnrich(root, board, state, hit.id);
        saveState(root, state);
        json(res, result.ok ? 200 : 409, { ok: result.ok, error: result.error, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/session/clear') {
        const { card: ref } = await readBody(req);
        const state = loadState(root);
        const hit = resolveCard(state, ref);
        if (!hit) return json(res, 404, { error: `no card "${ref}"` });
        const { card } = hit;
        const sessions = (card.sessions ?? []).length;
        const replies = (card.log ?? []).filter((e) => e.kind === 'session').length;
        card.sessions = [];
        delete card.pending_session_logs;
        // drop session entries (attach notices + agent replies) so the next
        // {{prompt}} isn't polluted by a bad run's context
        card.log = (card.log ?? []).filter((e) => e.kind !== 'session');
        logEntry(card, 'update', `agent context reset — cleared ${sessions} session(s), ${replies} session entr${replies === 1 ? 'y' : 'ies'}`);
        saveState(root, state);
        json(res, 200, { ok: true, ...boardPayload(root) });
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
          results = await syncAll(board, state);
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
        const statuses = await checkConnectors(board, state);
        state.connectors = { ...state.connectors, ...statuses };
        saveState(root, state);
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/connectors/verify') {
        const board = loadBoard(root);
        const state = loadState(root);
        const result = await verifyClaude();
        if (result.ok) {
          state.connectors ??= {};
          state.connectors.claude = { ...state.connectors.claude, verified: nowIso() };
          // re-probe so connected/detail reflect the successful verify
          state.connectors = { ...state.connectors, ...(await checkConnectors(board, state)) };
          saveState(root, state);
        }
        json(res, result.ok ? 200 : 502, { ok: result.ok, detail: result.detail, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/connectors/setup') {
        const { id, env } = await readBody(req);
        const board = loadBoard(root);
        const state = loadState(root);
        const result = await setupConnector(board, id, { values: env && typeof env === 'object' ? env : {} });
        if (result.ok) {
          // re-probe so the tile flips to configured/connected right away
          state.connectors = { ...state.connectors, ...(await checkConnectors(board, state)) };
          saveState(root, state);
        }
        json(res, result.ok ? 200 : 422, { ...result, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/column/save') {
        const body = await readBody(req);
        const title = String(body.title ?? '').trim();
        if (!title) return json(res, 400, { error: 'title required' });
        const stale = String(body.stale_after ?? '').trim();
        if (stale && parseDuration(stale) === null) {
          return json(res, 400, { error: 'stale_after must look like 30m, 4h, 2d, 1w' });
        }
        const boardNow = loadBoard(root);
        if (body.orig_id && !getColumn(boardNow, body.orig_id)) {
          return json(res, 400, { error: `unknown column "${body.orig_id}"` });
        }
        const onDone = String(body.on_done ?? '').trim();
        if (onDone && !getColumn(boardNow, onDone)) {
          return json(res, 400, { error: `on_done lane "${onDone}" does not exist` });
        }
        if (onDone && body.orig_id && onDone === body.orig_id) {
          return json(res, 400, { error: 'on_done cannot point at the lane itself' });
        }
        const maxVisits = body.max_visits != null && String(body.max_visits).trim() !== '' ? Number(body.max_visits) : null;
        if (maxVisits != null && (!Number.isInteger(maxVisits) || maxVisits < 1)) {
          return json(res, 400, { error: 'max_visits must be a whole number ≥ 1' });
        }
        const id = saveColumn(root, {
          orig_id: body.orig_id || null,
          title,
          accent: String(body.accent ?? '').trim() || null,
          attention: !!body.attention,
          stale_after: stale || null,
          on_done: onDone || null,
          max_visits: maxVisits,
          jira_status: String(body.jira_status ?? '').trim() || null,
        });
        queueConfigPush();
        json(res, 200, { ok: true, id, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/column/move') {
        const { id, dir } = await readBody(req);
        moveColumn(root, id, Number(dir) || 1);
        queueConfigPush();
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/column/delete') {
        const { id, move_to } = await readBody(req);
        const board = loadBoard(root);
        const state = loadState(root);
        if (!getColumn(board, id)) return json(res, 400, { error: `unknown column "${id}"` });
        const occupants = Object.entries(state.cards).filter(([, c]) => c.column === id);
        if (occupants.length) {
          if (!move_to || move_to === id || !getColumn(board, move_to)) {
            return json(res, 400, { error: `lane has ${occupants.length} card(s) — pick another lane to move them to` });
          }
          for (const [cid, card] of occupants) {
            card.column = move_to;
            card.updated = nowIso();
            logEntry(card, 'move', `moved to "${move_to}" (lane "${id}" deleted)`);
          }
          saveState(root, state);
        }
        deleteColumn(root, id);
        queueConfigPush();
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/automation/save') {
        const body = await readBody(req);
        const board = loadBoard(root);
        if (!body.run?.trim()) return json(res, 400, { error: 'run command required' });
        if (!['on_enter', 'on_leave'].includes(body.trigger)) return json(res, 400, { error: 'trigger must be on_enter or on_leave' });
        if (!getColumn(board, body.column)) return json(res, 400, { error: `unknown column "${body.column}"` });
        if (body.orig && !['on_enter', 'on_leave'].includes(body.orig.trigger)) return json(res, 400, { error: 'bad orig trigger' });
        saveAutomation(root, {
          column: body.column,
          trigger: body.trigger,
          name: String(body.name ?? '').trim() || null,
          run: body.run.trim(),
          instruction: String(body.instruction ?? '').trim() || null,
          background: !!body.background,
          capture_session: !!body.capture_session,
          orig: body.orig ? { column: body.orig.column, trigger: body.orig.trigger, index: Number(body.orig.index) } : null,
        });
        queueConfigPush();
        json(res, 200, { ok: true, ...boardPayload(root) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/automation/delete') {
        const body = await readBody(req);
        if (!['on_enter', 'on_leave'].includes(body.trigger)) return json(res, 400, { error: 'trigger must be on_enter or on_leave' });
        deleteAutomation(root, { column: body.column, trigger: body.trigger, index: Number(body.index) });
        queueConfigPush();
        json(res, 200, { ok: true, ...boardPayload(root) });
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
        queueConfigPush();
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
  startPrWatcher(root);
  return server;
}

// PR watcher: while the web server runs, poll gh on an interval and apply
// sync.auto_move rules — approved/merged/closed PRs move columns on their own.
// Configure with sync.every in board.yml ("5m", "30m", or false to disable).
function startPrWatcher(root) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const board = loadBoard(root);
      const state = loadState(root);
      if (!Object.values(state.cards).some((c) => !c.archived && c.refs?.pr)) return;
      const results = await syncAll(board, state);
      const moved = results.filter((r) => r.moved);
      state.sync_watch = {
        last_run: nowIso(),
        checked: results.filter((r) => !r.skipped).length,
        errors: results.filter((r) => r.error).length,
        moved: moved.map((r) => ({ id: r.id, to: r.moved })),
      };
      // syncAll can take a while; background-run markers written by API
      // requests in the meantime (jira sync, pulls, triage) must survive
      // this save — re-read them so a stale snapshot doesn't orphan a run.
      const fresh = loadState(root);
      for (const key of ['pending_jira', 'pending_pulls', 'pending_triage', 'pending_jira_creates']) {
        if (fresh[key] !== undefined) state[key] = fresh[key];
        else delete state[key];
      }
      saveState(root, state);
      for (const r of moved) console.log(`watch: ${r.id} auto-moved → ${r.moved}`);
    } catch (err) {
      console.error(`watch: sync failed — ${err.message}`);
    } finally {
      busy = false;
    }
  };
  const every = loadBoard(root).sync?.every;
  if (every === false || every === 'off') {
    console.log('PR watch off (sync.every: off in board.yml)');
    return;
  }
  const ms = parseDuration(every ?? '5m') ?? 5 * 60_000;
  console.log(`PR watch: checking gh every ${every ?? '5m'} (sync.every in board.yml; auto_move rules apply)`);
  setTimeout(tick, 5_000); // first pass shortly after boot
  setInterval(tick, ms).unref();
}
