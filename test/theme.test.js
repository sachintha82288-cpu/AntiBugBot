import { test } from 'node:test';
import assert from 'node:assert/strict';
import { box, displayWidth, number, pad, elapsed, rule, truncate, wrapTo, stripAnsi } from '../src/ui/theme.js';

test('displayWidth treats latin as 1 and CJK as 2', () => {
  assert.equal(displayWidth('hello'), 5);
  assert.equal(displayWidth('你好'), 4);
  assert.equal(displayWidth(''), 0);
});

test('pad aligns to a target width', () => {
  assert.equal(displayWidth(pad('abc', 8)), 8);
  assert.equal(pad('abc', 6, 'right'), '   abc');
});

test('truncate respects the mark', () => {
  assert.equal(truncate('hello world', 8), 'hello...');
  assert.equal(truncate('short', 8), 'short');
});

test('wrapTo breaks long lines without losing words', () => {
  const out = wrapTo('alpha beta gamma delta epsilon zeta', 12);
  assert.ok(out.length >= 3);
  for (const line of out) assert.ok(displayWidth(line) <= 12, `too wide: ${line}`);
  assert.equal(out.join(' ').replace(/\s+/g, ' '), 'alpha beta gamma delta epsilon zeta');
});

test('box renders a rectangle where every row is the same width', () => {
  const rendered = box(['first line', 'a much much longer second line'], { title: 'X', ascii: true });
  const lines = rendered.split('\n');
  const widths = lines.map((line) => displayWidth(line));
  assert.equal(new Set(widths).size, 1, `ragged box: ${widths.join(',')}`);
  assert.match(lines[0], /^\+.*\+$/);
  assert.match(lines[lines.length - 1], /^\+.*\+$/);
});

test('box wraps rows that exceed the terminal width', () => {
  const rendered = box(['x'.repeat(400)], { ascii: true });
  for (const line of rendered.split('\n')) assert.ok(displayWidth(line) <= 132);
});

test('rule and helpers are ansi-safe', () => {
  assert.equal(stripAnsi(number(1234567)), '1,234,567');
  assert.equal(number(0), '0');
  assert.equal(elapsed(500), '500ms');
  assert.equal(elapsed(65_000), '1m 05s');
  assert.equal(elapsed(-1), '—');
  assert.ok(rule('hi', { width: 20, color: (t) => t }).includes('hi'));
});
