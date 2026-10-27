import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/core/store.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'antibug-' + name + '-'));

test('state survives a restart', async () => {
  const dir = tmp('roundtrip');
  const store = new StateStore({ dir, flushDelayMs: 0 }).load();
  store.increment('messagesScanned', 12);
  store.recordBlock({ jid: '94770000000@s.whatsapp.net', reason: 'oversized crash-bug message' });
  await store.addIncident({ id: 'INC-1', createdAt: new Date().toISOString(), sender: { jid: '94770000000@s.whatsapp.net' }, detection: { counted: 2500, rules: [{ id: 'oversize' }] }, actions: {} });
  await store.flush();

  const again = new StateStore({ dir }).load();
  assert.equal(again.state.stats.messagesScanned, 12);
  assert.equal(again.isBlocked('94770000000@s.whatsapp.net'), true);
  assert.equal(again.state.incidents.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'incidents.jsonl')), true);
});

test('a corrupt state file is quarantined, not fatal', () => {
  const dir = tmp('corrupt');
  fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json');
  const store = new StateStore({ dir }).load();
  assert.ok(store.recovered);
  assert.match(store.recovered.error, /JSON|Unexpected/i);
  assert.equal(store.state.stats.threatsDetected, 0);
  assert.equal(fs.existsSync(store.recovered.backup), true);
});

test('block records dedupe and count repeats', () => {
  const store = new StateStore({ dir: tmp('blocks'), flushDelayMs: 1000 }).load();
  store.recordBlock({ jid: 'a@s.whatsapp.net' });
  store.recordBlock({ jid: 'a@s.whatsapp.net' });
  assert.equal(store.state.blocked['a@s.whatsapp.net'].blockCount, 2);
  assert.equal(store.removeBlock('a@s.whatsapp.net'), true);
  assert.equal(store.removeBlock('a@s.whatsapp.net'), false);
});

test('incident history is capped while the jsonl ledger keeps everything', async () => {
  const dir = tmp('cap');
  const store = new StateStore({ dir, maxIncidents: 3 }).load();
  for (let i = 0; i < 10; i += 1) {
    await store.addIncident({ id: `INC-${i}`, detection: { rules: [] }, actions: {}, sender: {} });
  }
  assert.equal(store.state.incidents.length, 3);
  assert.deepEqual(store.recentIncidents(3).map((i) => i.id), ['INC-9', 'INC-8', 'INC-7']);
  const lines = fs.readFileSync(path.join(dir, 'incidents.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 10);
});

test('report packets land on disk as json and readable text', async () => {
  const dir = tmp('packets');
  const store = new StateStore({ dir }).load();
  const saved = await store.writeReportPacket({ id: 'INC-7', human: 'evidence packet body' });
  assert.equal(fs.existsSync(saved.file), true);
  assert.equal(fs.existsSync(saved.text), true);
  assert.match(fs.readFileSync(saved.text, 'utf8'), /evidence packet body/);
});

test('whitelist add/remove round trip', () => {
  const store = new StateStore({ dir: tmp('wl'), flushDelayMs: 5000 }).load();
  store.addWhitelist('94771234567@s.whatsapp.net', 'mum');
  assert.equal(store.isWhitelisted('94771234567@s.whatsapp.net'), true);
  assert.equal(store.removeWhitelist('94771234567@s.whatsapp.net'), true);
  assert.equal(store.isWhitelisted('94771234567@s.whatsapp.net'), false);
});
