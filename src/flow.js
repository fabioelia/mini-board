// Flow: lane-to-lane pipelines. A column with `on_done: <lane>` funnels its
// cards onward when their agent run completes successfully — firing the
// target lane's automations, so lanes chain into pipelines. The loop guard
// (`max_visits`, default 2) breaks runaway cycles: a card that would enter a
// lane more times than allowed is parked in the paused lane (flow.paused)
// with a flag instead.

import { getColumn, moveCard, logEntry } from './store.js';
import { actionsForMove, runAction } from './actions.js';
import { pushJiraComment, pushJiraLabel, mustStayInInbox } from './jira.js';

const DEFAULT_MAX_VISITS = 2;

export function flowConfig(board) {
  const f = board.flow ?? {};
  return {
    paused: f.paused ?? 'paused',
    max_visits: f.max_visits ?? DEFAULT_MAX_VISITS,
  };
}

export function maxVisitsFor(board, columnId) {
  const col = getColumn(board, columnId);
  return col?.max_visits ?? flowConfig(board).max_visits;
}

// Guarded automated move: normal moves pass through; a move that would
// exceed the target lane's visit budget parks the card instead. Manual drags
// don't come through here — human intent isn't a loop.
export function guardedMove(board, state, id, target, why) {
  const card = state.cards[id];
  const visits = card.lane_visits?.[target] ?? 0;
  const max = maxVisitsFor(board, target);
  if (visits < max) {
    moveCard(board, state, id, target);
    return { id, to: target, paused: false };
  }
  const cfg = flowConfig(board);
  const pausedCol = getColumn(board, cfg.paused) ? cfg.paused : null;
  const reason = `loop guard: already entered "${target}" ${visits}× (max ${max})`;
  card.flags ??= [];
  card.flags.push({ reason, at: new Date().toISOString(), source: 'flow' });
  if (pausedCol && card.column !== pausedCol) {
    moveCard(board, state, id, pausedCol);
    logEntry(card, 'flow', `${reason} — parked in "${pausedCol}"`);
    return { id, to: pausedCol, paused: true, reason };
  }
  logEntry(card, 'flow', `${reason} — flagged in place (no "${cfg.paused}" lane on this board)`);
  return { id, to: card.column, paused: true, reason };
}

// Route cards whose lane run just completed. `completed` is the list of card
// ids whose background agent run finished successfully this harvest.
export function applyFlow(root, board, state, completed = []) {
  const moves = [];
  for (const id of completed) {
    const card = state.cards[id];
    if (!card || card.archived) continue;
    // agent run summary parks in Jira as a comment (when jira.comments is on)
    const reply = (card.log ?? []).filter((e) => e.kind === 'session').at(-1);
    if (reply && !reply.text.startsWith('attached Claude session')) {
      pushJiraComment(root, board, state, id, reply.text);
    }
    if (card.pending_session_logs?.length) continue; // another run still going
    const col = getColumn(board, card.column);
    const target = col?.on_done;
    if (!target || target === card.column) continue;
    if (!getColumn(board, target)) {
      logEntry(card, 'flow', `on_done points at unknown lane "${target}" — staying put`);
      continue;
    }
    if (mustStayInInbox(board, card, target)) {
      logEntry(card, 'flow', `on_done → "${target}" held — no Jira ticket, card stays put`);
      continue;
    }
    const from = card.column;
    const res = guardedMove(board, state, id, target, 'on_done');
    if (res.paused) {
      pushJiraLabel(root, board, state, id, 'mb-paused'); // parked state parks in Jira too
      moves.push(res);
      continue;
    }
    logEntry(card, 'flow', `work in "${col.title ?? from}" done → "${target}"`);
    // fire the transition's automations — this is what chains lanes into a
    // pipeline (e.g. done in "agent" → enters "waiting-pr")
    const actions = [];
    for (const action of actionsForMove(board, from, target)) {
      actions.push(runAction(root, board, state, id, action, { from, to: target }));
    }
    moves.push({ ...res, actions });
  }
  return moves;
}
