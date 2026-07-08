// Terminal rendering: the board, card detail, and the attention list.

import { computeAttention, attentionList } from './attention.js';
import { latestSession } from './store.js';
import { humanAge, truncate, wrap } from './util.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const paint = {
  dim: (s) => c('2', s),
  bold: (s) => c('1', s),
  red: (s) => c('31', s),
  green: (s) => c('32', s),
  yellow: (s) => c('33', s),
  blue: (s) => c('34', s),
  magenta: (s) => c('35', s),
  cyan: (s) => c('36', s),
};

const TYPE_ICON = { pr: 'PR', ticket: 'TK', slack: 'SL', task: '--' };

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function pad(s, width) {
  const len = stripAnsi(s).length;
  return len >= width ? s : s + ' '.repeat(width - len);
}

// Truncate to a visible width, letting ANSI escapes through for free.
function truncateAnsi(s, width) {
  let visible = 0;
  let out = '';
  let truncated = false;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
    }
    if (visible >= width - 1 && stripAnsi(str.slice(i)).length > 1) { truncated = true; break; }
    out += str[i];
    visible++;
  }
  if (truncated) out += '…';
  return out + (out.includes('\x1b') ? '\x1b[0m' : '');
}

function cardLines(id, card, attention, width) {
  const marks = [];
  if (attention.length) marks.push(paint.red(`!${attention.length}`));
  if (card.sessions?.length) marks.push(paint.cyan(`s${card.sessions.length}`));
  const head = `${paint.bold(id)} ${marks.join(' ')}`.trimEnd();

  const lines = [head];
  for (const l of wrap(card.title, width).slice(0, 2)) lines.push(l);

  const refs = [];
  if (card.refs?.pr) {
    const pr = card.pr_state;
    let label = 'PR';
    if (pr) {
      if (pr.state === 'MERGED') label = paint.magenta('PR merged');
      else if (pr.state === 'CLOSED') label = paint.dim('PR closed');
      else {
        label = 'PR open';
        if (pr.checks === 'failing') label += paint.red(' ci✗');
        else if (pr.checks === 'passing') label += paint.green(' ci✓');
        else if (pr.checks === 'pending') label += paint.yellow(' ci…');
        if (pr.review === 'APPROVED') label += paint.green(' ✓rev');
        if (pr.review === 'CHANGES_REQUESTED') label += paint.red(' ✗rev');
      }
    }
    refs.push(label);
  }
  if (card.refs?.ticket) refs.push(card.refs.ticket);
  if (card.refs?.slack) refs.push('slack');
  refs.push(paint.dim(humanAge(Date.now() - Date.parse(card.updated))));
  lines.push(refs.join(' · '));
  return lines.map((l) => truncateAnsi(l, width));
}

export function renderBoard(board, state, termWidth = process.stdout.columns || 140) {
  const cols = board.columns;
  const colWidth = Math.max(18, Math.floor((termWidth - cols.length + 1) / cols.length) - 2);
  const groupBy = board.board?.group_by ?? 'none';

  // Bucket cards per column, grouped by swimlane.
  const buckets = cols.map(() => new Map());
  for (const [id, card] of Object.entries(state.cards)) {
    if (card.archived) continue;
    const ci = cols.findIndex((col) => col.id === card.column);
    if (ci === -1) continue;
    const lane = groupBy === 'none' ? '' : String(card[groupBy] ?? card.type ?? 'other');
    if (!buckets[ci].has(lane)) buckets[ci].set(lane, []);
    buckets[ci].get(lane).push([id, card]);
  }

  const lanes = [...new Set(buckets.flatMap((b) => [...b.keys()]))].sort();
  const rendered = cols.map((col, ci) => {
    const lines = [];
    const count = [...buckets[ci].values()].reduce((n, arr) => n + arr.length, 0);
    lines.push(paint.bold(truncate(`${col.title} (${count})`, colWidth)));
    lines.push(paint.dim('─'.repeat(colWidth)));
    for (const lane of lanes.length ? lanes : ['']) {
      const cards = buckets[ci].get(lane) ?? [];
      if (!cards.length) continue;
      if (lane && lanes.length > 1) lines.push(paint.dim(truncate(`▾ ${lane}`, colWidth)));
      for (const [id, card] of cards) {
        const attention = computeAttention(board, card);
        lines.push(...cardLines(id, card, attention, colWidth));
        lines.push('');
      }
    }
    return lines;
  });

  const height = Math.max(...rendered.map((r) => r.length));
  const out = [];
  const name = board.board?.name ?? 'mini-board';
  const needy = attentionList(board, state).length;
  out.push(
    paint.bold(name) +
      (needy ? paint.red(`   ⚠ ${needy} card${needy === 1 ? ' needs' : 's need'} attention`) + paint.dim(' (mb attention)') : ''),
  );
  out.push('');
  for (let i = 0; i < height; i++) {
    out.push(rendered.map((r) => pad(r[i] ?? '', colWidth)).join(paint.dim(' │ ')));
  }
  return out.join('\n');
}

export function renderAttention(board, state) {
  const list = attentionList(board, state);
  if (!list.length) return paint.green('Nothing needs your attention. ✨');
  const out = [paint.bold(`${list.length} card${list.length === 1 ? ' needs' : 's need'} attention:`), ''];
  for (const { id, card, attention } of list) {
    out.push(`${paint.bold(id)} ${card.title} ${paint.dim(`[${card.column}]`)}`);
    for (const a of attention) out.push(`   ${paint.red('⚠')} ${a.reason}`);
    out.push('');
  }
  return out.join('\n');
}

export function renderCard(board, id, card) {
  const attention = computeAttention(board, card);
  const out = [];
  out.push(`${paint.bold(id)}  ${card.title}`);
  out.push(paint.dim(`${TYPE_ICON[card.type] ?? card.type} · column: ${card.column}${card.project ? ` · project: ${card.project}` : ''}${card.archived ? ' · ARCHIVED' : ''}`));
  out.push('');
  if (attention.length) {
    out.push(paint.bold('Attention:'));
    for (const a of attention) out.push(`  ${paint.red('⚠')} ${a.reason}`);
    out.push('');
  }
  const refs = [];
  if (card.refs?.pr) refs.push(`PR:     ${card.refs.pr}`);
  if (card.refs?.ticket) refs.push(`Ticket: ${card.refs.ticket}`);
  if (card.refs?.slack) refs.push(`Slack:  ${card.refs.slack}`);
  if (refs.length) {
    out.push(paint.bold('Refs:'));
    for (const r of refs) out.push(`  ${r}`);
    out.push('');
  }
  if (card.pr_state) {
    const pr = card.pr_state;
    out.push(paint.bold('PR state') + paint.dim(` (synced ${humanAge(Date.now() - Date.parse(pr.checked))} ago):`));
    out.push(`  ${pr.state}${pr.draft ? ' (draft)' : ''} · review=${pr.review} · checks=${pr.checks} · mergeable=${pr.mergeable}`);
    out.push('');
  }
  if (card.sessions?.length) {
    out.push(paint.bold('Claude sessions') + paint.dim(' (newest last — mb comment --fire resumes the last one):'));
    for (const s of card.sessions) out.push(`  ${paint.cyan(s.id)} ${paint.dim(`— ${s.label ?? ''} ${s.at ?? ''}`)}`);
    out.push('');
  }
  if (card.pending_session_logs?.length) {
    out.push(paint.bold('Pending agent logs:'));
    for (const l of card.pending_session_logs) out.push(`  ${l}`);
    out.push('');
  }
  const log = card.log ?? [];
  out.push(paint.bold(`Activity (${log.length}):`));
  for (const e of log.slice(-15)) {
    out.push(`  ${paint.dim(e.at)} ${paint.yellow(e.kind)} ${e.text}`);
  }
  const sess = latestSession(card);
  out.push('');
  out.push(
    paint.dim(
      sess
        ? `→ mb comment ${id} "…" --fire   resumes ${sess.id}`
        : `→ mb agent ${id}   launches a fresh Claude session with this card's context`,
    ),
  );
  return out.join('\n');
}
