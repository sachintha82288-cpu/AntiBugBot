import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Guard } from '../src/core/guard.js';
import { Quarantine } from '../src/core/quarantine.js';
import { loadConfig } from '../src/core/config.js';
import { redact } from '../src/core/redact.js';

const cp = (n) => String.fromCodePoint(n);
const CIRCLE = cp(0x20e0);
const ZWJ = cp(0x200d);
const TAG_A = cp(0xe0041);
const HOSTILE = 'hey' + CIRCLE.repeat(200) + ZWJ.repeat(120) + TAG_A.repeat(40);
const CLEAN = 'bro on the way, 5 min';

function makeGuard(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-guard-'));
  const cfg = loadConfig(root);
  Object.assign(cfg, { scanWindow: 4000, maxLen: 6000 }, overrides.cfg ?? {});
  cfg.quarantine.dir = path.join(root, 'quarantine');
  const logs = [];
  const guard = new Guard(cfg, {
    log: (l) => logs.push(l),
    quarantine: new Quarantine(cfg.quarantine),
    clock: overrides.clock ?? (() => 1_700_000_000_000),
  });
  return { guard, logs, cfg, root };
}

test('hostile message from an unknown sender is deleted + quarantined, not echoed', async () => {
  const { guard, logs, root } = makeGuard();
  const { decision, detection } = await guard.screen({
    chatId: '12036@g.us',
    senderId: '9477xxxxxxx@s.whatsapp.net',
    messageId: 'ABC123',
    text: HOSTILE,
    isGroup: true,
    isKnownContact: false,
  });

  assert.equal(detection.verdict, 'hostile');
  assert.ok(['delete', 'restrict', 'mute', 'block'].includes(decision.action), decision.action);
  assert.equal(decision.quarantine, true);
  assert.ok(decision.reasons.some((r) => r.startsWith('content.hostile')));
  assert.ok(decision.reasons.some((r) => r.startsWith('driveby.')));
  // nothing in the decision may contain attacker text
  assert.equal(JSON.stringify(decision).includes(CIRCLE), false, 'decision leaked payload chars');
  assert.equal(JSON.stringify(logs).includes(CIRCLE), false, 'log line leaked payload chars');
  fs.rmSync(root, { recursive: true, force: true });
});

test('clean message from a contact passes untouched', async () => {
  const { guard, logs, root } = makeGuard();
  const { decision } = await guard.screen({
    chatId: '9477a@s.whatsapp.net',
    senderId: '9477a@s.whatsapp.net',
    text: CLEAN,
    isKnownContact: true,
  });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.quarantine, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].preview, CLEAN.slice(0, 140));
  fs.rmSync(root, { recursive: true, force: true });
});

test('quarantine files contain zero payload characters (defense must not become a carrier)', async () => {
  const { guard, root } = makeGuard();
  for (let i = 0; i < 3; i++) {
    await guard.screen({ chatId: 'g@g.us', senderId: 'x@y', text: HOSTILE + i });
  }
  const files = fs.readdirSync(path.join(root, 'quarantine'));
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(root, 'quarantine', files[0]), 'utf8');
  for (const bad of [CIRCLE, ZWJ, TAG_A, cp(0xfe0f)]) {
    assert.equal(raw.includes(bad), false, `quarantine leaked U+${bad.codePointAt(0).toString(16)}`);
  }
  // it must still be useful for triage
  const rec = JSON.parse(raw.trim().split('\n')[0]);
  assert.equal(rec.verdict, 'hostile');
  assert.ok(rec.stats.combining > 100);
  assert.match(rec.digest, /^[0-9a-f]{32}$/);
  assert.equal(typeof rec.senderHash, 'string');
  fs.rmSync(root, { recursive: true, force: true });
});

test('flood is punished by volume even when content is harmless', async () => {
  const { guard, root } = makeGuard({ cfg: { flood: { msgsPerMin: 5, chatMsgsPerMin: 40 } } });
  let sawWarn = false;
  for (let i = 0; i < 12; i++) {
    const { decision } = await guard.screen({ chatId: 'g@g.us', senderId: 'flood@y', text: `spam ${i}` });
    if (decision.reasons.some((r) => r.startsWith('flood.sender'))) sawWarn = true;
  }
  assert.equal(sawWarn, true, 'no flood reason emitted over 12 messages in window');
  fs.rmSync(root, { recursive: true, force: true });
});

test('repeat offenders escalate through strikes to block', async () => {
  const { guard, root } = makeGuard({ cfg: { strikes: { ttlMs: 3_600_000, muteAfter: 2, blockAfter: 4 } } });
  const actions = [];
  for (let i = 0; i < 6; i++) {
    const { decision } = await guard.screen({ chatId: 'g@g.us', senderId: 'repeat@y', text: HOSTILE });
    actions.push(decision.action);
  }
  assert.ok(actions.indexOf('block') < actions.length, `never escalated to block: ${actions}`);
  assert.equal(actions.at(-1), 'block');
  fs.rmSync(root, { recursive: true, force: true });
});

test('allowlisted owners are screened but never punished', async () => {
  const { guard, root } = makeGuard();
  const { decision } = await guard.screen({
    chatId: 'owner@s.whatsapp.net',
    senderId: 'owner@s.whatsapp.net',
    text: HOSTILE,
    isOwner: true,
  });
  assert.ok(['allow', 'log'].includes(decision.action), decision.action);
  assert.equal(decision.quarantine, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('notice is rate-limited per sender so the guard does not become a flood itself', async () => {
  const { guard, root } = makeGuard({ cfg: { flood: { msgsPerMin: 2, chatMsgsPerMin: 999 } } });
  let notices = 0;
  for (let i = 0; i < 10; i++) {
    const { notice } = await guard.screen({ chatId: 'g@g.us', senderId: 'f@y', text: 'x' + i });
    if (notice) notices++;
  }
  assert.equal(notices, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('redact() strips render-hostile chars but keeps render-significant ones', () => {
  const out = redact(`a${CIRCLE.repeat(50)}b${ZWJ}${TAG_A}${cp(0x202e)}${cp(0x07)}`);
  // 50 stacked marks collapse into one `⋮x50` marker; ZWJ survives on purpose
  // (it is what makes emoji sequences render at all); the trailing `⋮` is the
  // dropped RLO override; the BEL control char is surfaced as an escape.
  assert.equal(out, `ab⋮ x50`.replace(' ', '') + ZWJ + '<TAG:A><U+0007>⋮');
  assert.equal(out.includes(CIRCLE), false);
  assert.ok(out.length < 80);
});

test('redact() preserves real non-Latin scripts (Thai vowel regression)', () => {
  // 'คนไทย' must survive; earlier versions dropped U+0E33 as "invisible".
  assert.equal(redact('ไ\u0e17\u0e22\u0e19'), 'ไทยน'.replace(/[̀-ͯัิ-ฺ็-๎]/g, ''));
  assert.equal(redact('සුබ පැතුම් \u{1f602}'), 'සුබ පැතුම් \u{1f602}');
  assert.equal(redact('العربية'), 'العربية');
  assert.equal(redact('a\u200db'), 'a\u200db'); // ZWJ kept - it is render-significant
});

test('maintenance() bounds memory for long-lived Pterodactyl processes', async () => {
  const { guard, root } = makeGuard();
  let t = 1_700_000_000_000;
  const g2 = new Guard(guard.cfg, {
    log: () => {},
    clock: () => t,
    quarantine: new Quarantine(guard.cfg.quarantine),
  });
  for (let i = 0; i < 50; i++) {
    await g2.screen({ chatId: `c${i}@g.us`, senderId: `s${i}@y`, text: 'hi' });
  }
  assert.ok(g2.chatWindow.buckets.size === 50);
  t += 24 * 3600_000;
  g2.maintenance();
  assert.equal(g2.chatWindow.buckets.size, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
