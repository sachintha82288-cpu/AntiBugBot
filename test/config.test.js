import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeConfig, loadConfig, normalizePhone, toBool } from '../src/config.js';

test('defaults match the requirement: 2000 characters, 30 reports, delete for me', () => {
  const { config } = loadConfig({ argv: [], env: {}, cwd: os.tmpdir() });
  assert.equal(config.thresholdChars, 2000);
  assert.equal(config.reportAttempts, 30);
  assert.equal(config.deleteMode, 'for-me');
  assert.equal(config.block, true);
  assert.equal(config.shieldMode, 'enforce');
  assert.equal(config.groupsMode, 'observe');
  assert.equal(config.heuristics, true);
});

test('cli beats env beats defaults', () => {
  const { config } = loadConfig({ argv: ['--threshold', '1500'], env: { THRESHOLD_CHARS: '900' }, cwd: os.tmpdir() });
  assert.equal(config.thresholdChars, 1500);
  const { config: fromEnv } = loadConfig({ argv: [], env: { THRESHOLD_CHARS: '900' }, cwd: os.tmpdir() });
  assert.equal(fromEnv.thresholdChars, 900);
});

test('.env is read but the real environment wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antibug-env-'));
  fs.writeFileSync(path.join(dir, '.env'), ['# comment', 'THRESHOLD_CHARS=1200', 'OWNER_NUMBER="+94 77 123 4567"', 'LOG_LEVEL = debug # trailing comment'].join('\n'));
  const { config } = loadConfig({ argv: [], env: { OWNER_NUMBER: '94779999999' }, cwd: dir });
  assert.equal(config.thresholdChars, 1200);
  assert.equal(config.ownerNumber, '94779999999', 'process env overrides the file');
  assert.equal(config.logLevel, 'debug', 'inline comment stripped');
});

test('bad values are rejected with the key and a hint, not a stack trace', () => {
  const { errors } = loadConfig({ argv: ['--threshold', 'abc', '--groups', 'yolo'], env: {}, cwd: os.tmpdir() });
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /whole number/);
  assert.match(errors[1].message, /enforce, observe, ignore/);
});

test('phone numbers are normalised to country-code digits', () => {
  assert.equal(normalizePhone('0771234567', '94'), '94771234567');
  assert.equal(normalizePhone('+94 77 123 4567', '94'), '94771234567');
  assert.equal(normalizePhone('0094771234567', '94'), '94771234567');
  assert.equal(normalizePhone('94771234567', '94'), '94771234567');
  assert.equal(normalizePhone('   ', '94'), '');
  assert.equal(normalizePhone('not a number', '94'), '');
});

test('boolean parsing is forgiving', () => {
  assert.equal(toBool('yes'), true);
  assert.equal(toBool('OFF'), false);
  assert.equal(toBool('maybe'), null);
});

test('whitelist and owner expand local numbers', () => {
  const { config } = loadConfig({ argv: ['--owner', '0771234567', '--whitelist', '0712223333,+919876543210', '--country-code', 'LK'], env: {}, cwd: os.tmpdir() });
  assert.equal(config.ownerNumber, '94771234567');
  assert.deepEqual(config.whitelist, ['94712223333', '919876543210']);
});

test('paths resolve against the working directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antibug-paths-'));
  const { config } = loadConfig({ argv: ['--auth-dir', 'secrets', '--data-dir', path.join(dir, 'abs')], env: {}, cwd: dir });
  assert.equal(config.auth, path.join(dir, 'secrets'));
  assert.equal(config.data, path.join(dir, 'abs'));
});

test('flags flip behaviours', () => {
  const { config } = loadConfig({ argv: ['--dry-run', '--no-block', '--no-report', '--verbose'], env: {}, cwd: os.tmpdir() });
  assert.equal(config.shieldMode, 'observe');
  assert.equal(config.block, false);
  assert.equal(config.reportAttempts, 0);
  assert.equal(config.logLevel, 'debug');
});

test('the described panel covers everything an operator asks about', () => {
  const { config } = loadConfig({ argv: [], env: {}, cwd: os.tmpdir() });
  const rows = Object.fromEntries(describeConfig(config));
  for (const key of ['Trigger threshold', 'Report attempts', 'Delete mode', 'Block sender', 'Shield mode', 'Owner alerts', 'Auth state']) {
    assert.ok(rows[key], `missing panel row: ${key}`);
  }
  assert.match(rows['Trigger threshold'], /2000 characters/);
  assert.match(rows['Report attempts'], /30x/);
});

test('report budget hints how long enforcement will take', () => {
  const { config } = loadConfig({ argv: ['--report-attempts', '30'], env: { REPORT_MIN_INTERVAL_MS: '700', REPORT_JITTER_MS: '350' }, cwd: os.tmpdir() });
  assert.ok(config.reportDurationHintMs > 20_000 && config.reportDurationHintMs < 40_000, String(config.reportDurationHintMs));
});
