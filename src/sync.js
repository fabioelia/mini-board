// PR sync: pull live state from GitHub via the `gh` CLI, stamp it onto cards,
// and optionally auto-move cards when their PR merges/closes.

import { spawnSync } from 'node:child_process';
import { logEntry, moveCard } from './store.js';

const PR_FIELDS = 'state,isDraft,reviewDecision,mergeable,statusCheckRollup,url,title,updatedAt';

// pr ref forms: full URL, "owner/repo#123", or bare number (needs defaults.repo).
export function parsePrRef(ref, defaults = {}) {
  const s = String(ref).trim();
  let m = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(s);
  if (m) return { repo: m[1], number: m[2] };
  m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (m) return { repo: m[1], number: m[2] };
  m = /^#?(\d+)$/.exec(s);
  if (m && defaults.repo) return { repo: defaults.repo, number: m[1] };
  return null;
}

function defaultExec(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000 });
  if (res.error?.code === 'ENOENT') {
    throw new Error('`gh` CLI not found — PR sync needs the GitHub CLI installed and authenticated');
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function summarizeChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let pending = false;
  for (const c of rollup) {
    const state = (c.conclusion || c.state || '').toUpperCase();
    if (['FAILURE', 'TIMED_OUT', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state)) {
      return 'failing';
    }
    if (['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'EXPECTED'].includes(state)) {
      pending = true;
    }
  }
  return pending ? 'pending' : 'passing';
}

function describe(pr) {
  const bits = [pr.state.toLowerCase()];
  if (pr.draft) bits.push('draft');
  if (pr.review && pr.review !== 'NONE') bits.push(`review=${pr.review.toLowerCase()}`);
  if (pr.checks !== 'none') bits.push(`checks=${pr.checks}`);
  if (pr.mergeable === 'CONFLICTING') bits.push('conflicts');
  return bits.join(', ');
}

// Sync one card's PR. exec is injectable for tests.
export function syncCard(board, state, id, { exec = defaultExec, autoMove = true } = {}) {
  const card = state.cards[id];
  const ref = card?.refs?.pr;
  if (!ref) return { id, skipped: 'no PR ref' };

  const parsed = parsePrRef(ref, board.defaults);
  const args = parsed
    ? ['pr', 'view', parsed.number, '-R', parsed.repo, '--json', PR_FIELDS]
    : ['pr', 'view', String(ref), '--json', PR_FIELDS];

  const res = exec(args);
  if (res.status !== 0) {
    return { id, error: `gh failed: ${(res.stderr || res.stdout || '').trim().slice(0, 200)}` };
  }

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    return { id, error: 'gh returned unparseable JSON' };
  }

  const next = {
    state: data.state,
    draft: !!data.isDraft,
    review: data.reviewDecision || 'NONE',
    mergeable: data.mergeable || 'UNKNOWN',
    checks: summarizeChecks(data.statusCheckRollup),
    url: data.url,
    pr_title: data.title,
    pr_updated: data.updatedAt,
    checked: new Date().toISOString(),
  };

  const prev = card.pr_state;
  const changed =
    !prev ||
    prev.state !== next.state ||
    prev.review !== next.review ||
    prev.checks !== next.checks ||
    prev.mergeable !== next.mergeable ||
    prev.draft !== next.draft;

  card.pr_state = next;
  if (changed) logEntry(card, 'sync', `PR is now: ${describe(next)}`);

  let moved = null;
  if (autoMove) {
    const targets = board.sync?.auto_move ?? {};
    const target =
      next.state === 'MERGED' ? targets.pr_merged : next.state === 'CLOSED' ? targets.pr_closed : null;
    if (target && card.column !== target && board.columns.some((c) => c.id === target)) {
      moveCard(board, state, id, target);
      logEntry(card, 'sync', `auto-moved to "${target}" (PR ${next.state.toLowerCase()})`);
      moved = target;
    }
  }

  return { id, changed, moved, pr: next };
}

export function syncAll(board, state, opts = {}) {
  const results = [];
  for (const [id, card] of Object.entries(state.cards)) {
    if (card.archived || !card.refs?.pr) continue;
    results.push(syncCard(board, state, id, opts));
  }
  return results;
}
