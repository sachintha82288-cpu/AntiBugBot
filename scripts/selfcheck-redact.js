/**
 * Standalone guard for redact(). Run after ANY edit to src/core/redact.js:
 *
 *     npm run selfcheck:redact
 *
 * Two jobs:
 *  1. redact() must never eat legitimate text (real scripts, emoji, digits).
 *  2. redact() must never let a render-hostile code point reach the log.
 *
 * This file is deliberately pure ASCII: every fixture is built with
 * String.fromCodePoint(). A literal control character in a source file renders in
 * editors and in the Pterodactyl HTML log, which is precisely what we are testing
 * for absence of. test/carrier.test.js enforces this repo-wide.
 */
import { redact } from '../src/core/redact.js';

const cp = (n) => String.fromCodePoint(n);

const MUST_SURVIVE = [
  ['plain latin', 'bro on the way, 5 min'],
  ['sinhala', `${cp(0x0dc3)}${cp(0x0dca)}${cp(0x0dba)} ${cp(0x0db4)}${cp(0x0dd0)}${cp(0x0dd2)}${cp(0x0db8)}${cp(0x0dca)}`],
  ['sinhala zwj conjunct', `sa${cp(0x0dca)}${cp(0x200d)}ma`],
  ['thai sara am + mai ek', `${cp(0x0e44)}${cp(0x0e17)}${cp(0x0e22)}${cp(0x0e19)} ${cp(0x0e40)}${cp(0x0e14)}${cp(0x0e47)}${cp(0x0e01)}`],
  ['arabic', `${cp(0x0627)}${cp(0x0644)}${cp(0x0639)}${cp(0x0631)}${cp(0x0628)}${cp(0x064a)}${cp(0x0629)}`],
  ['devanagari conjunct', `${cp(0x0928)}${cp(0x092e)}${cp(0x0938)}${cp(0x094d)}${cp(0x0924)}${cp(0x0947)}`],
  ['emoji alone', cp(0x1f602)],
  ['three emoji', cp(0x1f600) + cp(0x1f600) + cp(0x1f600)],
  ['flag pair', `${cp(0x1f1f1)}${cp(0x1f1f0)}`],
  ['zwj family', `${cp(0x1f468)}${cp(0x200d)}${cp(0x1f469)}${cp(0x200d)}${cp(0x1f467)}`],
  ['latin-1 accents', 'café résumé naïve Ñandú'],
  ['digits/punct', 'tel +94 77 123 4567 (ok)'],
];

const MUST_NOT_SURVIVE = [
  ['stacking marks', `a${cp(0x20e0).repeat(40)}b`, cp(0x20e0)],
  ['variation selectors', `x${cp(0xfe0f).repeat(9)}`, cp(0xfe0f)],
  ['rtl override', `a${cp(0x202e)}b`, cp(0x202e)],
  ['ltr isolate', `a${cp(0x2066)}b`, cp(0x2066)],
  ['zero width space', `a${cp(0x200b)}b`, cp(0x200b)],
  ['soft hyphen', `a${cp(0x00ad)}b`, cp(0x00ad)],
  ['tag chars', `a${cp(0xe0041)}b`, cp(0xe0041)],
  ['tags char', `a${cp(0xe0001)}b`, cp(0xe0001)],
  ['astral nonchar', `a${cp(0x1fffe)}b`, cp(0x1fffe)],
  ['bpm nonchar', `a${cp(0xfffe)}b`, cp(0xfffe)],
  ['private use', `a${cp(0xf8ff)}b`, cp(0xf8ff)],
  ['control bell', `a${cp(0x07)}b`, cp(0x07)],
  ['lone surrogate', `a${'\ud800'}b`, '\ud800'],
];

let bad = 0;

for (const [name, input] of MUST_SURVIVE) {
  const out = redact(input);
  const lost = [...input].filter((c) => !out.includes(c));
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

// the astral-escape footgun, asserted precisely: emoji kept, tag char labelled
const both = redact(`${cp(0x1f600)}${cp(0x1f600)}${cp(0x1f600)} tag:${cp(0xe0041)}`);
if (both !== `${cp(0x1f600)}${cp(0x1f600)}${cp(0x1f600)} tag:<TAG:A>`) {
  console.log(`FAIL  astral escape regression: got ${JSON.stringify(both)}`);
  bad++;
} else {
  console.log('ok    astral escape regression');
}

// truncation must be bounded and must not split a surrogate pair
const long = 'x'.repeat(900) + cp(0x1f600);
const cut = redact(long, { maxChars: 120 });
if (cut.length > 140 || /[\ud800-\udfff](?![\udc00-\udfff])/.test(cut)) {
  console.log(`FAIL  bounded truncation: len=${cut.length}`);
  bad++;
} else {
  console.log('ok    bounded truncation');
}

console.log(bad ? `\n${bad} problem(s)` : '\nall redaction self-checks passed');
process.exit(bad ? 1 : 0);
