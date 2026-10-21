import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countedLength, measureText, previewText } from '../src/core/measure.js';

test('counts graphemes as single characters for emoji clusters', () => {
  const metrics = measureText('👨‍👩‍👧‍👦ok');
  assert.equal(metrics.graphemes, 3, 'family emoji is one grapheme, plus o and k');
  assert.ok(metrics.codeUnits > metrics.graphemes, 'utf16 units inflate the count');
});

test('invisible characters are counted separately', () => {
  const metrics = measureText('abc\u200b\u200b\u200e\u202e');
  assert.equal(metrics.graphemes, 7);
  assert.equal(metrics.invisible, 4);
  assert.equal(metrics.rtlOverrides, 1);
  assert.equal(metrics.invisibleRatio > 0.5, true);
});

test('unicode tag block payload is detected', () => {
  const metrics = measureText('a\u{E0041}\u{E0042}\u{E0043}\u{E0044}');
  assert.equal(metrics.unicodeTags, 4);
});

test('control characters and unpaired surrogates are flagged', () => {
  assert.equal(measureText('a\u0001b\u0002c\u0003').controlChars, 3);
  assert.equal(measureText('x\uD83Dy').unpairedSurrogates, 1, 'lone high surrogate');
  assert.equal(measureText('a\uDC00b').unpairedSurrogates, 1, 'lone low surrogate');
  assert.equal(measureText('👍👍👍').unpairedSurrogates, 0, 'valid pairs are not a payload');
  assert.equal(measureText('👍'.repeat(400)).graphemes, 400);
});

test('combining stacks and lines are measured', () => {
  const metrics = measureText('a' + '\u0301'.repeat(70) + '\nb\nc');
  assert.equal(metrics.maxCombiningStack, 70);
  assert.equal(metrics.lines, 3);
});

test('countedLength honours the mode', () => {
  const metrics = measureText('👍👍');
  assert.equal(countedLength(metrics, 'grapheme'), 2);
  assert.equal(countedLength(metrics, 'utf16'), 4);
  assert.equal(countedLength(metrics, 'max'), 4);
  assert.equal(countedLength(metrics, 'codepoints'), 2);
});

test('preview collapses whitespace and marks invisible chars', () => {
  const preview = previewText('hi   there\n\u200bbogus', 40);
  assert.equal(preview, 'hi there ·bogus');
});

test('empty input is safe', () => {
  const metrics = measureText('');
  assert.equal(metrics.graphemes, 0);
  assert.equal(metrics.bytes, 0);
  assert.equal(metrics.asciiRatio, 0);
});
