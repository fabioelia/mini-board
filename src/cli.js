#!/usr/bin/env node
// mini-board CLI — `mb <command>`. Run `mb help` for the full list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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
import {
  resolveConnectors, checkConnectors, verifyClaude, missingEnv,
} from './connectors.js';
import { boardSources, runPull, harvestPulls } from './sources.js';
import { runTriage, harvestTriage } from './triage.js';
import { harvestEnrich } from './surface.js';
import { applyFlow } from './flow.js';
import { runJiraSync, harvestJiraSync } from './jira.js';

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
  mb connect [id]                  connector tiles: status, or set one up
       --check                     re-probe claude CLI + MCP servers
       claude --verify             prove Claude auth works with a real (tiny) run
  mb sources                       list the board's sources and their last runs
  mb pull [source]                 run source prompt(s) through Claude; ingest JSON cards
       --bg --dry-run              background / just print the command
  mb triage [--dry-run]            smart-place cards: an agent checks live PR/ticket
                                   state and moves cards to the lane they belong in
  mb jira [--dry-run]              mirror Jira: issues → cards, statuses → lanes
  mb sessions                      every Claude session across all cards
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

// Pick up anything background runs left behind: Claude session ids from agent
// logs, and finished source pulls.
function harvest(root, board, state) {
  const { found: sessions, completed } = harvestSessions(root, state);
  const flowMoves = applyFlow(root, board, state, completed);
  const pulls = harvestPulls(root, board, state);
  const triage = harvestTriage(root, board, state);
  const enriched = harvestEnrich(root, board, state);
  const jira = harvestJiraSync(root, board, state);
  if (sessions || flowMoves.length || pulls.length || triage || enriched || jira) saveState(root, state);
  if (jira) {
    console.log(jira.ok ? paint.dim(`jira sync finished: ${jira.summary}`) : paint.red(`jira sync failed: ${jira.error}`));
  }
  for (const m of flowMoves) {
    console.log(m.paused
      ? paint.red(`flow: ${m.id} paused — ${m.reason}`)
      : paint.dim(`flow: ${m.id} → ${m.to}`));
  }
  for (const p of pulls) {
    console.log(
      p.ok
        ? paint.dim(`source "${p.source}" finished: ${p.summary}`)
        : paint.red(`source "${p.source}" failed: ${p.error}`),
    );
  }
  if (triage) {
    console.log(triage.ok
      ? paint.dim(`triage finished: ${triage.summary}`)
      : paint.red(`triage failed: ${triage.error}`));
    for (const m of triage.moved ?? []) {
      console.log(paint.dim(`  ${m.id} → ${m.to}${m.reason ? ` (${m.reason})` : ''}`));
    }
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
    console.log('Next steps:');
    console.log('  mb connect            wire up Claude + the Slack/Atlassian/Drive MCP tiles');
    console.log('  mb pull               run the example sources in board.yml (edit them first)');
    console.log('  mb add "A card"       or just add cards by hand');
    console.log('  mb web                the drag-and-drop board (setup tiles included)');
  },

  board() {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    harvest(root, board, state);
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
    harvest(root, board, state);
    const { id, card } = requireCard(state, args[0]);
    console.log(renderCard(board, id, card));
  },

  attention() {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    harvest(root, board, state);
    console.log(renderAttention(board, state));
  },
  todo(...a) { return commands.attention(...a); },

  async sync(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    harvest(root, board, state);
    const syncOpts = { autoMove: !opts.no_move };
    const results = args[0]
      ? [await syncCard(board, state, requireCard(state, args[0]).id, syncOpts)]
      : await syncAll(board, state, syncOpts);
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

  async connect(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    const connectors = resolveConnectors(board);
    const id = args[0];

    if (id) {
      const conn = connectors.find((c) => c.id === id);
      if (!conn) fail(`unknown connector "${id}" — tiles: ${connectors.map((c) => c.id).join(', ')}`);

      if (conn.id === 'claude' && opts.verify) {
        console.log('running a tiny headless claude call to verify auth…');
        const res = await verifyClaude();
        if (res.ok) {
          state.connectors ??= {};
          state.connectors.claude = { ...state.connectors.claude, verified: nowIso() };
          // re-probe so the stored status (connected/detail) reflects the verify
          state.connectors = { ...state.connectors, ...(await checkConnectors(board, state)) };
          saveState(root, state);
          console.log(paint.bold('✓ Claude auth works') + paint.dim(` (session ${res.session ?? '?'})`));
        } else {
          fail(`Claude auth failed: ${res.detail}`);
        }
        return;
      }

      console.log(`${paint.bold(conn.title)} — ${conn.description}`);
      const missing = missingEnv(conn);
      if (!conn.setup) {
        console.log(conn.instructions ?? 'no setup command — configure it manually');
      } else if (missing.length) {
        console.log(paint.red(`missing env: ${missing.join(', ')}`));
        console.log(`setup (run it yourself once the env is exported):\n  ${conn.setup}`);
        if (conn.instructions) console.log(paint.dim(conn.instructions));
      } else {
        console.log(paint.dim(`running: ${conn.setup}`));
        const res = spawnSync('/bin/sh', ['-c', conn.setup], { encoding: 'utf8', timeout: 120_000 });
        process.stdout.write(res.stdout ?? '');
        process.stderr.write(res.stderr ?? '');
        if (res.status !== 0) fail(`setup exited ${res.status}`);
        if (conn.instructions) console.log(paint.dim(conn.instructions));
      }
      // fall through to a re-check so the tile status is fresh
    }

    const statuses = await checkConnectors(board, state);
    state.connectors = { ...state.connectors, ...statuses };
    saveState(root, state);
    console.log(paint.bold('Connectors:'));
    for (const c of connectors) {
      const s = state.connectors[c.id] ?? {};
      const dot = s.connected ? paint.green('●') : s.configured ? paint.yellow('◐') : paint.dim('○');
      console.log(`  ${dot} ${c.id.padEnd(10)} ${c.title.padEnd(18)} ${paint.dim(s.detail ?? 'unchecked')}`);
      if (!s.configured) console.log(paint.dim(`      → mb connect ${c.id}`));
    }
  },

  sources() {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    harvest(root, board, state);
    const sources = boardSources(board);
    if (!sources.length) {
      console.log('no sources in board.yml — add a `sources:` section (see templates/board.yml) or use the web UI');
      return;
    }
    console.log(paint.bold('Sources') + paint.dim(' (mb pull [id] runs them):'));
    for (const s of sources) {
      const run = state.sources?.[s.id];
      const status = run?.last_status === 'ok' ? paint.green(run.last_summary ?? 'ok')
        : run?.last_status === 'running' ? paint.yellow('running…')
        : run?.last_status === 'error' ? paint.red(run.last_summary ?? 'error')
        : paint.dim('never run');
      console.log(`  ${paint.bold(s.id)} ${s.title}${s.enabled ? '' : paint.dim(' (disabled)')}`);
      console.log(`      "${s.prompt}"`);
      console.log(`      tools: ${s.tools.join(', ') || 'none'} · → ${s.column} · ${status}${run?.last_run ? paint.dim(` (${run.last_run})`) : ''}`);
    }
  },

  pull(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    harvest(root, board, state);
    const sources = boardSources(board).filter((s) => s.enabled);
    const targets = args[0] ? sources.filter((s) => s.id === args[0]) : sources;
    if (args[0] && !targets.length) fail(`no source "${args[0]}" — sources: ${boardSources(board).map((s) => s.id).join(', ')}`);
    if (!targets.length) fail('no sources configured — add a `sources:` section to board.yml');
    for (const source of targets) {
      const res = runPull(root, board, state, source.id, { background: !!opts.bg, dryRun: !!opts.dry_run });
      if (res.dryRun) {
        console.log(paint.bold(source.id) + paint.dim(' would run:'));
        console.log(`  ${res.cmd.slice(0, 400)}${res.cmd.length > 400 ? '…' : ''}`);
      } else if (res.background) {
        console.log(`${paint.bold(source.id)} pulling in background ${paint.dim(`→ ${res.log} (finishes on next mb board/sync)`)}`);
      } else if (res.ok) {
        console.log(`${paint.bold(source.id)} ${res.summary}${res.created.length ? ` — ${res.created.join(', ')}` : ''}`);
      } else {
        console.log(`${paint.bold(source.id)} ${paint.red(res.error)}`);
        if (res.tail) console.log(paint.dim(`  ${res.tail.split('\n').slice(-4).join('\n  ')}`));
      }
    }
    saveState(root, state);
  },

  triage(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    harvest(root, board, state);
    const res = runTriage(root, board, state, { dryRun: !!opts.dry_run });
    saveState(root, state);
    if (res.dryRun) {
      console.log(paint.dim(`would triage ${res.candidates.length} card(s): ${res.candidates.join(', ')}`));
      console.log(paint.dim(`  ${res.cmd.slice(0, 300)}…`));
    } else if (res.empty) {
      console.log(res.summary);
    } else if (res.background) {
      console.log(`triage running in background on ${res.candidates.length} card(s) ${paint.dim(`→ ${res.log} (finishes on next mb board)`)}`);
    } else if (!res.ok) {
      fail(res.error);
    }
  },

  jira(args, opts) {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    harvest(root, board, state);
    const res = runJiraSync(root, board, state, { dryRun: !!opts.dry_run });
    saveState(root, state);
    if (res.dryRun) console.log(paint.dim(`would run: ${res.cmd.slice(0, 300)}…`));
    else if (res.background) console.log(`jira sync running in background ${paint.dim(`→ ${res.log} (finishes on next mb board)`)}`);
    else if (!res.ok) fail(res.error);
  },

  sessions() {
    const root = requireRoot();
    const board = loadBoard(root);
    const state = loadState(root);
    harvest(root, board, state);
    let total = 0;
    for (const [id, card] of Object.entries(state.cards)) {
      if (!card.sessions?.length) continue;
      total += card.sessions.length;
      console.log(`${paint.bold(id)} ${card.title} ${paint.dim(`[${card.column}]`)}`);
      card.sessions.forEach((s, i) => {
        const latest = i === card.sessions.length - 1;
        console.log(`  ${latest ? '→' : ' '} ${paint.cyan(s.id)} ${paint.dim(`${s.label ?? ''} ${s.at ?? ''}`)}`);
      });
    }
    console.log(total
      ? paint.dim(`${total} session(s). "→" is what mb comment --fire resumes.`)
      : 'no Claude sessions yet — mb agent <card> starts one');
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
  await handler(args, opts);
} catch (err) {
  fail(err.message);
}
