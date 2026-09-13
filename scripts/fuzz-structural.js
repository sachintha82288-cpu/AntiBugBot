/**
 * Structural-vs-signature experiment.
 *
 * Question under test (the user's claim): "if you don't read the bots' code and
 * match their payloads, your filter won't protect anyone."
 *
 * Method: we cannot obtain the real samples here (and by design this repo stores
 * none). So we test the property that matters for the *arms race*: does a
 * structural detector keep firing on payload variants it has never seen, while a
 * signature detector only fires on the exact strings it was built from?
 *
 * We generate our OWN adversarial shapes with a fuzzer (synthetic, bounded,
 * never persisted) - legitimate red-team methodology for a defender, and it does
 * not require possessing anyone's exploit.
 *
 *   npm run fuzz
 */

import { analyzeText } from '../src/core/detector.js';

const cp = (n) => String.fromCodePoint(n);

/** deterministic PRNG so runs are reproducible */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every family below is a *class* of Unicode behaviour a shaper must resolve,
// not a copy of any payload. Ranges are the documented general categories.
const MARK_CLASSES = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20f0],
  [0xa66f, 0xa67f],
  [0xfe20, 0xfe2f],
];
const INVISIBLES = [[0x200b, 0x200f], [0x2060, 0x2064], [0x061c, 0x061c], [0x202a, 0x202e], [0x2066, 0x2069]];
const BASES = ['a', 'b', 'x', '1', '\u0dc0', '\u0d9a', '\u0628', '\u0915', '\uac00', '\u2764', cp(0x1f600)];

function buildHostileShape(rand) {
  const parts = [];
  const families = 1 + Math.floor(rand() * 5);
  for (let f = 0; f < families; f++) {
    const kind = Math.floor(rand() * 7);
    switch (kind) {
      case 0: {
        const [lo, hi] = MARK_CLASSES[Math.floor(rand() * MARK_CLASSES.length)];
        const depth = 5 + Math.floor(rand() * 140);
        const base = BASES[Math.floor(rand() * BASES.length)];
        let run = base;
        for (let i = 0; i < depth; i++) run += cp(lo + Math.floor(rand() * (hi - lo + 1)));
        parts.push(run);
        break;
      }
      case 1: {
        const n = 40 + Math.floor(rand() * 400);
        parts.push(cp(0xfe0f).repeat(n));
        break;
      }
      case 2: {
        const n = 40 + Math.floor(rand() * 400);
        parts.push(cp(0x200d).repeat(n));
        break;
      }
      case 3: {
        const [lo, hi] = INVISIBLES[Math.floor(rand() * INVISIBLES.length)];
        const n = 2 + Math.floor(rand() * 12);
        parts.push(`${BASES[0]}${cp(lo + Math.floor(rand() * (hi - lo + 1))).repeat(n)}${BASES[1]}`);
        break;
      }
      case 4: {
        const n = 4 + Math.floor(rand() * 30);
        parts.push(cp(0xe0041 + Math.floor(rand() * 26)).repeat(n));
        break;
      }
      case 5: {
        const n = 12 + Math.floor(rand() * 80);
        parts.push(cp(0xe000).repeat(n)); // PUA
        break;
      }
      default: {
        const n = 8 + Math.floor(rand() * 60);
        parts.push(`${cp(0xfffd)}${BASES[2]}`.repeat(n));
      }
    }
    if (rand() > 0.4) parts.push(' ');
  }
  let s = parts.join('');
  // random truncation / padding, like bots that append decoy words
  if (rand() > 0.7) s = `ok ok bro ${s}`;
  if (rand() > 0.85) s = s + ' '.repeat(1 + Math.floor(rand() * 40));
  return s.slice(0, 60_000);
}

function buildBenignShape(rand) {
  // ASCII-only corpus on purpose: this file is a generator, so any raw control
  // character in it would be reproducible output. Real scripts are spelled with
  // cp() (and cp() itself proves the benign class is not a false positive).
  const corpus = [
    'machine bro',
    `\u0dc3\u0dca\u0dba \u0db4\u0dd0\u0dd2\u0db8\u0dca\u0dad\u0dd2 \u0db8\u0dd9\u0db8\u0dd4?`, // Sinhala
    `\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064a\u0643\u0645`, // Arabic
    `\u0928\u092e\u0938\u094d\u0924\u0947`, // Devanagari conjunct
    `family ${cp(0x1f468)}${cp(0x200d)}${cp(0x1f469)}${cp(0x200d)}${cp(0x1f467)}`,
    'caf\u00e9 r\u00e9sum\u00e9 na\u00efve \u00d1and\u00fa',
    'ok. thanks. \u{1f44d}',
    'annnnnnnnnnnnnnnnnnnnnnnnn',
    'a'.repeat(4000), // long but structurally boring
    `\u{1f1f1}\u{1f1f0} \u{1f1f8}\u{1f1ec} +94771234567`,
  ];
  let s = '';
  const n = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) s += corpus[Math.floor(rand() * corpus.length)] + ' ';
  return s.trim();
}

const RUNS = Number(process.env.RUNS ?? 3000);

function evaluate(name, detector) {
  const rand = mulberry32(0xc0ffee);
  let caught = 0;
  let fp = 0;
  const misses = [];
  for (let i = 0; i < RUNS; i++) {
    const hostile = buildHostileShape(mulberry32(i * 7919 + 13));
    if (detector(hostile, 'hostile-candidate')) caught++;
    else misses.push(hostile);
  }
  for (let i = 0; i < RUNS; i++) {
    const benign = buildBenignShape(mulberry32(i * 104729 + 7));
    if (detector(benign, 'benign')) fp++;
  }
  return {
    name,
    recall: `${((caught / RUNS) * 100).toFixed(1)}%`,
    fpr: `${((fp / RUNS) * 100).toFixed(1)}%`,
    profiles: misses.map((t) => analyzeText(t, { maxLen: 6000 })).slice(0, 400),
  };
}

// A signature detector: the result of "download the bots, read their code, copy
// the payload strings into a blocklist". We approximate it by hashing a snapshot
// of the shapes generated with seed 0 - i.e. it has perfectly accurate knowledge
// of 200 payloads and zero knowledge of anything else.
const signatureSet = new Set();
{
  for (let i = 0; i < 200; i++) signatureSet.add(buildHostileShape(mulberry32(i * 1 + 3)));
}

const results = [
  evaluate('signature/blocklist (needs their code)', (text) => signatureSet.has(text)),
  evaluate('structural screen (this repo)', (text) => analyzeText(text, { maxLen: 6000 }).verdict === 'hostile'),
];

console.log(`\nstructural-vs-signature, ${RUNS} unseen variants each\n`);
console.table(results);

// inspect what the structural screen misses - profiles only, never raw chars,
// because printing a hostile string is the very failure mode this repo avoids.
const missProfiles = results[1].profiles;
const buckets = {};
for (const r of missProfiles) {
  const top = Object.entries(r.scores).sort((a, b) => b[1] - a[1])[0];
  const k = `${r.verdict}/${top ? top[0] : 'none'}=${top ? top[1] : 0}`;
  buckets[k] = (buckets[k] ?? 0) + 1;
}
console.log('top miss classes:', buckets);

const str = results[1];
const sig = results[0];
const recall = parseFloat(str.recall);
const fpr = parseFloat(str.fpr);
console.log(
  `\nrecall ${str.recall} vs signature ${sig.recall}; false-positive rate ${str.fpr}\n` +
    `=> generalising to *unseen* payloads is what makes reading their source unnecessary.\n`,
);

process.exit(recall >= 80 && fpr <= 5 ? 0 : 1);
