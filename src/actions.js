// Actions: shell command templates fired on column transitions, comments, and
// agent launches. Long-running agent commands run in the background with
// output teed to .mini-board/logs/, and Claude session ids are harvested from
// those logs afterwards ("session capture").

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ensureLogDir, latestSession, logEntry } from './store.js';
import { fillTemplate, nowIso } from './util.js';

// Used when board.yml doesn't define its own `actions:`. Placeholders are
// shell-escaped on substitution, so they must not be quoted in the template.
export const DEFAULT_ACTIONS = {
  // `mb comment <card> --fire` — push a comment into the card's latest session.
  fire_comment: {
    run: 'claude --resume {{card.session}} -p {{message}} --output-format json',
    background: true,
    capture_session: true,
  },
  // `mb agent <card>` — launch a fresh agent with the full card context.
  new_agent: {
    run: 'claude -p {{prompt}} --output-format json',
    background: true,
    capture_session: true,
  },
};

export function normalizeAction(def, name = null) {
  if (typeof def === 'string') return { name, run: def, background: false, capture_session: false };
  return {
    name: def.name ?? name,
    run: def.run,
    background: def.background ?? false,
    capture_session: def.capture_session ?? false,
  };
}

export function namedAction(board, name) {
  const def = board.actions?.[name] ?? DEFAULT_ACTIONS[name];
  return def ? normalizeAction(def, name) : null;
}

// A prompt-friendly digest of the card an agent can pick up cold.
export function cardContext(board, id, card, instruction) {
  const lines = [
    `You are picking up work item ${id}: "${card.title}" from ${board.board?.name ?? 'a mini-board'} board.`,
    `Type: ${card.type}. Current column: ${card.column}.`,
  ];
  const refs = [];
  if (card.refs?.pr) refs.push(`PR: ${card.refs.pr}`);
  if (card.refs?.ticket) refs.push(`Ticket: ${card.refs.ticket}`);
  if (card.refs?.slack) refs.push(`Slack thread: ${card.refs.slack}`);
  if (refs.length) lines.push(`References: ${refs.join(' · ')}`);
  if (card.pr_state) {
    lines.push(
      `PR state at last sync: ${card.pr_state.state}, review=${card.pr_state.review ?? 'none'}, checks=${card.pr_state.checks ?? 'none'}.`,
    );
  }
  const recent = (card.log ?? []).slice(-8);
  if (recent.length) {
    lines.push('Recent activity:');
    for (const e of recent) lines.push(`- [${e.at}] ${e.kind}: ${e.text}`);
  }
  lines.push(
    `Instruction: ${instruction || 'Review the current state of this work item and continue it to completion.'}`,
  );
  return lines.join('\n');
}

// Everything a template can reference.
export function buildContext(board, id, card, extra = {}) {
  return {
    board: { name: board.board?.name ?? 'mini-board' },
    card: {
      id,
      title: card.title,
      type: card.type,
      column: card.column,
      project: card.project,
      pr: card.refs?.pr,
      ticket: card.refs?.ticket,
      slack: card.refs?.slack,
      session: latestSession(card)?.id,
      context: cardContext(board, id, card, extra.instruction),
    },
    message: extra.message,
    prompt: cardContext(board, id, card, extra.instruction),
    comment: extra.message,
    from: extra.from,
    to: extra.to,
  };
}

// Env vars for scripts that prefer $MB_* over templating.
function actionEnv(ctx) {
  const env = { ...process.env };
  const set = (k, v) => { if (v != null && v !== '') env[k] = String(v); };
  set('MB_CARD_ID', ctx.card.id);
  set('MB_CARD_TITLE', ctx.card.title);
  set('MB_CARD_COLUMN', ctx.card.column);
  set('MB_CARD_TYPE', ctx.card.type);
  set('MB_PR', ctx.card.pr);
  set('MB_TICKET', ctx.card.ticket);
  set('MB_SLACK', ctx.card.slack);
  set('MB_SESSION', ctx.card.session);
  set('MB_MESSAGE', ctx.message);
  set('MB_FROM', ctx.from);
  set('MB_TO', ctx.to);
  return env;
}

// Run one action for a card. Returns {ok, cmd, output?, logFile?, missing}.
export function runAction(root, board, state, id, actionDef, extra = {}, opts = {}) {
  const card = state.cards[id];
  const action = normalizeAction(actionDef);
  const ctx = buildContext(board, id, card, extra);
  const { text: cmd, missing } = fillTemplate(action.run, ctx);

  if (missing.includes('card.session')) {
    return {
      ok: false, cmd, missing,
      error: `card ${id} has no Claude session attached — use "mb agent ${id}" to start one or "mb session ${id} <session-id>" to attach one`,
    };
  }

  if (opts.dryRun) return { ok: true, cmd, missing, dryRun: true };

  const label = action.name ?? 'action';
  if (action.background) {
    const dir = ensureLogDir(root);
    const logFile = path.join(dir, `${id}-${Date.now()}-${label}.log`);
    fs.writeFileSync(logFile, `# ${nowIso()} ${label}\n# ${cmd}\n\n`);
    const fd = fs.openSync(logFile, 'a');
    const child = spawn('/bin/sh', ['-c', cmd], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: actionEnv(ctx),
      cwd: root,
    });
    child.unref();
    fs.closeSync(fd);
    if (action.capture_session) {
      card.pending_session_logs ??= [];
      card.pending_session_logs.push(path.relative(root, logFile));
    }
    logEntry(card, 'action', `launched "${label}" in background → ${path.relative(root, logFile)}`, { cmd });
    return { ok: true, cmd, logFile, background: true, missing };
  }

  const res = spawnSync('/bin/sh', ['-c', cmd], {
    encoding: 'utf8',
    env: actionEnv(ctx),
    cwd: root,
    timeout: opts.timeout ?? 10 * 60_000,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  const ok = res.status === 0;
  logEntry(card, 'action', `ran "${label}" (${ok ? 'ok' : `exit ${res.status}`})`, {
    cmd,
    output: output.slice(-2000),
  });
  if (ok && action.capture_session) {
    const sid = extractSessionId(output);
    if (sid) attachSession(card, sid, `captured from ${label}`);
  }
  return { ok, cmd, output, status: res.status, missing };
}

export function extractSessionId(text) {
  const m = /"session_id"\s*:\s*"([^"]+)"/.exec(text ?? '');
  return m ? m[1] : null;
}

export function attachSession(card, sessionId, label) {
  card.sessions ??= [];
  if (card.sessions.some((s) => s.id === sessionId)) return false;
  card.sessions.push({ id: sessionId, label, at: nowIso() });
  logEntry(card, 'session', `attached Claude session ${sessionId} (${label})`);
  return true;
}

// Scan pending background logs for captured session ids. Called from
// board/sync so sessions show up without babysitting.
export function harvestSessions(root, state) {
  let found = 0;
  for (const [, card] of Object.entries(state.cards)) {
    if (!card.pending_session_logs?.length) continue;
    const remaining = [];
    for (const rel of card.pending_session_logs) {
      const file = path.join(root, rel);
      let sid = null;
      try {
        sid = extractSessionId(fs.readFileSync(file, 'utf8'));
      } catch {
        // log file vanished — drop the pending entry
        continue;
      }
      if (sid) {
        if (attachSession(card, sid, `captured from ${path.basename(rel)}`)) found++;
      } else {
        remaining.push(rel);
      }
    }
    card.pending_session_logs = remaining;
    if (!remaining.length) delete card.pending_session_logs;
  }
  return found;
}

// All on_enter/on_leave actions for a move.
export function actionsForMove(board, from, to) {
  const fromCol = board.columns.find((c) => c.id === from);
  const toCol = board.columns.find((c) => c.id === to);
  const list = [];
  for (const a of fromCol?.on_leave ?? []) list.push(normalizeAction(a, `on_leave:${from}`));
  for (const a of toCol?.on_enter ?? []) list.push(normalizeAction(a, `on_enter:${to}`));
  return list;
}
