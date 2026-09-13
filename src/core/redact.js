/**
 * Redaction: the ONLY sanctioned way to put message content anywhere a human
 * or a terminal/panel will look at it.
 *
 * Rationale: Pterodactyl renders its live log as HTML. A raw hostile payload
 * written to stdout will freeze/corrupt the *panel*, and a raw payload written
 * to a log file turns your own repo into a malware carrier. Both have bitten
 * real anti-abuse projects. So: structure out, characters in.
 *
 * Why this file walks code points instead of using regex classes: a character
 * class in a JS *regex* consumes exactly four hex digits for `\u`, so the
 * natural-looking `/[\ue000-\ue007f]/` silently parses as `[\ue000-\ue007" "f"]`
 * and `[\ud800\udc00-\ud800\udc7f]` - which matched every high surrogate and
 * deleted all emoji from every log line. Code-point arithmetic makes that class
 * of bug impossible. If you must edit this, run `npm run selfcheck:redact`.
 */

import {
  isCombining,
  isPrivateUse,
  isSkinToneModifier,
  isControl,
  isDefaultIgnorable,
  isDirectionalControl,
  isLoneSurrogateUnit,
  isNoncharacter,
  isTagChar,
  isZwj,
} from './unicode-ranges.js';

const DEFAULT_MAX_CHARS = 140;

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxChars=140]
 * @param {boolean} [opts.keepZwj=true] ZWJ is render-significant (emoji sequences)
 * @param {number} [opts.maxMarksKept=0] how many combining marks to leave in, for triage
 */
export function redact(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const keepZwj = opts.keepZwj !== false;
  const maxMarksKept = opts.maxMarksKept ?? 0;

  let out = '';
  let pending = 0; // collapsed invisible/stacking chars, reported once
  let marksKept = 0;
  let lastWasSpace = out.length === 0;

  const flushPending = () => {
    if (pending > 0) {
      out += `\u22ee${pending > 1 ? `x${pending}` : ''}`; // ⋮ marker, never the raw chars
      pending = 0;
    }
  };

  // Walk UTF-16 units: `for...of` yields scalars, and taking charCodeAt(0) of a
  // scalar hands you the *high surrogate of a valid pair* - which reads as a lone
  // surrogate and silently drops every emoji from the log line. Decode explicitly.
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        const astral = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
        // Every astral class (tags, plane noncharacters, PUA, default-ignorables,
        // skin tones) is encoded as a surrogate pair, so the BMP-only checks below
        // can never see them. Dispatch here or they leak into the log verbatim.
        if (isTagChar(astral) || isNoncharacter(astral) || isDefaultIgnorable(astral) || isPrivateUse(astral)) {
          flushPending();
          out += isTagChar(astral) ? tagLabel(astral) : `<U+${astral.toString(16).toUpperCase()}>`;
          lastWasSpace = false;
          i++;
          if (out.length > maxChars + 24) break;
          continue;
        }
        i++; // valid pair -> one astral code point
        flushPending();
        out += text[i - 1] + text[i];
        lastWasSpace = false;
        if (out.length > maxChars + 24) break;
        continue;
      }
      pending++; // lone high surrogate
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      pending++; // lone low surrogate
      continue;
    }

    const cp = unit;
    const ch = text[i];

    if (isTagChar(cp)) {
      out += tagLabel(cp); // show the smuggled letter, not just the code point
      lastWasSpace = false;
      continue;
    }
    if (isNoncharacter(cp)) {
      out += `<U+${cp.toString(16).toUpperCase()}>`;
      lastWasSpace = false;
      continue;
    }
    if (isControl(cp)) {
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
        if (!lastWasSpace) {
          out += ' ';
          lastWasSpace = true;
        }
        continue;
      }
      out += `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
      lastWasSpace = false;
      continue;
    }
    if (isDirectionalControl(cp)) {
      pending++; // reordering controls are invisible and dangerous: drop, count
      continue;
    }
    if (isPrivateUse(cp) || isSkinToneModifier(cp)) {
      pending++;
      continue;
    }
    if (isZwj(cp)) {
      if (keepZwj) {
        flushPending();
        out += ch;
        lastWasSpace = false;
      } else {
        pending++;
      }
      continue;
    }
    if (isDefaultIgnorable(cp)) {
      pending++;
      continue;
    }
    if (isCombining(cp)) {
      if (marksKept < maxMarksKept) {
        flushPending();
        out += ch;
        marksKept++;
      } else {
        pending++;
      }
      continue;
    }

    if (cp === 0x20 || (cp >= 0x2500 && cp <= 0x25ff)) {
      if (!lastWasSpace) {
        out += ' ';
        lastWasSpace = true;
      }
      continue;
    }

    out += ch;
    lastWasSpace = false;
    if (out.length > maxChars + 24) break; // bounded: never build a giant string
  }

  flushPending();

  const raw = out.trim();
  if (raw.length > maxChars) return `${raw.slice(0, maxChars)}\u2026[+${raw.length - maxChars}c]`;
  return raw;
}

const TAG_OFFSET = 0xe0000; // U+E0041 -> 0x41 'A', U+E0030 -> 0x30 '0' (ASCII, uppercase)

function tagLabel(cp) {
  if (cp === 0xe0001) return '<TAGS>';
  const ascii = cp - TAG_OFFSET;
  if (ascii >= 0x21 && ascii <= 0x7e) return `<TAG:${String.fromCharCode(ascii)}>`;
  return `<U+${cp.toString(16).toUpperCase()}>`;
}

/** Never let an exception message carry raw payload text into the panel log. */
export function safeErrorMessage(err, maxChars = 200) {
  return redact(err?.message ?? String(err ?? ''), { maxChars });
}
