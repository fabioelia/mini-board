// Triage: the board's intelligence layer. Where sync.auto_move handles the
// deterministic signals (PR merged/approved/failing → lane), triage handles
// the fuzzy ones: a Slack-sourced card whose work already has a PR open, a
// ticket that's actually in review, a card missing its refs. A Claude run
// with tools (gh, Jira/Slack MCP) inspects the candidate cards, fills in
// refs it discovers, and moves each card to the lane it truly belongs in —
// always with a stated reason, logged on the card.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureLogDir, logEntry, moveCard, getColumn } from './store.js';
import { mustStayInInbox } from './jira.js';
import { toolAllowList, extractResultJson } from './sources.js';
import { nowIso, shellQuote, claudeFlags } from './util.js';

const TRIAGE_TIMEOUT_MS = 15 * 60_000;
const MIN_CONFIDENCE = 0.6;

export function triageConfig(board) {
  const t = board.triage ?? {};
  return {
    enabled: t.enabled !== false,
    // which lanes' cards get triaged (default: lanes marked attention — the
    // triage-shaped ones — falling back to the first lane)
    columns: t.columns ?? (board.columns.filter((c) => c.attention).map((c) => c.id)),
    tools: t.tools ?? ['github', 'atlassian', 'slack'],
    instruction: t.instruction ?? '',
  };
}

export function triageCandidates(board, state) {
  const cfg = triageConfig(board);
  const cols = cfg.columns.length ? cfg.columns : [board.columns[0].id];
  return Object.entries(state.cards)
    .filter(([, c]) => !c.archived && cols.includes(c.column) && !c.pending_session_logs?.length)
    .map(([id, c]) => ({ id, card: c }));
}

export const TRIAGE_SCHEMA = `{
  "decisions": [
    {
      "card": "mb-3",
      "column": "waiting-pr",
      "refs": { "pr": "URL or null", "ticket": "key or null", "slack": "permalink or null" },
      "reason": "one line: what you found and why this lane (required)",
      "confidence": 0.9
    }
  ]
}`;

export function buildTriagePrompt(board, state, candidates, extraInstruction = '') {
  const lanes = board.columns.map((c) => {
    const bits = [`- ${c.id}: "${c.title}"`];
    if (c.attention) bits.push('(triage lane — cards here await a human)');
    const auto = (c.on_enter ?? []).map((a) => a.name ?? a.run ?? a).join('; ');
    if (auto) bits.push(`[entering runs: ${auto}]`);
    return bits.join(' ');
  });
  const cards = candidates.map(({ id, card }) => {
    const bits = [`- ${id} "${card.title}" (type=${card.type}, lane=${card.column})`];
    if (card.refs?.pr) bits.push(`pr=${card.refs.pr}`);
    if (card.refs?.ticket) bits.push(`ticket=${card.refs.ticket}`);
    if (card.refs?.slack) bits.push(`slack=${card.refs.slack}`);
    const note = (card.log ?? []).find((e) => e.kind === 'comment');
    if (note) bits.push(`note: ${note.text.slice(0, 200)}`);
    return bits.join(' · ');
  });
  return [
    `You are the triage engine for "${board.board?.name ?? 'a mini-board'}", a personal kanban board. Cards below may be sitting in the wrong lane: figure out where each one truly belongs.`,
    '',
    'Lanes (left to right = lifecycle):',
    ...lanes,
    '',
    'Cards to triage:',
    ...cards,
    '',
    'How to decide:',
    '- Investigate with your tools before deciding: does a card\'s work already have an open PR (gh CLI: search by ticket key / title keywords)? Is its ticket already in progress or done (Jira)? Is the Slack thread resolved?',
    '- When you discover a missing reference (PR URL, ticket key, Slack permalink), include it in "refs" so the board learns it.',
    '- A card whose work has an open PR belongs in the PR-appropriate lane, not the intake lane.',
    '- Only include a decision when you found real evidence; skip cards you are unsure about (omitting a card means "leave it where it is"). Do NOT guess.',
    extraInstruction ? `- Additional guidance: ${extraInstruction}` : null,
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences — exactly matching:',
    TRIAGE_SCHEMA,
    '',
    'If nothing should move, respond with {"decisions": []}.',
  ].filter((l) => l !== null).join('\n');
}

export function buildTriageCommand(board, prompt) {
  const cfg = triageConfig(board);
  let cmd = `claude -p ${shellQuote(prompt)} --output-format stream-json --verbose --permission-mode bypassPermissions`;
  const allow = toolAllowList(cfg.tools);
  if (allow.length) cmd += ` --allowedTools ${shellQuote(allow.join(','))}`;
  return cmd + claudeFlags(board, cmd);
}

export function parseDecisions(resultText) {
  let text = String(resultText ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  let obj = null;
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try { obj = JSON.parse(candidate); break; } catch { /* try next */ }
  }
  if (!obj || !Array.isArray(obj.decisions)) return { decisions: [], invalid: true };
  return { decisions: obj.decisions, invalid: false };
}

// Apply parsed decisions: fill in newly-discovered refs (never overwrite),
// move confidently-placed cards (no on_enter actions — triage repositions,
// it doesn't fire agents), and log the reason on each card.
export function applyDecisions(board, state, decisions) {
  const moved = [];
  const updated = [];
  let skipped = 0;
  for (const d of decisions) {
    const card = state.cards[d.card];
    if (!card || card.archived) { skipped++; continue; }
    if ((d.confidence ?? 1) < MIN_CONFIDENCE) { skipped++; continue; }
    let changed = false;
    for (const key of ['pr', 'ticket', 'slack']) {
      const val = d.refs?.[key];
      if (val && !card.refs?.[key]) {
        card.refs[key] = String(val);
        changed = true;
      }
    }
    const target = d.column && d.column !== card.column && getColumn(board, d.column) ? d.column : null;
    if (target && mustStayInInbox(board, card, target)) {
      logEntry(card, 'triage', `triage: ${d.reason ?? 'move'} → "${target}" — held in inbox (no Jira ticket)`);
      if (changed) updated.push(d.card); else skipped++;
      continue;
    }
    if (target) {
      moveCard(board, state, d.card, target);
      logEntry(card, 'triage', `triage: ${d.reason ?? 'moved'} → "${target}"`);
      moved.push({ id: d.card, to: target, reason: d.reason ?? null });
    } else if (changed) {
      logEntry(card, 'triage', `triage: ${d.reason ?? 'refs discovered'}`);
      updated.push(d.card);
    } else {
      skipped++;
    }
  }
  return { moved, updated, skipped };
}

function recordTriage(state, patch) {
  state.triage = { ...state.triage, ...patch };
}

function finishTriage(board, state, stdout, log = null) {
  const obj = extractResultJson(stdout);
  if (!obj) {
    recordTriage(state, { last_run: nowIso(), last_status: 'error', last_summary: 'no parseable claude output', ...(log ? { last_log: log } : {}) });
    return { ok: false, error: 'no parseable claude output' };
  }
  const { decisions, invalid } = parseDecisions(obj.result);
  if (invalid) {
    recordTriage(state, { last_run: nowIso(), last_status: 'error', last_summary: 'response was not the decisions JSON shape', ...(log ? { last_log: log } : {}) });
    return { ok: false, error: 'response was not the decisions JSON shape', tail: String(obj.result).slice(0, 400) };
  }
  const { moved, updated, skipped } = applyDecisions(board, state, decisions);
  const summary = `${moved.length} moved${updated.length ? `, ${updated.length} refs updated` : ''}${skipped ? `, ${skipped} left alone` : ''}`;
  recordTriage(state, {
    last_run: nowIso(), last_status: 'ok', last_summary: summary, last_moved: moved,
    ...(log ? { last_log: log } : {}),
    ...(obj.session_id ? { last_session: obj.session_id } : {}),
  });
  return { ok: true, moved, updated, skipped, summary, session: obj.session_id ?? null };
}

// Kick off a triage pass. Background by default (it's a tool-using Claude
// run — minutes, not seconds); harvestTriage completes it on a later poll.
export function runTriage(root, board, state, opts = {}) {
  const cfg = triageConfig(board);
  if (!cfg.enabled) return { ok: false, error: 'triage disabled (triage.enabled: false in board.yml)' };
  if (state.pending_triage) return { ok: false, error: 'a triage pass is already running' };
  const candidates = triageCandidates(board, state);
  if (!candidates.length) return { ok: true, empty: true, summary: `nothing to triage (lanes: ${cfg.columns.join(', ') || board.columns[0].id})` };

  const prompt = buildTriagePrompt(board, state, candidates, cfg.instruction);
  const cmd = buildTriageCommand(board, prompt);
  if (opts.dryRun) return { ok: true, dryRun: true, cmd, candidates: candidates.map((c) => c.id) };

  const dir = ensureLogDir(root);
  const logFile = path.join(dir, `triage-${Date.now()}.log`);
  fs.writeFileSync(logFile, `# ${nowIso()} triage (${candidates.length} candidate(s))\n`);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', fd, fd], cwd: root });
  child.unref();
  fs.closeSync(fd);
  state.pending_triage = { log: path.relative(root, logFile), started: nowIso(), candidates: candidates.length };
  recordTriage(state, { last_status: 'running' });
  return { ok: true, background: true, log: logFile, candidates: candidates.map((c) => c.id) };
}

// Complete a background triage pass once its output has landed.
export function harvestTriage(root, board, state, now = Date.now()) {
  const pending = state.pending_triage;
  if (!pending) return null;
  let text = null;
  try { text = fs.readFileSync(path.join(root, pending.log), 'utf8'); } catch { /* log gone */ }
  if (text === null) { delete state.pending_triage; return null; }
  if (extractResultJson(text)) {
    delete state.pending_triage;
    return finishTriage(board, state, text, pending.log);
  }
  if (now - Date.parse(pending.started) > TRIAGE_TIMEOUT_MS) {
    delete state.pending_triage;
    recordTriage(state, { last_run: nowIso(), last_status: 'error', last_summary: 'triage timed out or produced no output', last_log: pending.log });
    return { ok: false, error: 'triage timed out or produced no output' };
  }
  return null; // still running
}
