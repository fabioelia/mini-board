// Handoff: every ticketed card carries a context document — refs, sessions,
// the latest agent summary, and the full timeline of events — regenerated and
// pushed to the Jira issue on every stage change. The next agent (or human)
// picks the work up from the ticket, never from local state.
//
// Push modes, best first:
//   1. Real file attachment via the Jira REST API — needs JIRA_EMAIL +
//      JIRA_API_TOKEN in the environment (an Atlassian API token).
//   2. Fallback: the document lands as an issue comment via a background
//      claude run (the Atlassian MCP has no attachment tool).
// Either way a copy is written to .mini-board/handoffs/<key>.md.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureLogDir, getColumn, logEntry } from './store.js';
import { jiraConfig } from './jira.js';
import { nowIso, shellQuote, claudeFlags } from './util.js';

const noSpawn = () => process.env.MB_NO_SPAWN === '1';

export const HANDOFF_DIR = '.mini-board/handoffs';

// https://acme.atlassian.net/browse/ → https://acme.atlassian.net
export function jiraOrigin(board) {
  const url = board.defaults?.ticket_url;
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

export function buildHandoffDoc(board, state, id) {
  const card = state.cards[id];
  if (!card) return null;
  const cfg = jiraConfig(board);
  const col = getColumn(board, card.column);
  const lines = [
    `# Handoff — ${card.refs?.ticket ?? id}: ${card.title}`,
    '',
    `Generated ${nowIso()} by mini-board (card ${id}) · stage: **${col?.title ?? card.column}**`,
    '',
    '## References',
  ];
  if (card.refs?.ticket) lines.push(`- Ticket: ${card.refs.ticket}`);
  if (card.refs?.pr) lines.push(`- PR: ${card.refs.pr}${card.pr_state ? ` (${card.pr_state.state.toLowerCase()}, review=${card.pr_state.review ?? 'none'}, checks=${card.pr_state.checks ?? 'none'})` : ''}`);
  if (card.refs?.slack) lines.push(`- Slack: ${card.refs.slack}`);
  if (!card.refs?.ticket && !card.refs?.pr && !card.refs?.slack) lines.push('- (none)');

  const base = cfg.board_url?.replace(/\/+$/, '');
  if (card.sessions?.length) {
    lines.push('', '## Agent sessions');
    for (const s of card.sessions) {
      lines.push(`- \`${s.id}\` — ${s.label ?? 'session'} (${s.at})${base ? ` · ${base}/session/${s.id}` : ''}`);
    }
  }

  // the last completed run's reply is the freshest "state of the work"
  const summary = (card.log ?? []).filter((e) => e.kind === 'session' && !e.text.startsWith('attached Claude session')).at(-1);
  if (summary) lines.push('', '## Latest agent summary', '', summary.text);

  lines.push('', '## Timeline');
  for (const e of card.log ?? []) lines.push(`- \`${e.at}\` **${e.kind}** — ${e.text}`);
  return lines.join('\n') + '\n';
}

// Fire-and-forget REST attach; the outcome lands in a log file, never in
// state (the caller has usually already queued its state save).
function attachViaRest(origin, key, filename, content, logFile) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/markdown' }), filename);
  fetch(`${origin}/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
      'X-Atlassian-Token': 'no-check',
    },
    body: form,
  }).then(async (res) => {
    const note = res.ok ? `attached ${filename} to ${key}` : `attach failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`;
    fs.appendFileSync(logFile, `${nowIso()} ${note}\n`);
  }).catch((err) => {
    fs.appendFileSync(logFile, `${nowIso()} attach failed: ${err.message}\n`);
  });
}

export function hasJiraRestCreds() {
  return !!(process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

// Regenerate the handoff doc and push it onto the Jira issue. Called on every
// stage change of a ticketed card (drag, flow on_done, PR auto_move, Jira
// sync). Cheap when it doesn't apply: no ticket / jira off → no-op.
export function pushJiraHandoff(root, board, state, id) {
  const cfg = jiraConfig(board);
  const card = state.cards[id];
  if (!cfg.enabled || !card?.refs?.ticket) return null;
  const key = card.refs.ticket;
  const doc = buildHandoffDoc(board, state, id);
  const dir = path.join(root, HANDOFF_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `mb-handoff-${key}.md`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, doc);

  const origin = jiraOrigin(board);
  if (hasJiraRestCreds() && origin) {
    const logFile = path.join(ensureLogDir(root), `handoff-${id}-${Date.now()}.log`);
    fs.writeFileSync(logFile, `# ${nowIso()} handoff ${key}\n`);
    if (!noSpawn()) attachViaRest(origin, key, filename, doc, logFile);
    logEntry(card, 'jira', `handoff attached to ${key} (${filename})`);
    return { mode: 'attachment', file };
  }

  // no REST creds: the doc rides in as a comment via the Atlassian MCP —
  // still on the ticket, just not a file. Export JIRA_EMAIL/JIRA_API_TOKEN
  // for real attachments.
  const body = `📎 Context handoff (mini-board — set JIRA_EMAIL/JIRA_API_TOKEN on the board host for file attachments):\n\n${doc.slice(0, 6000)}`;
  const prompt = `Using the Atlassian tools, add this comment to Jira issue ${key}, verbatim:\n\n${body}\n\nReply with one line confirming.`;
  let cmd = `claude -p ${shellQuote(prompt)} --output-format stream-json --verbose --permission-mode bypassPermissions --allowedTools ${shellQuote('mcp__atlassian')}`;
  cmd += claudeFlags(board, cmd);
  const logFile = path.join(ensureLogDir(root), `handoff-${id}-${Date.now()}.log`);
  fs.writeFileSync(logFile, `# ${nowIso()} handoff comment ${key}\n`);
  const fd = fs.openSync(logFile, 'a');
  if (!noSpawn()) {
    const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', fd, fd], cwd: root });
    child.unref();
  }
  fs.closeSync(fd);
  logEntry(card, 'jira', `handoff posted to ${key} as a comment (log: ${path.relative(root, logFile)})`);
  return { mode: 'comment', file };
}
