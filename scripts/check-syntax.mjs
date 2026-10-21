#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dirs = ['src', 'test', 'scripts'];

const walk = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
};

const rel = (file) => path.relative(root, path.resolve(root, file));
const abs = (file) => (path.isAbsolute(file) ? file : path.resolve(root, file));
const files = dirs.flatMap(walk).map((file) => abs(file));
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    process.stdout.write(`  ok    ${rel(file)}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL  ${rel(file)}\n${error.stderr?.toString() || error.message}\n`);
  }
}

// every module must also import cleanly (catches bad specifiers and cycles)
const modules = walk(path.join(root, 'src')).filter((file) => file.endsWith('.js') && !file.endsWith('index.js'));
for (const file of modules) {
  const target = abs(file);
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify('file://' + target)});`], { stdio: 'pipe', cwd: root });
    process.stdout.write(`  load  ${rel(target)}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL  ${rel(target)}\n${(error.stderr?.toString() || error.message).split('\n').slice(0, 6).join('\n')}\n`);
  }
}

process.stdout.write(`\n${files.length + modules.length} checks, ${failed} failures\n`);
process.exit(failed === 0 ? 0 : 1);
