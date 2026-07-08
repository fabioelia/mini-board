// Small shared helpers: time, durations, templating, shell escaping.

export function nowIso() {
  return new Date().toISOString();
}

const DURATION_UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// "45m" | "4h" | "2d" | "1w" -> milliseconds. Returns null for anything else.
export function parseDuration(str) {
  if (typeof str === 'number') return str;
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(String(str ?? '').trim());
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * DURATION_UNITS[m[2]]);
}

// Milliseconds -> compact human age like "3h" / "2d" / "5m".
export function humanAge(ms) {
  if (ms < 60_000) return 'now';
  if (ms < DURATION_UNITS.h) return `${Math.floor(ms / DURATION_UNITS.m)}m`;
  if (ms < DURATION_UNITS.d) return `${Math.floor(ms / DURATION_UNITS.h)}h`;
  if (ms < DURATION_UNITS.w) return `${Math.floor(ms / DURATION_UNITS.d)}d`;
  return `${Math.floor(ms / DURATION_UNITS.w)}w`;
}

// Single-quote shell escaping: it's -> 'it'\''s'
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

// Look up "a.b.c" in a nested object.
export function lookupPath(ctx, path) {
  let cur = ctx;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// Fill {{path.to.value}} placeholders. Values are shell-escaped by default so
// templates must NOT add their own quotes around placeholders. Use
// {{raw:path}} to opt out of escaping (e.g. inside a URL).
export function fillTemplate(template, ctx) {
  const missing = [];
  const out = template.replace(/\{\{\s*(raw:)?([\w.]+)\s*\}\}/g, (_, raw, path) => {
    const val = lookupPath(ctx, path);
    if (val === undefined || val === null || val === '') {
      missing.push(path);
      return raw ? '' : "''";
    }
    return raw ? String(val) : shellQuote(val);
  });
  return { text: out, missing };
}

// Word-wrap to a max width, hard-breaking long tokens.
export function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let word of words) {
    while (word.length > width) {
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export function truncate(text, width) {
  const s = String(text);
  return s.length <= width ? s : s.slice(0, Math.max(0, width - 1)) + '…';
}
