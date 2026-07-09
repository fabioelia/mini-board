// Jira mirror: makes Jira the source of truth for lanes and tickets.
//
// THE SPOT where board/swimlane state logic lives:
//   1. Each lane declares its Jira meaning right on the column:
//        - id: review
//          jira_status: "In Review"   # this lane IS that Jira status
//   2. The `jira:` block in board.yml owns the mirror itself:
//        jira:
//          project: NP
//          jql: assignee = currentUser() AND statusCategory != Done
//          push_moves: true           # dragging a card transitions the issue
//
// Sync pulls issues (via Claude + the Atlassian MCP, same pattern as
// sources/triage), upserts them as cards, and moves each card to the lane
// mapped to its Jira status. With push_moves, a board drag fires a
// background transition so Jira follows the board too.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { BOARD_FILE, ensureLogDir, loadBoard, logEntry, moveCard, getColumn, createCard, latestSession } from './store.js';
import { extractResultJson, normKey } from './sources.js';
import { nowIso, shellQuote, claudeFlags } from './util.js';

const JIRA_TIMEOUT_MS = 15 * 60_000;

// MB_NO_SPAWN=1 skips launching claude while keeping logs/state identical —
// the test suite sets it so runs never touch the real Jira.
const noSpawn = () => process.env.MB_NO_SPAWN === '1';

export function jiraConfig(board) {
  const j = board.jira ?? {};
  return {
    enabled: !!board.jira,
    project: j.project ?? null,
    jql: j.jql ?? 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    push_moves: j.push_moves !== false,
    lanes_from_jira: !!j.lanes_from_jira, // workflow statuses become lanes
    config_issue: j.config_issue ?? null, // lane automation config parks in this issue's description
    allow_remote_actions: !!j.allow_remote_actions, // config issue may set on_enter/on_leave (runs shell commands — opt in!)
    comments: !!j.comments, // agent run summaries land as issue comments
    labels: !!j.labels, // paused cards get the mb-paused label
    reconcile: j.reconcile !== false, // cards whose issue leaves the JQL scope get archived
    create_tickets: j.create_tickets !== false, // promoting a ticketless card out of inbox files a Jira issue
    board_url: j.board_url ?? 'http://localhost:4400', // base for session-viewer links in comments
    instruction: j.instruction ?? '',
  };
}

// lane <-> status mapping lives ON the lanes (column.jira_status)
export function laneForStatus(board, status) {
  const norm = normKey(status);
  return board.columns.find((c) => c.jira_status && normKey(c.jira_status) === norm)?.id ?? null;
}

export function statusForLane(board, laneId) {
  return getColumn(board, laneId)?.jira_status ?? null;
}

export const JIRA_SCHEMA = `{
  "statuses": ["To Do", "In Progress", "In Review", "Done"],
  "config": "raw text of the config issue's description, or null",
  "issues": [
    {
      "key": "NP-123 (required)",
      "summary": "issue summary (required)",
      "status": "exact Jira status name, e.g. In Review (required)",
      "url": "browse URL or null",
      "priority": "priority name or null"
    }
  ]
}`;

export function buildJiraSyncPrompt(board, cfg) {
  const mapped = board.columns.filter((c) => c.jira_status)
    .map((c) => `- "${c.jira_status}" ↔ lane ${c.id}`);
  return [
    `You mirror Jira into "${board.board?.name ?? 'a mini-board'}", a personal kanban board. Jira is the source of truth.`,
    '',
    'Using the Atlassian tools:',
    `1. Fetch the CURRENT issues matching this JQL${cfg.project ? ` (project ${cfg.project})` : ''}:`,
    `     ${cfg.jql}`,
    cfg.lanes_from_jira
      ? `2. Report "statuses": the project's workflow statuses in lifecycle order (the board's columns mirror them). Derive the order from the project's board/workflow, or from the statuses seen on issues.`
      : null,
    cfg.config_issue
      ? `3. Fetch issue ${cfg.config_issue} and report its FULL description verbatim as "config" (it holds the board's lane configuration).`
      : null,
    '',
    'Known lane mapping (status names must match Jira exactly):',
    mapped.length ? mapped.join('\n') : '(no lanes mapped yet — still report the true status names)',
    cfg.instruction ? `Additional guidance: ${cfg.instruction}` : null,
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences — exactly matching:',
    JIRA_SCHEMA,
    'Omit "statuses"/"config" only if not requested above.',
  ].filter((l) => l !== null).join('\n');
}

export function buildJiraSyncCommand(board, prompt) {
  let cmd = `claude -p ${shellQuote(prompt)} --output-format stream-json --verbose --permission-mode bypassPermissions`;
  cmd += ` --allowedTools ${shellQuote('mcp__atlassian')}`;
  return cmd + claudeFlags(board, cmd);
}

export function parseIssues(resultText) {
  const text = String(resultText ?? '').trim();
  // Raw text first: a fence INSIDE a JSON string (e.g. a ```yaml block in the
  // config issue's description) must not be mistaken for a fenced response.
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [text];
  if (fence) candidates.push(fence[1].trim());
  candidates.push(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  let obj = null;
  for (const candidate of candidates) {
    try { obj = JSON.parse(candidate); break; } catch { /* try next */ }
  }
  if (!obj || !Array.isArray(obj.issues)) return { issues: [], statuses: [], config: null, invalid: true };
  const issues = obj.issues
    .filter((i) => i && typeof i.key === 'string' && i.key.trim() && typeof i.status === 'string')
    .map((i) => ({
      key: i.key.trim().toUpperCase(),
      summary: String(i.summary ?? i.key).slice(0, 200),
      status: String(i.status).trim(),
      url: typeof i.url === 'string' && /^https?:/.test(i.url) ? i.url : null,
      priority: i.priority ? String(i.priority).slice(0, 40) : null,
    }));
  const statuses = (Array.isArray(obj.statuses) ? obj.statuses : [])
    .filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
  const config = typeof obj.config === 'string' && obj.config.trim() ? obj.config : null;
  return { issues, statuses, config, invalid: false };
}

// Jira → lanes: every workflow status gets a lane. Missing lanes are appended
// to board.yml (surgically) with jira_status set; existing lanes are never
// deleted or reordered here — local-only lanes (e.g. paused) stay yours.
export function reconcileLanes(root, board, statuses) {
  const missing = statuses.filter((s) => !laneForStatus(board, s));
  if (!missing.length) return [];
  const file = path.join(root, BOARD_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const cols = doc.get('columns');
  const created = [];
  for (const status of missing) {
    const base = status.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lane';
    let id = base;
    for (let n = 2; cols.items.some((c) => c?.get?.('id') === id); n++) id = `${base}-${n}`;
    cols.items.push(doc.createNode({ id, title: status, jira_status: status }));
    board.columns.push({ id, title: status, jira_status: status }); // keep in-memory board usable
    created.push(id);
  }
  fs.writeFileSync(file, doc.toString());
  return created;
}

// The config issue's description carries a fenced YAML block. Two shapes:
//   - FULL board config (has "columns:"): the entire board.yml minus the
//     local jira: pointer — lanes, automations, sources, flow, everything.
//     This is what pushJiraConfig writes; applying it restores the whole
//     board experience on any machine pointing at the same issue.
//   - legacy "lanes:" map keyed by status name (applyLaneConfig below).
export function parseConfigYaml(configText) {
  let text = String(configText ?? '');
  const fence = /```(?:yaml|yml)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1];
  try { return YAML.parse(text); } catch { return null; }
}

// board.yml minus the jira: block — the jira pointer (project/config_issue)
// is the per-machine bootstrap and must not round-trip through the ticket.
export function serializeBoardConfig(root) {
  const doc = YAML.parseDocument(fs.readFileSync(path.join(root, BOARD_FILE), 'utf8'));
  if (doc.has('jira')) doc.delete('jira');
  return doc.toString();
}

// Board → ticket: park the FULL board config on the config issue. Called
// (debounced) whenever board.yml changes, so the ticket always mirrors the
// board and `mb adopt` elsewhere restores the same experience.
export function pushJiraConfig(root, board) {
  const cfg = jiraConfig(board);
  if (!cfg.enabled || !cfg.config_issue) return null;
  const body = [
    'This issue\'s description is the **source of truth for the mini-board configuration** — lanes, automations, sources, flow. mini-board rewrites it whenever the board changes and restores from it on sync (`jira.config_issue` in board.yml).',
    '',
    '⚠️ The YAML below contains **shell commands** (`on_enter`/`on_leave`/`actions`) that run on the machine hosting the board when `allow_remote_actions` is enabled there. Treat edit rights on this issue accordingly.',
    '',
    '```yaml',
    serializeBoardConfig(root).trimEnd(),
    '```',
    '',
    'Managed by mini-board — edits here apply to the board on its next Jira sync. Keep this issue open.',
  ].join('\n');
  const prompt = `Using the Atlassian tools, replace the ENTIRE description of Jira issue ${cfg.config_issue} with EXACTLY the following content, verbatim (preserve the fenced code block as-is):\n\n${body}\n\nReply with one line confirming.`;
  const log = spawnJiraWrite(root, board, 'config', prompt);
  return { log };
}

// Ticket → board: full restore. Rewrites board.yml from the parked config,
// keeping only the local jira: pointer. Without allow_remote_actions, the
// executable surface (lane automations, named actions, source prompts) is
// stripped — a hostile ticket edit must not become shell on this machine.
export function applyFullBoardConfig(root, board, parsed, allowActions = false) {
  if (!parsed || !Array.isArray(parsed.columns) || !parsed.columns.length) {
    return { applied: [], error: 'full config has no columns', stripped: false };
  }
  const clean = JSON.parse(JSON.stringify(parsed));
  let stripped = false;
  if (!allowActions) {
    for (const c of clean.columns) {
      if (c && (c.on_enter || c.on_leave)) { delete c.on_enter; delete c.on_leave; stripped = true; }
    }
    if (clean.actions) { delete clean.actions; stripped = true; }
    if (clean.sources) { delete clean.sources; stripped = true; }
  }
  const file = path.join(root, BOARD_FILE);
  const prev = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const next = YAML.parseDocument(YAML.stringify(clean));
  if (prev.has('jira')) next.set('jira', JSON.parse(JSON.stringify(prev.get('jira')?.toJSON?.() ?? prev.get('jira'))));
  fs.writeFileSync(file, next.toString());
  Object.assign(board, loadBoard(root)); // callers keep using the restored board
  return { applied: clean.columns.map((c) => c?.id).filter(Boolean), error: null, stripped };
}

// Lane config parked in Jira: the config issue's description carries a YAML
// block keyed by status name; sync applies it onto the mapped lanes.
//   lanes:
//     "In Progress":
//       instruction: Start working on the ticket, file a PR when ready
//       on_enter: [{ name: Start Work, run: claude -p {{prompt}} …, background: true }]
//       on_done: In Review          # a STATUS name — resolved to its lane
//       max_visits: 2
export function applyLaneConfig(root, board, configText, allowActions = false) {
  let text = String(configText ?? '');
  const fence = /```(?:yaml|yml)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1];
  let parsed = null;
  try { parsed = YAML.parse(text); } catch { return { applied: [], error: 'config issue description is not valid YAML' }; }
  const lanes = parsed?.lanes;
  if (!lanes || typeof lanes !== 'object') return { applied: [], error: 'config has no "lanes:" map' };

  const file = path.join(root, BOARD_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  const cols = doc.get('columns');
  const applied = [];
  for (const [status, def] of Object.entries(lanes)) {
    if (!def || typeof def !== 'object') continue;
    const laneId = laneForStatus(board, status);
    const node = laneId && cols?.items?.find((c) => c?.get?.('id') === laneId);
    if (!node) continue;
    const setOrDelete = (key, val) => (val != null ? node.set(key, doc.createNode(val)) : node.has(key) && node.delete(key));
    // on_enter/on_leave run SHELL COMMANDS on this machine. Applying them from
    // a Jira description means anyone with edit rights on that issue can run
    // code here — so they're ignored unless jira.allow_remote_actions is set.
    if (allowActions) {
      if ('on_enter' in def) setOrDelete('on_enter', Array.isArray(def.on_enter) && def.on_enter.length ? def.on_enter : null);
      if ('on_leave' in def) setOrDelete('on_leave', Array.isArray(def.on_leave) && def.on_leave.length ? def.on_leave : null);
    }
    if ('on_done' in def) setOrDelete('on_done', def.on_done ? (laneForStatus(board, def.on_done) ?? null) : null);
    if ('max_visits' in def) setOrDelete('max_visits', Number.isInteger(def.max_visits) ? def.max_visits : null);
    if ('instruction' in def && Array.isArray(def.on_enter)) { /* instruction rides inside on_enter entries */ }
    if ('stale_after' in def) setOrDelete('stale_after', def.stale_after || null);
    if ('attention' in def) setOrDelete('attention', def.attention || null);
    applied.push(laneId);
  }
  if (applied.length) fs.writeFileSync(file, doc.toString());
  return { applied, error: null };
}

// Upsert issues as cards and align lanes to Jira statuses. Jira wins: a
// mirrored card sitting in the wrong lane is moved (loop guard deliberately
// NOT applied — the source of truth is allowed to reposition freely).
export function applyIssues(board, state, issues, reconcile = true) {
  const created = [];
  const moved = [];
  let unmapped = 0;
  const byTicket = new Map();
  for (const [id, card] of Object.entries(state.cards)) {
    if (card.refs?.ticket) byTicket.set(normKey(card.refs.ticket), { id, card });
  }
  for (const issue of issues) {
    const lane = laneForStatus(board, issue.status);
    if (!lane) unmapped++;
    const hit = byTicket.get(normKey(issue.key));
    if (!hit) {
      const { id, card } = createCard(board, state, {
        title: issue.summary,
        type: 'ticket',
        ticket: issue.key,
        column: lane ?? board.columns[0].id,
        note: issue.priority ? `Priority: ${issue.priority}` : undefined,
      });
      card.origin = { source: 'jira', key: issue.key };
      card.jira_status = issue.status;
      logEntry(card, 'jira', `mirrored from Jira (${issue.status})`);
      created.push(id);
      byTicket.set(normKey(issue.key), { id, card });
      continue;
    }
    const { id, card } = hit;
    if (card.archived) continue; // dismissed on the board — don't resurrect
    card.jira_status = issue.status;
    if (lane && card.column !== lane) {
      moveCard(board, state, id, lane);
      logEntry(card, 'jira', `Jira status is "${issue.status}" → lane "${lane}"`);
      moved.push({ id, to: lane, status: issue.status });
    }
  }
  // Source of truth cuts both ways: a mirrored card whose issue dropped out
  // of the JQL scope (moved off-sprint, reassigned, done) is archived — not
  // deleted; unarchiving brings it back. Skipped entirely when the sync
  // reported zero issues, so a mis-scoped JQL can't silently sweep the board.
  const archived = [];
  if (reconcile && issues.length) {
    const seen = new Set(issues.map((i) => normKey(i.key)));
    for (const [id, card] of Object.entries(state.cards)) {
      if (card.archived || card.origin?.source !== 'jira') continue;
      if (seen.has(normKey(card.refs?.ticket ?? ''))) continue;
      if (card.pending_session_logs?.length) {
        logEntry(card, 'jira', 'left Jira scope but an agent run is still going — not archived');
        continue;
      }
      card.archived = true;
      logEntry(card, 'jira', 'no longer in Jira scope (off-sprint, reassigned, or done) — archived');
      archived.push(id);
    }
  }
  return { created, moved, unmapped, archived };
}

function recordJira(state, patch) {
  state.jira = { ...state.jira, ...patch };
}

function finishJiraSync(root, board, state, stdout, log = null) {
  const obj = extractResultJson(stdout);
  const base = log ? { last_log: log } : {};
  if (!obj) {
    recordJira(state, { last_run: nowIso(), last_status: 'error', last_summary: 'no parseable claude output', ...base });
    return { ok: false, error: 'no parseable claude output' };
  }
  const { issues, statuses, config, invalid } = parseIssues(obj.result);
  if (invalid) {
    recordJira(state, { last_run: nowIso(), last_status: 'error', last_summary: 'response was not the issues JSON shape', ...base });
    return { ok: false, error: 'response was not the issues JSON shape', tail: String(obj.result).slice(0, 300) };
  }
  const cfg = jiraConfig(board);
  // Jira-held state first. A FULL board config (has columns:) replaces
  // board.yml wholesale, so it applies before reconcileLanes tops up lanes
  // for any statuses the parked config hasn't seen yet. The legacy lanes:
  // map only decorates existing lanes, so it applies after reconcile.
  let laneCfg = { applied: [], error: null };
  let newLanes = [];
  const parsedCfg = cfg.config_issue && config ? parseConfigYaml(config) : null;
  if (parsedCfg && Array.isArray(parsedCfg.columns)) {
    laneCfg = applyFullBoardConfig(root, board, parsedCfg, cfg.allow_remote_actions);
    if (cfg.lanes_from_jira && statuses.length) newLanes = reconcileLanes(root, board, statuses);
  } else {
    if (cfg.lanes_from_jira && statuses.length) newLanes = reconcileLanes(root, board, statuses);
    if (cfg.config_issue && config) laneCfg = applyLaneConfig(root, board, config, cfg.allow_remote_actions);
  }
  const { created, moved, unmapped, archived } = applyIssues(board, state, issues, cfg.reconcile);
  const summary = `${issues.length} issue(s): ${created.length} new, ${moved.length} moved${unmapped ? `, ${unmapped} unmapped` : ''}`
    + `${archived.length ? `, ${archived.length} archived (left Jira scope)` : ''}`
    + `${newLanes.length ? ` · ${newLanes.length} lane(s) created from Jira` : ''}`
    + `${laneCfg.applied.length ? ` · ${parsedCfg && Array.isArray(parsedCfg.columns) ? 'full board config restored' : 'lane config applied'} (${laneCfg.applied.length} lane(s))` : ''}`
    + `${laneCfg.stripped ? ' — commands stripped (allow_remote_actions off)' : ''}`
    + `${laneCfg.error ? ` · config: ${laneCfg.error}` : ''}`;
  recordJira(state, {
    last_run: nowIso(), last_status: 'ok', last_summary: summary, ...base,
    ...(obj.session_id ? { last_session: obj.session_id } : {}),
  });
  return { ok: true, created, moved, unmapped, archived, new_lanes: newLanes, config_applied: laneCfg.applied, summary, session: obj.session_id ?? null };
}

// Generic fire-and-forget Jira write (comment / label) via the Atlassian MCP.
function spawnJiraWrite(root, board, tag, prompt) {
  let cmd = `claude -p ${shellQuote(prompt)} --output-format stream-json --verbose --permission-mode bypassPermissions --allowedTools ${shellQuote('mcp__atlassian')}`;
  cmd += claudeFlags(board, cmd);
  const dir = ensureLogDir(root);
  const logFile = path.join(dir, `jira-push-${tag}-${Date.now()}.log`);
  fs.writeFileSync(logFile, `# ${nowIso()} ${tag}\n`);
  const fd = fs.openSync(logFile, 'a');
  if (!noSpawn()) {
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', fd, fd], cwd: root });
    child.unref();
  }
  fs.closeSync(fd);
  return path.relative(root, logFile);
}

// Agent run summary → Jira comment: the team sees what the agent did.
export function pushJiraComment(root, board, state, id, text) {
  const cfg = jiraConfig(board);
  const card = state.cards[id];
  if (!cfg.enabled || !cfg.comments || !card?.refs?.ticket || !text?.trim()) return null;
  // clicking through from the ticket to the actual session transcript
  const sid = latestSession(card)?.id;
  const link = sid && cfg.board_url ? `\n\n🔗 session: ${cfg.board_url.replace(/\/+$/, '')}/session/${sid}` : '';
  const body = `🤖 mini-board agent (${card.column}): ${text.trim().slice(0, 1200)}${link}`;
  const prompt = `Using the Atlassian tools, add this comment to Jira issue ${card.refs.ticket}, verbatim:\n\n${body}\n\nReply with one line confirming.`;
  const log = spawnJiraWrite(root, board, `comment-${id}`, prompt);
  logEntry(card, 'jira', `posting run summary to ${card.refs.ticket} (log: ${log})`);
  return { log };
}

// Latest meaningful activity in a claude stream-json log: the last assistant
// text block, or failing that the last tool call — "what is the agent doing".
export function extractSessionActivity(text) {
  let lastText = null;
  let lastTool = null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let o = null;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (o?.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'text' && b.text?.trim()) lastText = b.text.trim();
      else if (b?.type === 'tool_use' && b.name) lastTool = b.name;
    }
  }
  return lastText ?? (lastTool ? `running tool: ${lastTool}` : null);
}

// Live run visibility ON the ticket: when a session starts on a ticketed
// card, announce it as a comment; while it runs, push the agent's latest
// activity at most once per PROGRESS_EVERY_MS. The existing completion
// summary (applyFlow → pushJiraComment) closes the thread. Rides the
// jira.comments gate; called from every harvest tick.
const PROGRESS_EVERY_MS = 5 * 60_000;

export function pushSessionProgress(root, board, state, now = Date.now()) {
  const cfg = jiraConfig(board);
  if (!cfg.enabled || !cfg.comments) return null;
  const pushed = [];
  for (const [id, card] of Object.entries(state.cards)) {
    const logs = card.pending_session_logs;
    if (!logs?.length || card.archived || !card.refs?.ticket) {
      if (card.jira_progress) delete card.jira_progress; // run over — completion comment takes it from here
      continue;
    }
    const logRel = logs.at(-1);
    let p = card.jira_progress;
    if (!p || p.log !== logRel) {
      card.jira_progress = { log: logRel, last_push: nowIso() };
      pushJiraComment(root, board, state, id, `▶️ agent run started — progress updates will follow on this issue`);
      pushed.push({ id, kind: 'started' });
      continue;
    }
    if (now - Date.parse(p.last_push) < PROGRESS_EVERY_MS) continue;
    let text = null;
    try { text = fs.readFileSync(path.join(root, logRel), 'utf8'); } catch { continue; }
    const activity = extractSessionActivity(text);
    p.last_push = nowIso(); // even when quiet — don't re-read every tick
    if (!activity || activity === p.last_activity) continue; // nothing new to say
    p.last_activity = activity;
    pushJiraComment(root, board, state, id, `⏳ still working: ${activity.slice(0, 500)}`);
    pushed.push({ id, kind: 'progress' });
  }
  return pushed.length ? pushed : null;
}

// Paused / unpaused state → an mb-paused label on the issue.
export function pushJiraLabel(root, board, state, id, label, add = true) {
  const cfg = jiraConfig(board);
  const card = state.cards[id];
  if (!cfg.enabled || !cfg.labels || !card?.refs?.ticket) return null;
  const prompt = `Using the Atlassian tools, ${add ? 'add' : 'remove'} the label "${label}" ${add ? 'to' : 'from'} Jira issue ${card.refs.ticket} (edit the issue's labels field). Reply with one line confirming.`;
  const log = spawnJiraWrite(root, board, `label-${id}`, prompt);
  logEntry(card, 'jira', `${add ? 'adding' : 'removing'} label "${label}" on ${card.refs.ticket} (log: ${log})`);
  return { log };
}

export function runJiraSync(root, board, state, opts = {}) {
  const cfg = jiraConfig(board);
  if (!cfg.enabled) return { ok: false, error: 'no jira: block in board.yml — configure the Jira mirror first' };
  if (state.pending_jira) return { ok: false, error: 'a Jira sync is already running' };
  const prompt = buildJiraSyncPrompt(board, cfg);
  const cmd = buildJiraSyncCommand(board, prompt);
  if (opts.dryRun) return { ok: true, dryRun: true, cmd };
  const dir = ensureLogDir(root);
  const logFile = path.join(dir, `jira-${Date.now()}.log`);
  fs.writeFileSync(logFile, `# ${nowIso()} jira sync\n`);
  const fd = fs.openSync(logFile, 'a');
  if (!noSpawn()) {
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', fd, fd], cwd: root });
    child.unref();
  }
  fs.closeSync(fd);
  state.pending_jira = { log: path.relative(root, logFile), started: nowIso() };
  recordJira(state, { last_status: 'running' });
  return { ok: true, background: true, log: logFile };
}

export function harvestJiraSync(root, board, state, now = Date.now()) {
  const pending = state.pending_jira;
  if (!pending) return null;
  let text = null;
  try { text = fs.readFileSync(path.join(root, pending.log), 'utf8'); } catch { /* gone */ }
  if (text === null) { delete state.pending_jira; return null; }
  if (extractResultJson(text)) {
    delete state.pending_jira;
    return finishJiraSync(root, board, state, text, pending.log);
  }
  if (now - Date.parse(pending.started) > JIRA_TIMEOUT_MS) {
    delete state.pending_jira;
    recordJira(state, { last_run: nowIso(), last_status: 'error', last_summary: 'sync timed out or produced no output', last_log: pending.log });
    return { ok: false, error: 'sync timed out or produced no output' };
  }
  return null;
}

// Inbox quarantine: a card with no Jira ticket has no source of truth, so it
// doesn't get to live outside the staging lane (the board's first column).
// PR cards are exempt — GitHub owns them (and pr_merged/pr_closed auto-moves
// must keep working). Enforced on every move path: drag, CLI, triage, flow.
export function stagingLane(board) {
  return board.columns[0]?.id ?? null;
}

export function mustStayInInbox(board, card, target) {
  const cfg = jiraConfig(board);
  if (!cfg.enabled) return false;
  if (!card || card.refs?.ticket || card.type === 'pr') return false;
  return !!target && target !== stagingLane(board);
}

// Inbox → Jira: promoting a ticketless card into a status-mapped lane FILES a
// Jira issue — the board's "once it leaves inbox, it's a ticket" contract.
// Fire-and-forget spawn; the created key is harvested from the log afterwards
// (harvestJiraCreates) and attached to the card, at which point push_moves,
// comments, and labels all apply to it like any mirrored card.
export function pushJiraCreate(root, board, state, id, targetLane) {
  const cfg = jiraConfig(board);
  const card = state.cards[id];
  const status = statusForLane(board, targetLane);
  if (!cfg.enabled || !cfg.create_tickets || !cfg.project || !card || card.refs?.ticket || !status) return null;
  if (state.pending_jira_creates?.some((p) => p.id === id)) return null; // create already in flight
  const context = [
    `Summary: ${card.title}`,
    card.note ? `Details: ${card.note}` : null,
    card.refs?.pr ? `Related PR: ${card.refs.pr}` : null,
    card.refs?.slack ? `Slack thread: ${card.refs.slack}` : null,
    `(Filed automatically by mini-board when the card was promoted to "${status}".)`,
  ].filter(Boolean).join('\n');
  const prompt = [
    `Using the Atlassian tools, create a Jira issue in project ${cfg.project}:`,
    context,
    `Then: assign it to me, add it to the active sprint if there is one, and transition it to status "${status}" (skip any of these that fail — the issue itself matters most).`,
    'Reply with ONLY the new issue key (e.g. NP-1234) — nothing else.',
  ].join('\n\n');
  const log = spawnJiraWrite(root, board, `create-${id}`, prompt);
  state.pending_jira_creates ??= [];
  state.pending_jira_creates.push({ id, log, started: nowIso(), status, lane: targetLane });
  logEntry(card, 'jira', `promoting to "${targetLane}" — filing a ${cfg.project} ticket at "${status}" first (log: ${log})`);
  return { log, status, lane: targetLane };
}

// Harvest filed tickets: pull the issue key out of each finished create run
// and attach it to the card. From then on the card is a mirrored Jira card.
export function harvestJiraCreates(root, board, state, now = Date.now()) {
  const pending = state.pending_jira_creates;
  if (!pending?.length) return null;
  const remaining = [];
  const attached = [];
  for (const p of pending) {
    let text = null;
    try { text = fs.readFileSync(path.join(root, p.log), 'utf8'); } catch { /* gone */ }
    const card = state.cards[p.id];
    if (text === null || !card) continue; // log vanished or card deleted — drop
    const obj = extractResultJson(text);
    if (obj) {
      const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(String(obj.result ?? ''))?.[1];
      if (key) {
        card.refs ??= {};
        card.refs.ticket = key;
        card.origin ??= { source: 'board', key };
        card.jira_status = p.status;
        logEntry(card, 'jira', `filed as ${key} (${p.status})`);
        // ticket exists now — complete the promotion the guard held back
        if (p.lane && getColumn(board, p.lane) && card.column !== p.lane && !card.archived) {
          moveCard(board, state, p.id, p.lane);
          logEntry(card, 'jira', `ticket landed — promoted to "${p.lane}"`);
        }
        attached.push({ id: p.id, key });
      } else {
        logEntry(card, 'jira', `ticket creation finished but no issue key in the reply — check ${p.log}`);
      }
      continue;
    }
    if (now - Date.parse(p.started) > JIRA_TIMEOUT_MS) {
      logEntry(card, 'jira', `ticket creation timed out — check ${p.log}`);
      continue;
    }
    remaining.push(p);
  }
  if (remaining.length) state.pending_jira_creates = remaining;
  else delete state.pending_jira_creates;
  return attached.length ? attached : null;
}

// Board → Jira: a card dragged to a status-mapped lane transitions the issue.
// Fire-and-forget background run; the outcome is visible in its log and on
// the next sync (Jira reports the new status back).
export function pushJiraTransition(root, board, state, id, targetLane) {
  const cfg = jiraConfig(board);
  const card = state.cards[id];
  const status = statusForLane(board, targetLane);
  if (!cfg.enabled || !cfg.push_moves || !card?.refs?.ticket || !status) return null;
  if (normKey(card.jira_status ?? '') === normKey(status)) return null; // already there
  const prompt = `Using the Atlassian tools, transition Jira issue ${card.refs.ticket} to status "${status}". If that exact transition is unavailable, pick the transition whose target status matches. Reply with one line: the issue key and its new status.`;
  let cmd = `claude -p ${shellQuote(prompt)} --output-format stream-json --verbose --permission-mode bypassPermissions --allowedTools ${shellQuote('mcp__atlassian')}`;
  cmd += claudeFlags(board, cmd);
  const dir = ensureLogDir(root);
  const logFile = path.join(dir, `jira-push-${id}-${Date.now()}.log`);
  fs.writeFileSync(logFile, `# ${nowIso()} jira push ${card.refs.ticket} → ${status}\n`);
  const fd = fs.openSync(logFile, 'a');
  if (!noSpawn()) {
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', fd, fd], cwd: root });
    child.unref();
  }
  fs.closeSync(fd);
  card.jira_status = status; // optimistic; next sync corrects if the transition failed
  logEntry(card, 'jira', `pushing ${card.refs.ticket} → "${status}" in Jira (log: ${path.relative(root, logFile)})`);
  return { pushed: status, log: logFile };
}
