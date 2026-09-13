/**
 * Structural ranges used by hostile Unicode payloads.
 *
 * IMPORTANT: this module only *classifies* code points. It contains no payload,
 * no generators and no way to emit a message. Do not add any.
 */

/** Code point is a default-ignorable / never-render character. */
export function isDefaultIgnorable(cp) {
  if (isTagChar(cp)) return false; // tallied in its own bucket; avoid double counting
  return (
    cp === 0x00ad || // SOFT HYPHEN
    cp === 0x200b || // ZERO WIDTH SPACE
    (cp >= 0x2060 && cp <= 0x2064) || // WORD JOINER .. FUNCTION APPLICATION
    (cp >= 0xe0000 && cp <= 0xe0fff) // TAGS, VARIATION SELECTOR-15/16, SUPP PRIVATE PLANE B
  );
}

/** C0/C1 control characters and other raw-binary leakage markers. */
export function isControl(cp) {
  return cp <= 0x001f || (cp >= 0x007f && cp <= 0x009f);
}

/** Combining marks, incl. the emoji ZWJ sequence and the `U+FE20..U+FE2F` ligature-block range. */
export function isCombining(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // COMBINING DIACRITICAL MARKS
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0x2cef && cp <= 0x2cf1) ||
    (cp >= 0xa66f && cp <= 0xa67f) ||
    (cp >= 0xa8e0 && cp <= 0xa8f1) ||
    (cp >= 0xd7b0 && cp <= 0xd7c6) || // HANGUL JUNGSEONG (filler abuse)
    (cp >= 0xfb1e && cp <= 0xfb1e) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // VARIATION SELECTORS-1..16
    (cp >= 0xfe20 && cp <= 0xfe2f) // COMBINING LIGATURE / HALF MARKS
  );
}

/** Zero-Width Joiner. */
export function isZwj(cp) {
  return cp === 0x200d;
}

/**
 * Explicit script *controls* (RTL/LTR overrides) plus invisible directional isolates.
 * Used for reversed-text spoofing. This does NOT include legitimate RTL text.
 */
export function isDirectionalControl(cp) {
  return (
    (cp >= 0x061c && cp <= 0x061c) || // ARABIC LETTER MARK
    (cp >= 0x200e && cp <= 0x200f) || // LRM / RLM
    (cp >= 0x202a && cp <= 0x202e) || // LRE RLE PDF LRO RLO
    (cp >= 0x2066 && cp <= 0x2069) // LRI RLI FSI PDI
  );
}

/** Unicode TAG characters (U+E0020..U+E007F) - invisibly smuggle arbitrary data. */
export function isTagChar(cp) {
  return cp >= 0xe0020 && cp <= 0xe007f;
}

/** Private Use Area code points - typical of garbled/corrupted payloads. */
export function isPrivateUse(cp) {
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd)
  );
}

/**
 * Noncharacters / replacement chars / object replacement (rendered as boxes).
 *
 * Per Unicode the noncharacters satisfy `plane.code & 0xFFFE == 0xFFFE`, i.e. the
 * *low 11 bits*, not the low byte. Using `& 0xff` here silently disabled the
 * astral-plane check and would have missed payloads built from U+1FFFE/U+2FFFE.
 *
 * Surrogates are NOT counted here on purpose: they are tracked by
 * isLoneSurrogateUnit(). Overlapping the two double-counts every lone surrogate
 * and makes the hard-defect ladder fire on half as many characters as intended.
 */
export function isNoncharacter(cp) {
  return (
    cp === 0xfffd || // REPLACEMENT CHARACTER (surrogate damage trace)
    cp === 0xfffe ||
    cp === 0xffff ||
    cp === 0xfffc || // OBJECT REPLACEMENT CHARACTER (legit in some clients; low weight)
    // Spec rule: (plane.code & 0xFFFE) == 0xFFFE, where plane.code = cp & 0xFFFF.
    // Masking with 0x7ff instead would also swallow U+1F7FF, U+2A7FF … - i.e. it
    // produces false positives on real, assigned characters. 0x7ffe is the fix.
    (cp & 0x7fff) === 0x7ffe ||
    (cp & 0x7fff) === 0x7fff ||
    // planes 13 and 14: every code point is a noncharacter
    (cp >= 0xd0000 && cp <= 0xdfffd) ||
    (cp >= 0xe0000 && cp <= 0xefffd)
  );
}

/** Lone (unpaired) UTF-16 surrogate code unit - structurally invalid by construction. */
export function isLoneSurrogateUnit(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdfff;
}

/** Emoji skin-tone modifiers - each adds a shaping pass. */
export function isSkinToneModifier(cp) {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

/**
 * Proper paired-surrogate scan. Returns list of bad surrogate code-unit indexes.
 * Kept separate so callers never need to re-implement this subtle logic.
 */
export function findUnpairedSurrogates(str) {
  const bad = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // valid pair, skip low surrogate
        continue;
      }
      bad.push(i); // high surrogate with no partner
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      bad.push(i); // low surrogate standing alone
    }
  }
  return bad;
}
