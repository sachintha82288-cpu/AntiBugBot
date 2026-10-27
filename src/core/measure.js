const hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
let segmenter = null;

const graphemeSplit = (text) => {
  if (hasSegmenter) {
    if (!segmenter) segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const out = [];
    for (const part of segmenter.segment(text)) out.push(part.segment);
    return out;
  }
  return Array.from(text);
};

const RANGES = {
  zeroWidth: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g,
  rtlOverride: /[\u202B-\u202E]/g,
  unicodeTags: /[\u{E0000}-\u{E007F}]/gu,
  combining: /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g,
  variation: /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu,
  zwj: /\u200D/g,
  control: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
  surrogatePair: /[\uD800-\uDBFF][\uDC00-\uDFFF]/g
};

const countMatches = (text, re) => {
  if (!text) return 0;
  const scanner = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let count = 0;
  let guard = 0;
  while (guard < 5_000_000) {
    guard += 1;
    const match = scanner.exec(text);
    if (match === null) break;
    count += 1;
    if (scanner.lastIndex === match.index) scanner.lastIndex += 1;
    if (count > 2_000_000) break;
  }
  return count;
};

/**
 * Unpaired surrogate code units: the thing that makes renderers die. Walked by
 * hand because regex engines happily disagree about what is valid UTF-16.
 */
const countUnpaired = (text) => {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      } else {
        count += 1;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      count += 1;
    }
  }
  return count;
};

const longestRun = (text, test) => {
  let best = 0;
  let current = 0;
  for (const char of text) {
    if (test(char)) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
};

export const measureText = (text) => {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const graphemes = graphemeSplit(value);
  const lines = value ? value.split('\n').length : 0;
  const metrics = {
    graphemes: graphemes.length,
    codeUnits: value.length,
    codePoints: Array.from(value).length,
    bytes: Buffer.byteLength(value, 'utf8'),
    lines,
    words: value.trim() ? value.trim().split(/\s+/).length : 0,
    invisible: countMatches(value, RANGES.zeroWidth),
    rtlOverrides: countMatches(value, RANGES.rtlOverride),
    unicodeTags: countMatches(value, RANGES.unicodeTags),
    combiningMarks: countMatches(value, RANGES.combining),
    variationSelectors: countMatches(value, RANGES.variation),
    zwj: countMatches(value, RANGES.zwj),
    controlChars: countMatches(value, RANGES.control),
    astralPairs: countMatches(value, RANGES.surrogatePair),
    maxCombiningStack: longestRun(value, (char) => /[\u0300-\u036F\uFE20-\uFE2F]/.test(char)),
    unpairedSurrogates: 0,
    asciiRatio: 0
  };
  let ascii = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x7f) ascii += 1;
  }
  metrics.asciiRatio = value.length ? Number((ascii / value.length).toFixed(4)) : 0;
  metrics.unpairedSurrogates = countUnpaired(value);
  metrics.invisibleRatio = metrics.graphemes ? Number((metrics.invisible / metrics.graphemes).toFixed(4)) : 0;
  return metrics;
};

export const countedLength = (metrics, mode = 'max') => {
  switch (mode) {
    case 'grapheme':
      return metrics.graphemes;
    case 'utf16':
      return metrics.codeUnits;
    case 'codepoints':
      return metrics.codePoints;
    case 'max':
    default:
      return Math.max(metrics.graphemes, metrics.codeUnits);
  }
};

export const previewText = (text, limit = 120) => {
  const value = String(text ?? '');
  const clean = value
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit) + '…';
};

export default { measureText, countedLength, previewText, graphemeSplit };
