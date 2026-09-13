import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeText } from '../src/core/detector.js';

/**
 * All fixtures here are tiny, synthetic and hand-written. We deliberately do NOT
 * keep real-world payloads in the repo: a test suite that stores the exploit is a
 * leak waiting to happen, and rendering it in a terminal/panel is exactly the
 * failure mode this project exists to prevent.
 *
 * Style rule: never write hostile code points as literals in this file. A raw
 * U+20E0 / U+202E sitting in source *renders* in editors and terminals, and an
 * escape like '\u{fffe}' + 'h' silently becomes a literal char or a syntax error.
 * Always go through cp() so the source stays plain ASCII and greppable.
 */
const cp = (n) => String.fromCodePoint(n);
const CIRCLE = cp(0x20e0); // COMBINING CLOSING CIRCLE ABOVE (classic stacking mark)
const ACUTE = cp(0x0301); // COMBINING ACUTE ACCENT
const ZWJ = cp(0x200d);
const VS16 = cp(0xfe0f); // VARIATION SELECTOR-16
const RLO = cp(0x202e); // RIGHT-TO-LEFT OVERRIDE
const TAG_A = cp(0xe0041); // invisible TAG LATIN SMALL LETTER A
const LONE_HI = '\ud83d'; // unpaired high surrogate (valid UTF-16 unit, invalid scalar)
const LONE_LO = '\udc00'; // unpaired low surrogate
const NONCHAR_FFFE = cp(0xfffe);
const ASTRAL_NONCHAR = cp(0x1fffe); // plane-1 noncharacter - the & 0x7ff case

// Sinhala is legitimate high-risk-looking traffic for our users, so it is
// spelled with explicit escapes + the ZWJ constant: the source file stays pure
// ASCII, and no control character can ever be committed as a raw literal.
const SINHALA_OK = '\u0dc3\u0dca\u0dba \u0db4\u0dd0\u0dd2\u0db8\u0dca \u0dc3\u0db8\u0dca' + ZWJ + '\u0db8\u0dca!';

test('clean everyday traffic stays clean (no false positives on real scripts)', () => {
  // U+1F7FF is a deliberate near-miss: it shares the low 11 bits (0x7FF) with the
  // plane-1 noncharacters U+1FFFE/U+1FFFF, so a `& 0xff` style check is wrong in
  // *both* directions here.
  const natural = [
    'machine hello bro \u{1f602}',
    SINHALA_OK,
    '\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064a\u0643\u0645', // Arabic
    '\u0928\u092e\u0938\u094d\u0924\u0947', // Devanagari, has a conjunct
    `\u{1f469}\u{1f3fd}${ZWJ}\u{1f469}\u{1f3fb}${ZWJ}\u{1f466}${ZWJ}\u{1f466} family emoji`,
    'mixed: na\u00efve caf\u00e9 r\u00e9sum\u00e9',
    `a${cp(0x1f1e6)}${cp(0x1f1e8)}b`, // regional indicators
    cp(0x1f7ff),
    'a' + ZWJ + ZWJ + ZWJ,
  ];
  for (const text of natural) {
    const r = analyzeText(text);
    assert.equal(
      r.verdict,
      'clean',
      `expected clean, got ${r.verdict} signals=${r.signals} scores=${JSON.stringify(r.scores)} for ${JSON.stringify(text)}`,
    );
    assert.ok(r.risk < 0.3, `risk too high: ${r.risk} for ${JSON.stringify(text)}`);
  }
});

test('detects mark stacking on a single base character', () => {
  const text = 'a' + CIRCLE.repeat(60) + ACUTE.repeat(30);
  const r = analyzeText(text);
  assert.equal(r.verdict, 'hostile');
  assert.ok(r.scores.markStacking > 0.9);
  assert.ok(r.stats.maxRun > 80);
});

test('detects variation-selector padding', () => {
  const r = analyzeText('\u2764' + VS16.repeat(300));
  assert.notEqual(r.verdict, 'clean');
  assert.ok(r.scores.variationSelectors > 0.9);
});

test('detects ZWJ sequence abuse', () => {
  const r = analyzeText(ZWJ.repeat(250));
  assert.equal(r.verdict, 'hostile');
  assert.ok(r.signals.includes('zwjSequence'));
  assert.ok(r.scores.zwjChain > 0.9, JSON.stringify(r.scores));
});

test('detects directional overrides used for reversed-text spoofs', () => {
  const r = analyzeText(`${RLO}em4321 gninigeb${RLO}`);
  assert.notEqual(r.verdict, 'clean', `signals=${r.signals} risk=${r.risk}`);
  assert.equal(r.stats.directional, 2);
  assert.ok(r.scores.directionalOverride >= 0.25, JSON.stringify(r.scores));
});

test('detects invisible tag-character smuggling', () => {
  const r = analyzeText('hi' + TAG_A.repeat(12) + 'there');
  assert.equal(r.stats.tagChars, 12);
  assert.ok(r.signals.includes('tagChars'), `signals=${r.signals}`);
  assert.notEqual(r.verdict, 'clean');
});

test('flags oversize-only messages as suspect, not hostile (content may be harmless)', () => {
  const r = analyzeText('a'.repeat(20_000), { maxLen: 6000 });
  assert.equal(r.verdict, 'suspect');
  assert.ok(r.signals.includes('oversize'));
  assert.equal(r.scores.markStacking, 0);
  assert.equal(r.hardDefects, 0);
});

test('work is bounded regardless of input size (defender must not be DoS-able)', () => {
  const huge = 'a' + CIRCLE.repeat(400_000);
  const t0 = process.hrtime.bigint();
  const r = analyzeText(huge, { scanWindow: 8000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.stats.scanned, 8000);
  assert.equal(r.stats.truncated, true);
  assert.equal(r.verdict, 'hostile');
  assert.ok(ms < 400, `analysis took ${ms}ms for a 400k-code-point payload`);
});

test('lone surrogates survive classification (no lossy Array.from before counting)', () => {
  const r = analyzeText(`x${LONE_HI}y${LONE_HI}z${LONE_LO}w`);
  assert.equal(r.stats.surrogates, 3);
  assert.equal(r.stats.noncharacters, 0, 'surrogates must not be double-counted as noncharacters');
  assert.equal(r.hardDefects, 3);
  assert.equal(r.verdict, 'hostile', `verdict=${r.verdict} risk=${r.risk} signals=${r.signals}`);
});

test('a single stray defect is suspect, not hostile (corrupt encodings exist)', () => {
  const r = analyzeText(`hello ${LONE_HI} world`);
  assert.equal(r.hardDefects, 1);
  assert.equal(r.verdict, 'suspect');
});

test('regression: astral noncharacters detected (the & 0xff vs & 0x7ff bug)', () => {
  const r = analyzeText(`a${ASTRAL_NONCHAR}b${cp(0x2ffff)}c${NONCHAR_FFFE}d`);
  assert.equal(r.stats.noncharacters, 3, JSON.stringify(r.stats));
  assert.equal(r.hardDefects, 3);
  assert.equal(r.verdict, 'hostile');
});

test('regression: real emoji are not flagged as noncharacters or private use', () => {
  for (const s of ['\u{1f600}', '\u{1f7ff}', '\u{1f7f0}', cp(0x1f9d1) + ZWJ + cp(0x1f91d) + ZWJ + cp(0x1f9d1)]) {
    const r = analyzeText(s);
    assert.equal(r.stats.noncharacters, 0, `nonchar-flagged ${JSON.stringify(s)}`);
    assert.equal(r.stats.privateUse, 0, `PUA-flagged ${JSON.stringify(s)}`);
    assert.equal(r.verdict, 'clean', `verdict=${r.verdict} signals=${r.signals} for ${JSON.stringify(s)}`);
  }
});

test('thresholds and weights are injectable (needed to tune without redeploying)', () => {
  // note: the injected thresholds here are deliberately absurd (hostileRisk 0.01)
  // - we are asserting that config reaches the verdict, not that the values are sane
  const text = 'a' + CIRCLE.repeat(30);
  assert.equal(analyzeText(text, { thresholds: { hostileRisk: 0.99, hostileSignals: 9, hardDefectsHostile: 99, suspectRisk: 0.9, hardDefectsSuspect: 99 } }).verdict, 'suspect');
  assert.equal(
    analyzeText(text, { thresholds: { hostileRisk: 0.01, hostileSignals: 99, hardDefectsHostile: 99, suspectRisk: 0, hardDefectsSuspect: 0 } })
      .verdict,
    'hostile',
  );
});

test('empty and non-string input are handled without throwing', () => {
  for (const v of ['', undefined, null, 0, {}, []]) {
    assert.equal(analyzeText(v).verdict, 'clean');
    assert.equal(analyzeText(v).hardDefects, 0);
  }
});
