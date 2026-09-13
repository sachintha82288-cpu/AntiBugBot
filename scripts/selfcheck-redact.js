/**
 * Standalone guard for redact()'s character classes. Run it after ANY edit to
 * src/core/redact.js (`npm run selfcheck:redact`).
 *
 * It fails loudly if a regex escape has been written without braces - the astral
 * footgun that once made redact() delete every emoji - or if a class starts
 * eating real scripts (Thai/Arabic/Sinhala regressions).
 */
import { redact } from '../src/core/redact.js';

const cp = (n) => String.fromCodePoint(n);

const MUST_SURVIVE = [
  ['plain latin', 'bro on the way, 5 min'],
  ['sinhala', 'සුබ පැතුම්'],
  ['thai sara (non-mark chars)', 'ไ\u0e17\u0e22\u0e19 \u0e40\u0e14\u0e47\u0e01'],
  ['arabic', 'العربية'],
  ['devanagari', 'नमस्ते'],
  ['emoji alone', '\u{1f602}'],
  ['three emoji', '😀😀😀'],
  ['flag pair', `${cp(0x1f1e6)}${cp(0x1f1e8)}`],
  ['zwj family', `${cp(0x1f469)}${cp(0x200d)}${cp(0x1f466)}`],
  ['digits/punct', 'tel +94 77 123 4567 (ok)'],
];

const MUST_NOT_SURVIVE = [
  ['stacking marks', `a${cp(0x20e0).repeat(40)}b`, cp(0x20e0)],
  ['variation selectors', `x${cp(0xfe0f).repeat(9)}`, cp(0xfe0f)],
  ['rtl override', `a${cp(0x202e)}b`, cp(0x202e)],
  ['tag chars', `a${cp(0xe0041)}b`, cp(0xe0041)],
  ['control bell', `a${cp(0x07)}b`, cp(0x07)],
];

let bad = 0;

for (const [name, input] of MUST_SURVIVE) {
  const out = redact(input);
  const lost = [...input].filter((c) => c !== cp(0x200d) && !out.includes(c));
  if (lost.length) {
    console.log(
      `FAIL  ${name}: redact() lost ${lost.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`).join(', ')}` +
        `\n      in : ${JSON.stringify(input)}\n      out: ${JSON.stringify(out)}`,
    );
    bad++;
  } else {
    console.log(`ok    ${name}`);
  }
}

for (const [name, input, needle] of MUST_NOT_SURVIVE) {
  const out = redact(input);
  if (out.includes(needle)) {
    console.log(`FAIL  ${name}: redact() left a render-hostile char -> ${JSON.stringify(out)}`);
    bad++;
  } else {
    console.log(`ok    ${name}`);
  }
}

// the specific astral-escape regression, asserted precisely
const both = redact('😀😀😀 tag:' + cp(0xe0041));
if (!both.startsWith('😀😀😀 tag:<TAG:A>')) {
  console.log(`FAIL  astral escape regression: got ${JSON.stringify(both)}`);
  bad++;
} else {
  console.log('ok    astral escape regression');
}

console.log(bad ? `\n${bad} problem(s)` : '\nall redaction self-checks passed');
process.exit(bad ? 1 : 0);
