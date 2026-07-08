// Sources: configurable prompts that scan the outside world (Slack, Jira,
// GitHub, Drive, …) through Claude + MCP tools and come back as typed JSON
// cards for this board. `mb pull` runs them; the web board has a Pull button.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createCard, ensureLogDir, logEntry } from './store.js';
import { nowIso, shellQuote } from './util.js';

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
    'Rules: one card per actionable item; set every ref you can; dedupe_key must be stable so re-runs do not duplicate. If there is nothing new, respond with {"cards": []}.',
  ].join('\n');
}

export function buildPullCommand(source, prompt) {
  let cmd = `claude -p ${shellQuote(prompt)} --output-format json`;
  const allow = toolAllowList(source.tools);
  if (allow.length) cmd += ` --allowedTools ${shellQuote(allow.join(','))}`;
  if (source.claude_args) cmd += ` ${source.claude_args}`;
  return cmd;
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
      if (obj && typeof obj === 'object' && typeof obj.result === 'string') return obj;
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

// Create cards from a parsed pull, skipping anything already on the board.
export function ingestCards(board, state, source, items) {
  const created = [];
  let skipped = 0;
  for (const item of items) {
    const dupByOrigin = Object.values(state.cards).some(
      (c) => c.origin?.source === source.id && c.origin?.key === item.dedupe_key,
    );
    const dupByRef = Object.values(state.cards).some(
      (c) =>
        !c.archived &&
        ((item.pr && c.refs?.pr === item.pr) ||
          (item.ticket && c.refs?.ticket === item.ticket) ||
          (item.slack && c.refs?.slack === item.slack)),
    );
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
  }
  return { created, skipped };
}

function recordRun(state, source, patch) {
  state.sources ??= {};
  state.sources[source.id] = { ...state.sources[source.id], ...patch };
}

function finishPull(board, state, source, stdout) {
  const obj = extractResultJson(stdout);
  if (!obj) {
    recordRun(state, source, { last_run: nowIso(), last_status: 'error', last_summary: 'no parseable claude output' });
    return { source: source.id, ok: false, error: 'no parseable claude output', tail: String(stdout).slice(-400) };
  }
  const { cards, dropped, invalid } = parseCards(obj.result);
  if (invalid) {
    recordRun(state, source, { last_run: nowIso(), last_status: 'error', last_summary: 'response was not the cards JSON shape' });
    return { source: source.id, ok: false, error: 'response was not the cards JSON shape', tail: String(obj.result).slice(0, 400) };
  }
  const { created, skipped } = ingestCards(board, state, source, cards);
  const summary = `${created.length} new card${created.length === 1 ? '' : 's'}${skipped ? `, ${skipped} duplicate${skipped === 1 ? '' : 's'} skipped` : ''}${dropped ? `, ${dropped} invalid dropped` : ''}`;
  recordRun(state, source, {
    last_run: nowIso(), last_status: 'ok', last_summary: summary,
    ...(obj.session_id ? { last_session: obj.session_id } : {}),
  });
  return { source: source.id, ok: true, created, skipped, dropped, summary, session: obj.session_id ?? null };
}

// Run one source. Sync by default (CLI); background for the web UI — pending
// pulls are finished later by harvestPulls, which the board poll calls.
export function runPull(root, board, state, sourceId, opts = {}) {
  const source = getSource(board, sourceId);
  if (!source) return { source: sourceId, ok: false, error: `no source "${sourceId}" in board.yml` };
  if (!source.prompt.trim()) return { source: sourceId, ok: false, error: 'source has no prompt' };

  const prompt = buildPullPrompt(board, state, source);
  const cmd = buildPullCommand(source, prompt);
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

  const exec = opts.exec ?? ((c) => spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8', cwd: root, timeout: PULL_TIMEOUT_MS }));
  const res = exec(cmd);
  if (res.status !== 0 && !extractResultJson(res.stdout)) {
    recordRun(state, source, { last_run: nowIso(), last_status: 'error', last_summary: `claude exited ${res.status}` });
    return { source: source.id, ok: false, error: `claude exited ${res.status}`, tail: `${res.stdout ?? ''}${res.stderr ?? ''}`.slice(-400) };
  }
  return finishPull(board, state, source, res.stdout);
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
      finished.push(finishPull(board, state, source, text));
    } else if (now - Date.parse(pending.started) > PULL_TIMEOUT_MS) {
      recordRun(state, source, { last_run: nowIso(), last_status: 'error', last_summary: 'pull timed out or produced no output' });
      finished.push({ source: source.id, ok: false, error: 'pull timed out or produced no output', tail: text.slice(-400) });
    } else {
      remaining.push(pending);
    }
  }
  state.pending_pulls = remaining;
  if (!remaining.length) delete state.pending_pulls;
  return finished;
}
