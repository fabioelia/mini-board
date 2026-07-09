// The attention engine: given a card + its column config, produce the list of
// reasons it needs the human. Reasons are computed live (never stored), except
// explicit flags which live on the card until cleared.

import { getColumn } from './store.js';
import { parseDuration, humanAge } from './util.js';

export function computeAttention(board, card, now = Date.now()) {
  const reasons = [];
  const col = getColumn(board, card.column);

  if (col?.attention) {
    reasons.push({ reason: `in "${col.title}" — this column always needs triage`, source: 'column' });
  }

  const staleAfter = col?.stale_after ? parseDuration(col.stale_after) : null;
  if (staleAfter) {
    const age = now - Date.parse(card.updated);
    if (age > staleAfter) {
      reasons.push({
        reason: `stale — no activity for ${humanAge(age)} (limit ${col.stale_after} in "${col.title}")`,
        source: 'stale',
      });
    }
  }

  for (const f of card.flags ?? []) {
    reasons.push({ reason: f.reason, source: f.source ?? 'flag' });
  }

  reasons.push(...prAttention(board, card));

  // NOTE: a running agent (pending_session_logs) is deliberately NOT an
  // attention reason — it's a status. Harvest happens automatically on every
  // board/sync/web poll, and runs that go quiet time out into a visible log
  // entry after 15m.

  return reasons;
}

function prAttention(board, card) {
  const pr = card.pr_state;
  if (!pr) return [];
  const reasons = [];
  const autoMove = board.sync?.auto_move ?? {};

  if (pr.state === 'MERGED') {
    const target = autoMove.pr_merged;
    if (!target || card.column !== target) {
      reasons.push({ reason: 'PR merged — move the card / start post-merge follow-up', source: 'pr' });
    }
  } else if (pr.state === 'CLOSED') {
    const target = autoMove.pr_closed;
    if (!target || card.column !== target) {
      reasons.push({ reason: 'PR closed without merging — decide what happens next', source: 'pr' });
    }
  } else {
    if (pr.review === 'CHANGES_REQUESTED') {
      reasons.push({ reason: 'PR: changes requested — fire a follow-up', source: 'pr' });
    }
    if (pr.checks === 'failing') {
      reasons.push({ reason: 'PR: CI failing', source: 'pr' });
    }
    if (pr.mergeable === 'CONFLICTING') {
      reasons.push({ reason: 'PR: merge conflict with base branch', source: 'pr' });
    }
    if (pr.review === 'APPROVED' && pr.checks !== 'failing') {
      reasons.push({ reason: 'PR approved — ready to merge', source: 'pr' });
    }
  }
  return reasons;
}

// [{id, card, attention}] for every active card that needs attention.
export function attentionList(board, state, now = Date.now()) {
  const out = [];
  for (const [id, card] of Object.entries(state.cards)) {
    if (card.archived) continue;
    const attention = computeAttention(board, card, now);
    if (attention.length) out.push({ id, card, attention });
  }
  // Most reasons first, then oldest updated first.
  out.sort(
    (a, b) =>
      b.attention.length - a.attention.length ||
      Date.parse(a.card.updated) - Date.parse(b.card.updated),
  );
  return out;
}
