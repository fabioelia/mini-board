// Sources: configurable prompts that scan the outside world (Slack, Jira,
// GitHub, Drive, …) through Claude + MCP tools and come back as typed JSON
// cards for this board. `mb pull` runs them; the web board has a Pull button.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createCard, ensureLogDir, logEntry } from './store.js';
import { nowIso, shellQuote, claudeFlags } from './util.js';

const PULL_TIMEOUT_MS = 15 * 60_000; // background pulls older than this are marked failed

// Map friendly tool names to Claude Code --allowedTools entries. Anything
// already looking like a real tool pattern passes through untouched.
const TOOL_ALIASES = {
  slack: 'mcp__slack',
  atlassian: 'mcp__atlassian',
  jira: 'mcp__atlassian',
  gdrive: 'mcp__gdrive',
  github: 'Bash(gh:*)',
  web: 'WebSearch',
};

export function toolAllowList(tools = []) {
  return tools.map((t) => {
    if (TOOL_ALIASES[t]) return TOOL_ALIASES[t];
    if (t.includes('__') || t.includes('(')) return t;
    return `mcp__${t}`;
  });
}

export function boardSources(board) {
  return (board.sources ?? []).map((s) => ({
    id: s.id,
    title: s.title ?? s.id,
    prompt: s.prompt ?? '',
    tools: s.tools ?? [],
    column: s.column ?? board.columns[0].id,
    enabled: s.enabled !== false,
    claude_args: s.claude_args ?? '',
  }));
}

export function getSource(board, id) {
  return boardSources(board).find((s) => s.id === id) ?? null;
}

// The JSON contract a source run must come back with.
export const CARDS_SCHEMA = `{
  "cards": [
    {
      "title": "short imperative summary (required, <= 80 chars)",
      "type": "pr" | "ticket" | "slack" | "task",
      "pr": "PR URL or null",
      "ticket": "ticket key (e.g. NP-1234) or null",
      "slack": "Slack permalink or null",
      "note": "1-3 sentence summary with the key details, or null",
      "dedupe_key": "stable id for this item (slack message ts, PR URL, ticket key, ...) (required)"
    }
  ]
}`;

// Wrap the user's configured prompt with the harness: what board this is,
// what's already on it (so the model self-dedupes), and the JSON contract.
export function buildPullPrompt(board, state, source) {
  const known = [];
  for (const [id, card] of Object.entries(state.cards)) {
    const bits = [`${id} "${card.title}"`];
    if (card.origin?.source === source.id) bits.push(`dedupe_key=${card.origin.key}`);
    if (card.refs?.pr) bits.push(`pr=${card.refs.pr}`);
    if (card.refs?.ticket) bits.push(`ticket=${card.refs.ticket}`);
    if (card.refs?.slack) bits.push(`slack=${card.refs.slack}`);
    known.push(`- ${bits.join(' ')}`);
  }
  return [
    `You are a source scanner for "${board.board?.name ?? 'a mini-board'}", a personal kanban board. Your job is to turn the task below into board cards.`,
    '',
    `Task: ${source.prompt}`,
    '',
    'Cards already on the board — do NOT re-report anything matching one of these (same dedupe_key, PR, ticket, or Slack link):',
    known.length ? known.join('\n') : '(the board is empty)',
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences — exactly matching this shape:',
    CARDS_SCHEMA,
    '',
    'Rules: one card per actionable item; set every ref you can. dedupe_key must be the item\'s canonical identifier — PR URL, ticket key, Slack message ts — never a paraphrase, so re-runs produce the identical key. Only invent a key when the item truly has no identifier. If there is nothing new, respond with {"cards": []}.',
  ].join('\n');
}

export function buildPullCommand(source, prompt, board = {}) {
  // stream-json so the log fills with events AS the pull runs — the activity
  // feed reads it live; the final "result" event carries the cards JSON.
  // bypassPermissions because these runs are non-interactive: there is nobody
  // to answer a permission prompt, so MCP/tool calls would block forever.
  let cmd = `claude -p ${shellQuote(prompt)} --output-format stream-json --verbose --permission-mode bypassPermissions`;
  const allow = toolAllowList(source.tools);
  if (allow.length) cmd += ` --allowedTools ${shellQuote(allow.join(','))}`;
  if (source.claude_args) cmd += ` ${source.claude_args}`;
  return cmd + claudeFlags(board, cmd);
}

// claude -p --output-format json prints one JSON object on stdout (possibly
// after stderr noise when 2>&1 went to the same log). Find the last line that
// parses to an object with a string `result`.
export function extractResultJson(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      // plain json: the object with a string result. stream-json: the
      // "result" event (which may lack .result on execution errors — return
      // it anyway so the run fails fast instead of waiting for the timeout).
      if (obj && typeof obj === 'object' && (typeof obj.result === 'string' || obj.type === 'result')) return obj;
    } catch { /* keep scanning */ }
  }
  return null;
}

// The model was told "only JSON" but be tolerant: strip fences, or cut from
// the first "{" to the last "}".
export function parseCards(resultText) {
  let text = String(resultText ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  let obj = null;
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try { obj = JSON.parse(candidate); break; } catch { /* try next */ }
  }
  if (!obj || !Array.isArray(obj.cards)) return { cards: [], invalid: true };
  const cards = [];
  let dropped = 0;
  for (const c of obj.cards) {
    if (!c || typeof c.title !== 'string' || !c.title.trim()) { dropped++; continue; }
    cards.push({
      title: c.title.trim().slice(0, 200),
      type: ['pr', 'ticket', 'slack', 'task'].includes(c.type) ? c.type : undefined,
      pr: c.pr || null,
      ticket: c.ticket || null,
      slack: c.slack || null,
      note: c.note || null,
      dedupe_key: String(c.dedupe_key ?? c.pr ?? c.ticket ?? c.slack ?? c.title).slice(0, 300),
    });
  }
  return { cards, dropped, invalid: false };
}

// Normalize a dedupe key or ref for comparison: whitespace-collapsed,
// case-insensitive, trailing-slash-insensitive. Values are STORED as given —
// this only decides equality, so cosmetic drift between runs (case, trailing
// "/", double spaces) can't mint a duplicate card.
export function normKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').replace(/\/+$/, '').toLowerCase();
}

// Create cards from a parsed pull, skipping anything already on the board.
// Duplicate = same origin key for this source (archived included, so pulls
// never resurrect dismissed items), or any ref matching an existing card's.
export function ingestCards(board, state, source, items) {
  const created = [];
  let skipped = 0;
  const originKeys = new Set();
  const refKeys = new Set();
  const index = (card) => {
    if (card.origin?.source === source.id) originKeys.add(normKey(card.origin.key));
    for (const r of [card.refs?.pr, card.refs?.ticket, card.refs?.slack]) {
      if (r) refKeys.add(normKey(r));
    }
  };
  Object.values(state.cards).forEach(index);
  for (const item of items) {
    const dupByOrigin = originKeys.has(normKey(item.dedupe_key));
    const dupByRef = [item.pr, item.ticket, item.slack].some((r) => r && refKeys.has(normKey(r)));
    if (dupByOrigin || dupByRef) { skipped++; continue; }
    const { id, card } = createCard(board, state, {
      title: item.title,
      type: item.type,
      pr: item.pr,
      ticket: item.ticket,
      slack: item.slack,
      column: source.column,
      note: item.note ?? undefined,
    });
    card.origin = { source: source.id, key: item.dedupe_key };
    logEntry(card, 'source', `pulled by source "${source.id}"`);
    created.push(id);
    index(card); // so a second item in this same batch with the same key/ref is skipped
  }
  return { created, skipped };
}

function recordRun(state, source, patch) {
  state.sources ??= {};
  state.sources[source.id] = { ...state.sources[source.id], ...patch };
}

const HISTORY_CAP = 20;

// Prepend a finished run to the source's history (newest first, capped).
function recordHistory(state, source, entry) {
  state.sources ??= {};
  const s = (state.sources[source.id] ??= {});
  s.history = [entry, ...(s.history ?? [])].slice(0, HISTORY_CAP);
}

// Turn a stream-json pull log into a human-readable event feed for debugging:
// what session started, which tools ran with what input, what the model said,
// and how the run ended (duration/turns/cost).
export function parsePullActivity(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj.type === 'system' && obj.subtype === 'init') {
      events.push({ kind: 'init', text: `session started · ${obj.model ?? '?'} · ${(obj.tools ?? []).length} tools` });
    } else if (obj.type === 'assistant') {
      for (const block of obj.message?.content ?? []) {
        if (block.type === 'tool_use') {
          const input = JSON.stringify(block.input ?? {});
          events.push({ kind: 'tool', text: `${block.name} ${input.length > 160 ? `${input.slice(0, 160)}…` : input}` });
        } else if (block.type === 'text' && block.text?.trim()) {
          events.push({ kind: 'text', text: block.text.trim().slice(0, 240) });
        }
      }
    } else if (obj.type === 'user') {
      for (const block of obj.message?.content ?? []) {
        if (block.type === 'tool_result') {
          const size = JSON.stringify(block.content ?? '').length;
          events.push({ kind: 'tool_result', text: `↳ ${block.is_error ? 'TOOL ERROR' : 'result'} (${size} chars)` });
        }
      }
    } else if (obj.type === 'result') {
      const secs = obj.duration_ms ? `${Math.round(obj.duration_ms / 1000)}s` : '?';
      const cost = obj.total_cost_usd != null ? ` · $${Number(obj.total_cost_usd).toFixed(3)}` : '';
      events.push({ kind: 'result', text: `finished in ${secs} · ${obj.num_turns ?? '?'} turns${cost}${obj.is_error ? ' · ERROR' : ''}` });
    }
  }
  return events;
}

function finishPull(board, state, source, stdout, meta = {}) {
  const base = { started: meta.started ?? null, finished: nowIso(), log: meta.log ?? null };
  if (meta.log) recordRun(state, source, { last_log: meta.log });
  const obj = extractResultJson(stdout);
  if (!obj) {
    recordRun(state, source, { last_run: nowIso(), last_status: 'error', last_summary: 'no parseable claude output' });
    recordHistory(state, source, { ...base, status: 'error', summary: 'no parseable claude output' });
    return { source: source.id, ok: false, error: 'no parseable claude output', tail: String(stdout).slice(-400) };
  }
  const { cards, dropped, invalid } = parseCards(obj.result);
  if (invalid) {
    recordRun(state, source, { last_run: nowIso(), last_status: 'error', last_summary: 'response was not the cards JSON shape' });
    recordHistory(state, source, { ...base, status: 'error', summary: 'response was not the cards JSON shape', session: obj.session_id ?? null });
    return { source: source.id, ok: false, error: 'response was not the cards JSON shape', tail: String(obj.result).slice(0, 400) };
  }
  const { created, skipped } = ingestCards(board, state, source, cards);
  const summary = `${created.length} new card${created.length === 1 ? '' : 's'}${skipped ? `, ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped` : ''}${dropped ? `, ${dropped} invalid dropped` : ''}`;
  recordRun(state, source, {
    last_run: nowIso(), last_status: 'ok', last_summary: summary,
    ...(obj.session_id ? { last_session: obj.session_id } : {}),
  });
  recordHistory(state, source, {
    ...base, status: 'ok', summary, created: created.length, skipped,
    session: obj.session_id ?? null,
  });
  return { source: source.id, ok: true, created, skipped, dropped, summary, session: obj.session_id ?? null };
}

// Run one source. Sync by default (CLI); background for the web UI — pending
// pulls are finished later by harvestPulls, which the board poll calls.
export function runPull(root, board, state, sourceId, opts = {}) {
  const source = getSource(board, sourceId);
  if (!source) return { source: sourceId, ok: false, error: `no source "${sourceId}" in board.yml` };
  if (!source.prompt.trim()) return { source: sourceId, ok: false, error: 'source has no prompt' };
  if ((state.pending_pulls ?? []).some((p) => p.source === source.id)) {
    return { source: sourceId, ok: false, error: 'a pull for this source is already running' };
  }

  const prompt = buildPullPrompt(board, state, source);
  const cmd = buildPullCommand(source, prompt, board);
  if (opts.dryRun) return { source: sourceId, ok: true, dryRun: true, cmd };

  if (opts.background) {
    const dir = ensureLogDir(root);
    const logFile = path.join(dir, `pull-${source.id}-${Date.now()}.log`);
    fs.writeFileSync(logFile, `# ${nowIso()} pull ${source.id}\n`);
    const fd = fs.openSync(logFile, 'a');
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', fd, fd], cwd: root });
    child.unref();
    fs.closeSync(fd);
    state.pending_pulls ??= [];
    state.pending_pulls.push({ source: source.id, log: path.relative(root, logFile), started: nowIso() });
    recordRun(state, source, { last_status: 'running' });
    return { source: source.id, ok: true, background: true, log: logFile };
  }

  const started = nowIso();
  const exec = opts.exec ?? ((c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8', cwd: root, timeout: PULL_TIMEOUT_MS }));
  const res = exec(cmd);
  if (res.status !== 0 && !extractResultJson(res.stdout)) {
    recordRun(state, source, { last_run: nowIso(), last_status: 'error', last_summary: `claude exited ${res.status}` });
    recordHistory(state, source, { started, finished: nowIso(), log: null, status: 'error', summary: `claude exited ${res.status}` });
    return { source: source.id, ok: false, error: `claude exited ${res.status}`, tail: `${res.stdout ?? ''}${res.stderr ?? ''}`.slice(-400) };
  }
  return finishPull(board, state, source, res.stdout, { started });
}

// Complete any background pulls whose output has landed. Returns finished runs.
export function harvestPulls(root, board, state, now = Date.now()) {
  if (!state.pending_pulls?.length) return [];
  const finished = [];
  const remaining = [];
  for (const pending of state.pending_pulls) {
    const source = getSource(board, pending.source);
    let text = null;
    try { text = fs.readFileSync(path.join(root, pending.log), 'utf8'); } catch { /* gone */ }
    if (!source || text === null) continue; // source removed or log vanished — drop
    if (extractResultJson(text)) {
      finished.push(finishPull(board, state, source, text, { started: pending.started, log: pending.log }));
    } else if (now - Date.parse(pending.started) > PULL_TIMEOUT_MS) {
      recordRun(state, source, { last_run: nowIso(), last_status: 'error', last_summary: 'pull timed out or produced no output' });
      recordHistory(state, source, { started: pending.started, finished: nowIso(), log: pending.log, status: 'error', summary: 'pull timed out or produced no output' });
      finished.push({ source: source.id, ok: false, error: 'pull timed out or produced no output', tail: text.slice(-400) });
    } else {
      remaining.push(pending);
    }
  }
  state.pending_pulls = remaining;
  if (!remaining.length) delete state.pending_pulls;
  return finished;
}
