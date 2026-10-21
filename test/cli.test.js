import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'src', 'index.js');

const run = (args, options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antibug-cli-'));
  const cwd = options.cwd || dir;
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args, '--data-dir', path.join(dir, 'data'), '--auth-dir', path.join(dir, 'auth'), '--no-log-file'], {
      cwd,
      encoding: 'utf8',
      timeout: 40_000,
      env: { ...process.env, NO_COLOR: '1', ...options.env }
    });
    return { stdout, code: 0, dir };
  } catch (error) {
    return { stdout: (error.stdout || '') + (error.stderr || ''), code: error.status ?? 1, dir };
  }
};

test('help lists the commands and exits cleanly', () => {
  const { stdout, code } = run(['help']);
  assert.equal(code, 0);
  for (const needle of ['start', 'selftest', 'status', '--threshold', 'whitelist', 'logout', 'history']) {
    assert.match(stdout, new RegExp(needle));
  }
});

test('selftest proves the whole pipeline end to end', () => {
  const { stdout, code } = run(['selftest']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /selftest passed — 8\/8 checks/);
  assert.match(stdout, /DETECTION MATRIX/);
  assert.match(stdout, /one over the trigger.*flagged/s);
  assert.match(stdout, /unicode tag block.*flagged/s);
  assert.match(stdout, /zwj emoji bomb.*flagged/s);
  assert.match(stdout, /exactly at the trigger.*clean/s);
  assert.match(stdout, /deleted for me/);
  assert.match(stdout, /-threat neutralised|threat neutralised/);
  assert.match(stdout, /අකුරු/);
});

test('selftest can be run in observe mode without breaking', () => {
  const { stdout, code } = run(['selftest', '--mode', 'observe']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /observe mode/);
});

test('selftest stays honest whatever the policy is', () => {
  for (const args of [
    ['--no-block', '--delete-mode', 'off', '--no-report'],
    ['--groups', 'enforce', '--report-channel', 'evidence'],
    ['--threshold', '100', '--count-mode', 'utf16'],
    ['--report-attempts', '0'],
    ['--no-color']
  ]) {
    const { stdout, code } = run(['selftest', ...args]);
    assert.equal(code, 0, `selftest ${args.join(' ')} failed:\n${stdout}`);
    assert.match(stdout, /selftest passed — 8\/8 checks/);
  }
});

test('a bad config value is refused with an explanation', () => {
  const { stdout, code } = run(['status', '--threshold', 'tiny']);
  assert.equal(code, 2);
  assert.match(stdout, /CONFIG ERROR/);
  assert.match(stdout, /whole number/);
  assert.match(stdout, /THRESHOLD_CHARS|threshold/);
});

test('status and history start empty and stay honest', () => {
  const { stdout } = run(['status']);
  assert.match(stdout, /SHIELD STATUS/);
  assert.match(stdout, /no incidents yet/);
  const history = run(['history'], { cwd: process.cwd() });
  assert.match(history.stdout, /ANTI-BUGBOT|INCIDENT HISTORY|no incidents recorded/);
});

test('whitelist round-trips through the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antibug-wl-'));
  const call = (args) => execFileSync(process.execPath, [BIN, ...args, '--data-dir', path.join(dir, 'data'), '--no-log-file'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 20_000
  });
  call(['whitelist', 'add', '0771234567']);
  const listed = call(['whitelist', 'list']);
  assert.match(listed, /WHITELIST \(1\)/);
  assert.match(listed, /94771234567/);
  const removed = call(['whitelist', 'remove', '+94 77 123 4567']);
  assert.match(removed, /removed from the whitelist/);
  assert.match(call(['whitelist', 'list']), /whitelist is empty/);
});

test('unblock needs an argument and says so', () => {
  const { stdout, code } = run(['unblock']);
  assert.equal(code, 2);
  assert.match(stdout, /usage: node src\/index\.js unblock <number>/);
});

test('an unknown command is rejected, not ignored', () => {
  const { stdout, code } = run(['nonsense']);
  assert.equal(code, 2);
  assert.match(stdout, /unknown command nonsense/);
  assert.match(stdout, /start · status · history/);
});

test('logout with no session is a no-op, not a crash', () => {
  const { stdout, code } = run(['logout']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /no stored session/);
});

test('blocked ledger prints nothing until an incident lands', () => {
  const { stdout } = run(['blocked']);
  assert.match(stdout, /nothing blocked yet/);
});
