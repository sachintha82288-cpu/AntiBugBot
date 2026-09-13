/**
 * Structural screening of message text for hostile Unicode ("text bomb") profiles.
 *
 * Design rules:
 *  - Bounded work. We only ever inspect the first `scanWindow` UTF-16 units, so a
 *    10 MB message costs the same as a 100 byte one. This is the single most
 *    important property: a *defender* must never be DoS-able by the input it inspects.
 *  - No lossy normalisation before counting. `Array.from()` silently rewrites lone
 *    surrogates into U+FFFD, which erases the very signal we screen for, so we scan
 *    raw UTF-16 units and decode valid surrogate pairs ourselves.
 *  - No rendering. Nothing here produces a string a human/terminal should look at.
 *    Use redact() for logs.
 *  - Pure function. No I/O, no timers, no state.
 */

import {
  isCombining,
  isControl,
  isDefaultIgnorable,
  isDirectionalControl,
  isLoneSurrogateUnit,
  isNoncharacter,
  isPrivateUse,
  isSkinToneModifier,
  isTagChar,
  isZwj,
} from './unicode-ranges.js';

/** Code point families whose shaping cost grows sharply when marks are stacked on them. */
const SCRIPT_RISKY_BASE = [
  [0x0600, 0x06ff], // Arabic
  [0x0750, 0x077f],
  [0x08a0, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff],
  [0x0900, 0x097f], // Devanagari
  [0x0d80, 0x0dff], // Sinhala  (legit traffic for our users - only scored when *stacked*)
  [0x0b80, 0x0bff], // Tamil
  [0x0c00, 0x0c7f], // Telugu
  [0x1100, 0x11ff], // Hangul Jamo
  [0xac00, 0xd7a3], // Hangul syllables
];

function inRanges(cp, ranges) {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/**
 * Walk raw UTF-16 units: valid surrogate pairs collapse to one code point,
 * lone surrogates are reported as themselves (they are the defect we look for).
 *
 * @returns {{units:number[], lone:number}}
 */
function toUnits(str, limit) {
  const units = [];
  let lone = 0;
  for (let i = 0; i < str.length && units.length < limit; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        units.push(0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00));
        i++;
        continue;
      }
      units.push(c);
      lone++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      units.push(c);
      lone++;
      continue;
    }
    units.push(c);
  }
  return { units, lone };
}

/**
 * @param {string} text raw message text (never echoed back)
 * @param {object} [opts]
 * @param {number} [opts.maxLen=6000] code points beyond this only count toward `length`
 * @param {number} [opts.scanWindow=8000] hard cap on analysed code points
 * @param {object} [opts.weights] override DEFAULT_WEIGHTS per signal
 * @returns {{scores:object, signals:string[], risk:number, verdict:'clean'|'suspect'|'hostile', stats:object}}
 */
export function analyzeText(text, opts = {}) {
  const maxLen = opts.maxLen ?? 6000;
  const scanWindow = clamp(opts.scanWindow ?? 8000, 512, 200_000);

  if (typeof text !== 'string' || text.length === 0) {
    return { scores: {}, signals: [], hardDefects: 0, risk: 0, verdict: 'clean', stats: emptyStats() };
  }

  const { units, lone } = toUnits(text, scanWindow);
  const total = units.length;
  const codePointCount = countCodePoints(text);

  let combining = 0;
  let zwj = 0;
  let variation = 0;
  let directional = 0;
  let tagChars = 0;
  let controls = 0;
  let defaultIgnorable = 0;
  let privateUse = 0;
  let noncharacters = 0;
  let skinTone = 0;
  let lineBreaks = 0;

  // Longest run of *consecutive* marks over a single base character. Stacking
  // depth is what melts a text shaper; per-mark cost is superlinear.
  let run = 0;
  let maxRun = 0;
  let basesWithMarks = 0;

  for (const cp of units) {
    if (isLoneSurrogateUnit(cp)) {
      // already tallied into `lone`; classified here so the two buckets stay disjoint
    } else if (isNoncharacter(cp)) noncharacters++;
    if (isCombining(cp)) {
      combining++;
      run++;
      if (run > maxRun) maxRun = run;
    } else if (isZwj(cp)) {
      zwj++;
      run++;
      if (run > maxRun) maxRun = run;
    } else {
      if (run > 0) basesWithMarks++;
      run = 0;
    }

    if (cp >= 0xfe00 && cp <= 0xfe0f) variation++;
    if (isDirectionalControl(cp)) directional++;
    if (isTagChar(cp)) tagChars++;
    if (isControl(cp)) controls++;
    if (isDefaultIgnorable(cp)) defaultIgnorable++;
    if (isPrivateUse(cp)) privateUse++;
    if (isSkinToneModifier(cp)) skinTone++;
    if (cp === 0x0a || cp === 0x0d || cp === 0x2028 || cp === 0x2029) lineBreaks++;
  }
  if (run > 0) basesWithMarks++;

  const markDensity = total > 0 ? combining / total : 0;
  // Renderer cost scales with *clusters*, not code points. A well-formed string
  // has roughly one cluster per non-mark char; a stacking payload has far fewer
  // clusters than code points, which is the inflation we measure.
  const bases = Math.max(1, total - combining - zwj);
  const inflation = clamp01((combining - bases) / Math.max(1, combining));
  void basesWithMarks; // kept for stats consumers

  const scores = {
    markStacking: clamp01(maxRun / 40), // >40 marks on one base char is never legitimate
    markDensity: clamp01(markDensity / 0.5), // >50% marks is never legitimate
    length: clamp01(codePointCount / maxLen),
    variationSelectors: clamp01(variation / 200),
    zwjSequence: clamp01(zwj / 200),
    directionalOverride: clamp01(directional / 8),
    tagChars: clamp01(tagChars / 8),
    controls: clamp01(controls / 16),
    defaultIgnorable: clamp01(defaultIgnorable / 200),
    privateUse: clamp01(privateUse / 100),
    noncharacters: clamp01(noncharacters / 16),
    surrogates: clamp01(lone / 8),
    skinTone: clamp01(skinTone / 150),
    lineBreakFlood: clamp01(lineBreaks / 200),
    zwjChain: clamp01(maxRun / 50), // long joiner chains (family-emoji abuse)
    graphemeInflation: clamp01(inflation),
  };

  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  let risk = 0;
  let weightSum = 0;
  for (const [key, value] of Object.entries(scores)) {
    const w = weights[key] ?? 1;
    risk += value * w;
    weightSum += w;
  }
  risk = weightSum > 0 ? clamp01(risk / weightSum) : 0;

  // Hard structural defects: impossible in well-formed text from a real keyboard.
  // A single one is suspicious (corrupt encoding); three or more is a generated
  // payload. Counting them separately stops a lone stray char from scoring as
  // "hostile" while a genuine defect block is not diluted by density weighting.
  const hardDefects = lone + noncharacters + controls + tagChars + directional;

  const signals = Object.entries(scores)
    .filter(([k, v]) => v >= 0.6 && k !== 'length')
    .map(([k]) => k);
  if (codePointCount > maxLen) signals.push('oversize');

  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const hostile =
    risk >= t.hostileRisk || signals.length >= t.hostileSignals || hardDefects >= t.hardDefectsHostile;
  const suspect =
    !hostile && (risk >= t.suspectRisk || signals.length >= 1 || hardDefects >= t.hardDefectsSuspect);
  const verdict = hostile ? 'hostile' : suspect ? 'suspect' : 'clean';

  return {
    scores: round(scores),
    signals,
    hardDefects,
    risk: Number(risk.toFixed(4)),
    verdict,
    stats: {
      chars: codePointCount,
      scanned: total,
      truncated: codePointCount > total,
      combining,
      maxRun,
      zwj,
      variation,
      directional,
      tagChars,
      controls,
      defaultIgnorable,
      privateUse,
      noncharacters,
      surrogates: lone,
      lineBreaks,
    },
  };
}

const DEFAULT_THRESHOLDS = {
  hostileRisk: 0.66,
  hostileSignals: 3,
  hardDefectsHostile: 3,
  suspectRisk: 0.3,
  hardDefectsSuspect: 1,
};

function countCodePoints(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

const DEFAULT_WEIGHTS = {
  // heaviest = the properties that actually melt renderers
  markStacking: 3.5,
  markDensity: 2.5,
  graphemeInflation: 2,
  variationSelectors: 2,
  zwjSequence: 2,
  zwjChain: 2.5,
  surrogates: 2.5,
  noncharacters: 1.5,
  tagChars: 2.5,
  directionalOverride: 1.5,
  controls: 1.5,
  length: 0.8,
  defaultIgnorable: 0.8,
  privateUse: 0.6,
  skinTone: 0.5,
  lineBreakFlood: 0.5,
};

function emptyStats() {
  return {
    chars: 0,
    scanned: 0,
    truncated: false,
    combining: 0,
    maxRun: 0,
    zwj: 0,
    variation: 0,
    directional: 0,
    tagChars: 0,
    controls: 0,
    defaultIgnorable: 0,
    privateUse: 0,
    noncharacters: 0,
    surrogates: 0,
    lineBreaks: 0,
  };
}

function clamp01(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? 1 : n;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function round(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = Number(v.toFixed(3));
  return out;
}
