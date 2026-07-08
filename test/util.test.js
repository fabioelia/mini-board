import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, humanAge, fillTemplate, shellQuote, wrap, truncate } from '../src/util.js';

test('parseDuration', () => {
  assert.equal(parseDuration('45m'), 45 * 60_000);
  assert.equal(parseDuration('4h'), 4 * 3_600_000);
  assert.equal(parseDuration('2d'), 2 * 86_400_000);
  assert.equal(parseDuration('1w'), 604_800_000);
  assert.equal(parseDuration('1.5h'), 1.5 * 3_600_000);
  assert.equal(parseDuration('nope'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(undefined), null);
});

test('humanAge', () => {
  assert.equal(humanAge(30_000), 'now');
  assert.equal(humanAge(5 * 60_000), '5m');
  assert.equal(humanAge(3 * 3_600_000), '3h');
  assert.equal(humanAge(2 * 86_400_000), '2d');
});

test('shellQuote escapes single quotes', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('plain'), `'plain'`);
});

test('fillTemplate escapes values and tracks missing', () => {
  const { text, missing } = fillTemplate('claude --resume {{card.session}} -p {{message}}', {
    card: { session: 'sess-1' },
    message: "fix the auth mock; it's flaky",
  });
  assert.equal(text, `claude --resume 'sess-1' -p 'fix the auth mock; it'\\''s flaky'`);
  assert.deepEqual(missing, []);
});

test('fillTemplate reports missing values', () => {
  const { text, missing } = fillTemplate('claude --resume {{card.session}}', { card: {} });
  assert.equal(text, `claude --resume ''`);
  assert.deepEqual(missing, ['card.session']);
});

test('fillTemplate raw: skips escaping', () => {
  const { text } = fillTemplate('open https://x.test/{{raw:card.id}}', { card: { id: 'mb-1' } });
  assert.equal(text, 'open https://x.test/mb-1');
});

test('wrap and truncate', () => {
  assert.deepEqual(wrap('a bb ccc', 4), ['a bb', 'ccc']);
  assert.deepEqual(wrap('abcdefgh', 3), ['abc', 'def', 'gh']);
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
});
