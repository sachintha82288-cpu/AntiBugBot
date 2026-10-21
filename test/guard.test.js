import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, evaluateText, extraPayloadLength } from '../src/core/guard.js';
import { extractText, vcardLength } from '../src/core/incident.js';

const base = { threshold: 2000, countMode: 'max', heuristics: true };

test('the 2000 character rule is the requirement: >2000 fires, ==2000 does not', () => {
  assert.equal(evaluateText('x'.repeat(2000), base).triggered, false);
  const over = evaluateText('x'.repeat(2001), base);
  assert.equal(over.triggered, true);
  assert.equal(over.primary, 'oversize');
  assert.equal(over.counted, 2001);
});

test('threshold and count mode are configurable', () => {
  assert.equal(evaluateText('x'.repeat(100), { ...base, threshold: 50 }).triggered, true);
  const emoji = '👍'.repeat(1200);
  assert.equal(evaluateText(emoji, { ...base, countMode: 'grapheme' }).triggered, false);
  assert.equal(evaluateText(emoji, { ...base, countMode: 'utf16' }).triggered, true);
});

test('heuristics can be switched off for length-only policing', () => {
  const payload = 'a\u{E0041}'.repeat(30);
  assert.equal(evaluateText(payload, base).triggered, true);
  assert.equal(evaluateText(payload, { ...base, heuristics: false }).triggered, false);
});

test('each rule has a label, detail and severity', () => {
  for (const rule of RULES) {
    assert.ok(rule.id && rule.label && typeof rule.severity === 'number');
    assert.equal(typeof rule.test, 'function');
    assert.equal(typeof rule.detail, 'function');
  }
});

test('zero-width inflation trips its own rule', () => {
  const result = evaluateText('real text' + '\u200b'.repeat(500), base);
  assert.ok(result.rules.some((rule) => rule.id === 'invisible-inflation'));
});

test('zwj bomb and bidi override spam trip their rules', () => {
  assert.ok(evaluateText('\u{1F468}\u200D'.repeat(300), base).rules.some((r) => r.id === 'zwj-bomb'));
  assert.ok(evaluateText('a\u202e'.repeat(10), base).rules.some((r) => r.id === 'bidi-override'));
});

test('extraLength carries payloads that have no text body, like vcard bombs', () => {
  const decision = evaluateText('', { ...base, extraLength: 2500 });
  assert.equal(decision.triggered, true);
  assert.equal(decision.counted, 2500);
  const message = { contactMessage: { vcard: 'BEGIN:VCARD\n' + 'A'.repeat(3000) + '\nEND:VCARD' } };
  assert.ok(vcardLength(message) > 3000);
});

test('text extraction sees conversation, captions and nested wrappers', () => {
  assert.deepEqual(extractText({ conversation: 'hi' }), { text: 'hi', kind: 'conversation' });
  assert.equal(extractText({ imageMessage: { caption: 'look' } }).text, 'look');
  assert.equal(extractText({ videoMessage: { caption: 'motion' } }).text, 'motion');
  const unwrapped = extractText({ viewOnceMessageV2: { message: { extendedTextMessage: { text: 'hidden' } } } });
  assert.equal(unwrapped.text, 'hidden');
  const ephemeral = extractText({ ephemeralMessage: { message: { conversation: 'disappearing' } } });
  assert.equal(ephemeral.text, 'disappearing');
  assert.equal(extractText({ audioMessage: { seconds: 3 } }).text, '', 'voice notes carry no scannable body');
});

test('COUNT_PAYLOAD adds repeated field text to the measured size', () => {
  const message = {
    imageMessage: { caption: 'x'.repeat(700), formattedCaption: 'x'.repeat(700), title: 'x'.repeat(700) },
    contextInfo: { forwardingScore: 3 }
  };
  assert.equal(extraPayloadLength(message, { countPayload: true }), 1400, 'primary caption is not double counted');
  assert.equal(extraPayloadLength(message, { countPayload: false }), 0);
  assert.equal(extraPayloadLength(null, { countPayload: true }), 0);
  const decision = evaluateText('x'.repeat(700), {
    threshold: 2000, countMode: 'max', heuristics: true, extraLength: extraPayloadLength(message, { countPayload: true })
  });
  assert.equal(decision.counted, 2100);
  assert.equal(decision.triggered, true);
});

test('clean chat does not light up the shield', () => {
  const result = evaluateText('hey, still meeting at 7? I will bring the files', base);
  assert.equal(result.triggered, false);
  assert.equal(result.rules.length, 0);
  assert.equal(result.risk, 0);
});
