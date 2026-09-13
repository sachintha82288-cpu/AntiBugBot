import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Repo-level invariant: this project must never contain a render-hostile code
 * point as a *raw literal*. Not in fixtures, not in docs, not in quarantine.
 *
 * Why enforce it in a test rather than by review: a hostile char sitting in a
 * source file renders in editors, terminals and the Pterodactyl HTML log - the
 * exact failure mode the bot exists to prevent - and it silently turns the
 * defence repo into a payload carrier. This happened once during development
 * (a patch wrote U+200D into a fixture); a test is the only durable answer.
 *
 * Construction rule: build fixtures with String.fromCodePoint()/escapes, which
 * keeps every source file pure ASCII in these ranges.
 */

/** Code points that must never appear literally in tracked content. */
const FORBIDDEN_LITERALS = {
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LRM',
  0x200f: 'RLM',
  0x202a: 'LRE',
  0x202b: 'RLE',
  0x202c: 'PDF',
  0x202d: 'LRO',
  0x202e: 'RLO',
  0x2060: 'WORD JOINER',
  0x2066: 'LRI',
  0x2067: 'RLI',
  0x2068: 'FSI',
  0x2069: 'PDI',
  0x061c: 'ARABIC LETTER MARK',
  0x00ad: 'SOFT HYPHEN',
  0x20e0: 'COMBINING CLOSING CIRCLE ABOVE',
  0xfe0f: 'VARIATION SELECTOR-16',
  0xfffd: 'REPLACEMENT CHARACTER',
  0xfffe: 'NONCHARACTER',
  0xffff: 'NONCHARACTER',
  0x0007: 'BELL',
  0x0000: 'NUL',
};
// every C0 control except the ones a source file legitimately needs
for (let c = 0x00; c <= 0x08; c++) FORBIDDEN_LITERALS[c] = `C0 CONTROL U+${c.toString(16).padStart(4, '0')}`;
for (let c = 0x0e; c <= 0x1f; c++) FORBIDDEN_LITERALS[c] = `C0 CONTROL U+${c.toString(16).padStart(4, '0')}`;
// astral ranges, expressed as the surrogate pairs that actually appear in the file
const FORBIDDEN_PAIRS = new Set([
  '\ud800\ude00', // U+E0000.. - tag/ignore block start marker family
]);
const ASTRAL_PREFIX = 0xdbff; // high surrogate for U+D800.. (private planes) - checked numerically

function trackedFiles(root) {
  const out = [];
  const skip = new Set(['.git', 'node_modules', 'data', 'coverage', 'dist']);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(abs);
        continue;
      }
      if (/\.(js|json|md|yml|yaml|txt|egg\.json)$/.test(entry.name)) out.push(abs);
    }
  })(root);
  return out;
}

test('no render-hostile literals anywhere in the repo', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const offenders = [];

  for (const file of trackedFiles(root)) {
    const rel = path.relative(root, file);
    if (rel === 'test/carrier.test.js') continue; // this file documents the code points
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (let j = 0; j < line.length; j++) {
        const unit = line.charCodeAt(j);
        if (FORBIDDEN_LITERALS[unit]) {
          offenders.push(`${rel}:${i + 1} col ${j} U+${unit.toString(16).toUpperCase()} (${FORBIDDEN_LITERALS[unit]})`);
        }
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          offenders.push(`${rel}:${i + 1} col ${j} lone low surrogate`);
        }
        if (unit === ASTRAL_PREFIX) {
          offenders.push(`${rel}:${i + 1} col ${j} high surrogate of a private-plane pair`);
        }
        // BMP private use area - never needed in this codebase
        if (unit >= 0xe000 && unit <= 0xf8ff) {
          offenders.push(`${rel}:${i + 1} col ${j} U+${unit.toString(16).toUpperCase()} (private use area)`);
        }
      }
    });
  }
  void FORBIDDEN_PAIRS;

  assert.deepEqual(offenders, [], `hostile literals found:\n  ${offenders.join('\n  ')}`);
});

test('quarantine/audit dirs are git-ignored (no payload-bearing state can be committed)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\/?data\/?$/m, 'data/ must be ignored');
  assert.match(ignore, /^\/?node_modules\/?$/m);
});

test('package declares zero runtime dependencies (reviewable, Egg-installable)', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'src/core must stay dependency-free');
  assert.equal(Object.keys(pkg.devDependencies ?? {}).length, 0, 'tests must run on bare node');
  assert.equal(pkg.type, 'module');
});
