// Card surface: the controllable "shape" of a card's details. Deterministic
// links come straight from refs (PR URL, defaults.ticket_url + key, Slack
// permalink). The richer layer — a live summary, key facts, extra links — is
// LLM-driven: "enrich" runs Claude with tools against the card's refs and
// writes a typed `card.surface` object that the drawer renders. Config lives
// in board.yml under `surface:` (tools, extra instruction).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureLogDir, logEntry } from './store.js';
import { toolAllowList, extractResultJson } from './sources.js';
import { nowIso, shellQuote, claudeFlags } from './util.js';

const ENRICH_TIMEOUT_MS = 10 * 60_000;
const MAX_FACTS = 8;
const MAX_LINKS = 8;

export function surfaceConfig(board) {
  const s = board.surface ?? {};
  return {
    tools: s.tools ?? ['github', 'atlassian', 'slack'],
    instruction: s.instruction ?? '',
  };
}

export const SURFACE_SCHEMA = `{
  "summary": "2-3 sentences: what this item is and where it stands right now (required)",
  "facts": { "Status": "In review", "Assignee": "sam", "Checks": "2 failing" },
  "links": [ { "label": "PR #123", "url": "https://github.com/..." } ],
  "refs": { "pr": "URL or null", "ticket": "key or null", "slack": "permalink or null" }
}`;

export function buildEnrichPrompt(board, id, card, extraInstruction = '') {
  const refs = [];
  if (card.refs?.pr) refs.push(`PR: ${card.refs.pr}`);
  if (card.refs?.ticket) refs.push(`Ticket: ${card.refs.ticket}`);
  if (card.refs?.slack) refs.push(`Slack: ${card.refs.slack}`);
  const note = (card.log ?? []).find((e) => e.kind === 'comment');
  return [
    `You maintain the details surface for one card on "${board.board?.name ?? 'a mini-board'}", a personal kanban board.`,
    '',
    `Card ${id}: "${card.title}" (type=${card.type}, lane=${card.column})`,
    refs.length ? `Known refs: ${refs.join(' · ')}` : 'Known refs: none',
    note ? `Note: ${note.text.slice(0, 300)}` : null,
    '',
    'Task: fetch the CURRENT state of this work item and distill it.',
    '- Use your tools on every known ref: gh CLI for the PR (state, review, checks, last activity), Jira for the ticket (status, assignee, priority), Slack for the thread (is it resolved? what was asked?).',
    '- If a ref is missing but discoverable (a PR referencing the ticket key, a ticket named in the PR body), find it and include it under "refs".',
    '- facts: short scannable key→value pairs a human wants at a glance. Only include what you verified.',
    '- links: one per relevant destination (PR, ticket, Slack thread, CI run, preview env, design doc, …) with a human label.',
    extraInstruction ? `- Additional guidance: ${extraInstruction}` : null,
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences — exactly matching:',
    SURFACE_SCHEMA,
  ].filter((l) => l !== null).join('\n');
}

export function buildEnrichCommand(board, prompt) {
  const cfg = surfaceConfig(board);
  let cmd = `claude -p ${shellQuote(prompt)} --output-format stream-json --verbose --permission-mode bypassPermissions`;
  const allow = toolAllowList(cfg.tools);
  if (allow.length) cmd += ` --allowedTools ${shellQuote(allow.join(','))}`;
  return cmd + claudeFlags(board, cmd);
}

export function parseSurface(resultText) {
  let text = String(resultText ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  let obj = null;
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try { obj = JSON.parse(candidate); break; } catch { /* try next */ }
  }
  if (!obj || typeof obj !== 'object' || typeof obj.summary !== 'string' || !obj.summary.trim()) {
    return { surface: null, invalid: true };
  }
  const facts = {};
  for (const [k, v] of Object.entries(obj.facts ?? {}).slice(0, MAX_FACTS)) {
    if (v != null && String(v).trim()) facts[String(k).slice(0, 40)] = String(v).slice(0, 120);
  }
  const links = (Array.isArray(obj.links) ? obj.links : [])
    .filter((l) => l && typeof l.url === 'string' && /^https?:\/\//.test(l.url))
    .slice(0, MAX_LINKS)
    .map((l) => ({ label: String(l.label ?? l.url).slice(0, 60), url: l.url.slice(0, 500) }));
  return {
    surface: { summary: obj.summary.trim().slice(0, 600), facts, links, updated: nowIso() },
    refs: obj.refs && typeof obj.refs === 'object' ? obj.refs : {},
    invalid: false,
  };
}

// Apply an enrich result: set the surface, fill (never overwrite) refs.
export function applySurface(card, parsed) {
  card.surface = parsed.surface;
  for (const key of ['pr', 'ticket', 'slack']) {
    const val = parsed.refs?.[key];
    if (val && !card.refs?.[key]) card.refs[key] = String(val);
  }
}

// Kick off a background enrich for one card.
export function runEnrich(root, board, state, id, opts = {}) {
  const card = state.cards[id];
  if (!card) return { ok: false, error: `no card "${id}"` };
  if (card.pending_enrich) return { ok: false, error: 'details refresh already running for this card' };

  const cfg = surfaceConfig(board);
  const prompt = buildEnrichPrompt(board, id, card, cfg.instruction);
  const cmd = buildEnrichCommand(board, prompt);
  if (opts.dryRun) return { ok: true, dryRun: true, cmd };

  const dir = ensureLogDir(root);
  const logFile = path.join(dir, `enrich-${id}-${Date.now()}.log`);
  fs.writeFileSync(logFile, `# ${nowIso()} enrich ${id}\n`);
  const fd = fs.openSync(logFile, 'a');
  const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', fd, fd], cwd: root });
  child.unref();
  fs.closeSync(fd);
  card.pending_enrich = { log: path.relative(root, logFile), started: nowIso() };
  return { ok: true, background: true, log: logFile };
}

// Complete finished enrich runs. Returns how many cards changed.
export function harvestEnrich(root, board, state, now = Date.now()) {
  let n = 0;
  for (const [id, card] of Object.entries(state.cards)) {
    const pending = card.pending_enrich;
    if (!pending) continue;
    let text = null;
    try { text = fs.readFileSync(path.join(root, pending.log), 'utf8'); } catch { /* log gone */ }
    if (text === null) { delete card.pending_enrich; continue; }
    const result = extractResultJson(text);
    if (result) {
      delete card.pending_enrich;
      const parsed = parseSurface(result.result);
      if (parsed.invalid) {
        logEntry(card, 'update', 'details refresh failed — response was not the surface JSON shape');
      } else {
        applySurface(card, parsed);
        logEntry(card, 'update', `details refreshed: ${parsed.surface.summary.slice(0, 120)}`);
      }
      n++;
    } else if (now - Date.parse(pending.started) > ENRICH_TIMEOUT_MS) {
      delete card.pending_enrich;
      logEntry(card, 'update', `details refresh went quiet — no result after 10m (log: ${pending.log})`);
      n++;
    }
  }
  return n;
}
