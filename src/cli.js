#!/usr/bin/env node
// mini-board CLI — `mb <command>`. Run `mb help` for the full list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  BOARD_FILE, STATE_FILE, findRoot, loadBoard, loadState, saveState,
  createCard, resolveCard, moveCard, logEntry, latestSession, getColumn,
} from './store.js';
import { computeAttention } from './attention.js';
import {
  actionsForMove, namedAction, runAction, harvestSessions, attachSession,
} from './actions.js';
import { syncAll, syncCard } from './sync.js';
import { renderBoard, renderCard, renderAttention, paint } from './render.js';
import { nowIso } from './util.js';
import { startServer } from './server.js';

const HELP = `mini-board — a tiny YAML-driven board for PRs, tickets, and Slack asks

Usage: mb <command> [args]

  mb init [dir]                    scaffold board.yml + state.yml
  mb [board]                       render the board in the terminal
  mb add "Title" [opts]            add a card
       --type pr|ticket|slack|task --pr <url|repo#N|N> --ticket <key>
       --slack <url> --col <column> --project <p> --session <id> --note "..."
  mb move <card> <column>          move a card (fires on_leave/on_enter actions)
       --no-actions --dry-run --comment "..."
  mb set <card>                    update a card's fields / refs
       --pr <url> --ticket <key> --slack <url> --title "..." --project <p> --type <t>
  mb comment <card> "text"         log a comment on the card
       --fire                      ...and send it into the card's latest Claude session
  mb agent <card> ["instruction"]  launch a NEW Claude session with the card's full context
  mb session <card> <session-id>   attach a Claude session id  [--label "..."]
  mb show <card>                   full card detail: refs, sessions, activity
  mb attention                     everything that needs you right now (alias: todo)
  mb sync [card]                   pull live PR state via gh; auto-move merged/closed
       --no-move                   don't auto-move
  mb flag <card> "reason"          manually mark a card as needing attention
  mb unflag <card>                 clear manual flags
  mb open <card> [pr|ticket|slack] open a card's ref in the browser
  mb archive <card>                archive (hide) a card
  mb list [--col <column>]         flat list of cards
  mb web [--port 4400]             serve the drag-and-drop web board

Cards can be referenced by id (mb-3), number (3), or a unique title substring.`;

function parseArgs(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replaceAll('-', '_');
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i++; }
      else opts[key] = true;
    } else args.push(a);
  }
  return { args, opts };
}

function fail(msg) {
  console.error(paint.red(`error: ${msg}`));
  process.exit(1);
}

function requireRoot() {
  const root = findRoot();
  if (!root) fail(`no ${BOARD_FILE} found here or in any parent directory — run "mb init" first`);
  return root;
}

function requireCard(state, ref) {
  if (!ref) fail('missing card reference');
  const hit = resolveCard(state, ref);
  if (!hit) fail(`no card matching "${ref}"`);
  return hit;
}

function reportAction(res) {
  if (res.dryRun) {
    console.log(paint.dim(`  [dry-run] would run: ${res.cmd}`));
  } else if (res.error) {
    console.log(paint.red(`  ✗ ${res.error}`));
  } else if (res.background) {
    console.log(paint.dim(`  ↗ launched in background: ${res.cmd}`));
    console.log(paint.dim(`    log: ${res.logFile}`));
  } else if (res.ok) {
    console.log(paint.dim(`  ✓ ran: ${res.cmd}`));
    if (res.output) console.log(paint.dim(`    ${res.output.split('\n').slice(-3).join('\n    ')}`));
  } else {
    console.log(paint.red(`  ✗ exit ${res.status}: ${res.cmd}`));
    if (res.output) console.log(paint.dim(`    ${res.output.split('\n').slice(-5).join('\n    ')}`));
  }
}

const commands = {
  init([dir]) {
    const target = path.resolve(dir ?? '.');
    fs.mkdirSync(target, { recursive: true });
    const boardFile = path.join(target, BOARD_FILE);
    if (fs.existsSync(boardFile)) fail(`${boardFile} already exists`);
    const templateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
    fs.copyFileSync(path.join(templateDir, 'board.yml'), boardFile);
    saveState(target, { next_id: 1, cards: {} });
    console.log(`Created ${boardFile} and ${path.join(target, STATE_FILE)}.`);
    console.log('Edit board.yml to taste, then: mb add "My first card" --pr <url>');
  },

  board() {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    if (harvestSessions(root, state) > 0) saveState(root, state);
    console.log(renderBoard(board, state));
  },

  add(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    const title = args.join(' ').trim();
    if (!title) fail('usage: mb add "Title" [--pr <url>] [--ticket NP-123] [--slack <url>] [--col <column>]');
    const { id, card } = createCard(board, state, {
      title,
      type: opts.type,
      pr: opts.pr,
      ticket: opts.ticket,
      slack: opts.slack,
      column: opts.col ?? opts.column,
      project: opts.project,
      session: opts.session,
      note: opts.note,
    });
    saveState(root, state);
    console.log(`${paint.bold(id)} added to "${card.column}": ${card.title}`);
  },

  move(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    const [ref, toColumn] = args;
    if (!toColumn) fail('usage: mb move <card> <column>');
    const { id, card } = requireCard(state, ref);
    if (!getColumn(board, toColumn)) {
      fail(`unknown column "${toColumn}" — columns: ${board.columns.map((c) => c.id).join(', ')}`);
    }
    const from = card.column;
    if (opts.comment) logEntry(card, 'comment', String(opts.comment));
    const { moved } = moveCard(board, state, id, toColumn);
    if (!moved) {
      console.log(`${id} is already in "${toColumn}"`);
      saveState(root, state);
      return;
    }
    console.log(`${paint.bold(id)} moved ${from} → ${paint.bold(toColumn)}`);
    if (!opts.no_actions) {
      for (const action of actionsForMove(board, from, toColumn)) {
        const res = runAction(root, board, state, id, action, { from, to: toColumn, message: opts.comment }, { dryRun: !!opts.dry_run });
        reportAction(res);
      }
    }
    saveState(root, state);
  },

  set(args, opts) {
    const root = requireRoot();
    const state = loadState(root);
    const { id, card } = requireCard(state, args[0]);
    const changes = [];
    for (const key of ['pr', 'ticket', 'slack']) {
      if (opts[key] !== undefined) {
        card.refs[key] = opts[key] === true ? null : String(opts[key]);
        changes.push(`${key} → ${card.refs[key] ?? '(cleared)'}`);
        if (key === 'pr' && opts[key] !== true) delete card.pr_state;
      }
    }
    if (opts.title) { card.title = String(opts.title); changes.push('title updated'); }
    if (opts.project) { card.project = String(opts.project); changes.push(`project → ${opts.project}`); }
    if (opts.type) { card.type = String(opts.type); changes.push(`type → ${opts.type}`); }
    if (!changes.length) fail('nothing to set — use --pr/--ticket/--slack/--title/--project/--type');
    logEntry(card, 'update', changes.join('; '));
    saveState(root, state);
    console.log(`${paint.bold(id)} ${changes.join('; ')}`);
  },

  comment(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    const [ref, ...rest] = args;
    const text = rest.join(' ').trim();
    if (!text) fail('usage: mb comment <card> "text" [--fire]');
    const { id, card } = requireCard(state, ref);
    logEntry(card, 'comment', text);
    console.log(`${paint.bold(id)} commented.`);
    if (opts.fire) {
      const action = namedAction(board, 'fire_comment');
      const res = runAction(root, board, state, id, action, { message: text }, { dryRun: !!opts.dry_run });
      reportAction(res);
      if (res.ok && !res.dryRun) {
        const sess = latestSession(card);
        console.log(paint.dim(`  → fired into session ${sess?.id ?? '(new)'}`));
      }
    }
    saveState(root, state);
  },

  agent(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    const [ref, ...rest] = args;
    const instruction = rest.join(' ').trim() || undefined;
    const { id } = requireCard(state, ref);
    const action = namedAction(board, 'new_agent');
    if (instruction) logEntry(state.cards[id], 'comment', `(to new agent) ${instruction}`);
    const res = runAction(root, board, state, id, action, { instruction }, { dryRun: !!opts.dry_run });
    reportAction(res);
    saveState(root, state);
  },

  session(args, opts) {
    const root = requireRoot();
    const state = loadState(root);
    const [ref, sessionId] = args;
    if (!sessionId) fail('usage: mb session <card> <session-id> [--label "..."]');
    const { id, card } = requireCard(state, ref);
    attachSession(card, sessionId, opts.label ?? 'manual');
    saveState(root, state);
    console.log(`${paint.bold(id)} now has ${card.sessions.length} session(s); latest: ${sessionId}`);
  },

  show(args) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    if (harvestSessions(root, state) > 0) saveState(root, state);
    const { id, card } = requireCard(state, args[0]);
    console.log(renderCard(board, id, card));
  },

  attention() {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    if (harvestSessions(root, state) > 0) saveState(root, state);
    console.log(renderAttention(board, state));
  },
  todo(...a) { return commands.attention(...a); },

  sync(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    const harvested = harvestSessions(root, state);
    if (harvested) console.log(paint.dim(`captured ${harvested} Claude session id(s) from agent logs`));
    const syncOpts = { autoMove: !opts.no_move };
    const results = args[0]
      ? [syncCard(board, state, requireCard(state, args[0]).id, syncOpts)]
      : syncAll(board, state, syncOpts);
    saveState(root, state);
    if (!results.length) { console.log('no cards with PR refs to sync'); return; }
    for (const r of results) {
      if (r.error) console.log(`${paint.bold(r.id)} ${paint.red(r.error)}`);
      else if (r.skipped) console.log(`${paint.bold(r.id)} ${paint.dim(r.skipped)}`);
      else {
        const bits = [`PR ${r.pr.state.toLowerCase()}`, `review=${r.pr.review.toLowerCase()}`, `checks=${r.pr.checks}`];
        if (r.moved) bits.push(paint.bold(`auto-moved → ${r.moved}`));
        console.log(`${paint.bold(r.id)} ${bits.join(' · ')}${r.changed ? '' : paint.dim(' (unchanged)')}`);
      }
    }
    console.log('');
    console.log(renderAttention(board, state));
  },

  flag(args) {
    const root = requireRoot();
    const state = loadState(root);
    const [ref, ...rest] = args;
    const reason = rest.join(' ').trim();
    if (!reason) fail('usage: mb flag <card> "reason"');
    const { id, card } = requireCard(state, ref);
    card.flags ??= [];
    card.flags.push({ reason, at: nowIso(), source: 'manual' });
    logEntry(card, 'flag', reason);
    saveState(root, state);
    console.log(`${paint.bold(id)} flagged: ${reason}`);
  },

  unflag(args) {
    const root = requireRoot();
    const state = loadState(root);
    const { id, card } = requireCard(state, args[0]);
    const n = (card.flags ?? []).length;
    card.flags = [];
    logEntry(card, 'flag', `cleared ${n} flag(s)`);
    saveState(root, state);
    console.log(`${paint.bold(id)} cleared ${n} flag(s)`);
  },

  open(args) {
    const root = requireRoot();
    const state = loadState(root);
    const { id, card } = requireCard(state, args[0]);
    const which = args[1] ?? (card.refs?.pr ? 'pr' : card.refs?.ticket ? 'ticket' : 'slack');
    let url = card.refs?.[which];
    if (!url) fail(`${id} has no ${which} ref`);
    if (which === 'ticket' && !/^https?:/.test(url)) {
      const base = loadBoard(root).defaults?.ticket_url;
      if (!base) fail(`ticket "${url}" is not a URL — set defaults.ticket_url in board.yml (e.g. https://jira.example.com/browse/)`);
      url = base.replace(/\/?$/, '/') + url;
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
    console.log(`opening ${url}`);
  },

  archive(args) {
    const root = requireRoot();
    const state = loadState(root);
    const { id, card } = requireCard(state, args[0]);
    card.archived = true;
    logEntry(card, 'archive', 'archived');
    saveState(root, state);
    console.log(`${paint.bold(id)} archived`);
  },

  list(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    for (const [id, card] of Object.entries(state.cards)) {
      if (card.archived) continue;
      if (opts.col && card.column !== opts.col) continue;
      const attention = computeAttention(board, card);
      const mark = attention.length ? paint.red(` ⚠${attention.length}`) : '';
      console.log(`${paint.bold(id)} [${card.column}]${mark} ${card.title}`);
    }
  },

  web(args, opts) {
    const root = requireRoot();
    const port = parseInt(opts.port ?? '4400', 10);
    startServer(root, port);
  },

  help() { console.log(HELP); },
};

const argv = process.argv.slice(2);
const { args, opts } = parseArgs(argv);
let cmd = args.shift() ?? 'board';
if (opts.help || cmd === '--help' || cmd === '-h') cmd = 'help';
const handler = commands[cmd];
if (!handler) {
  console.error(paint.red(`unknown command "${cmd}"\n`));
  console.log(HELP);
  process.exit(1);
}
try {
  handler(args, opts);
} catch (err) {
  fail(err.message);
}
