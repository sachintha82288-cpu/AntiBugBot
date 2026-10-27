import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Enforcer } from '../src/actions/enforce.js';
import { ReportEngine } from '../src/actions/report.js';
import { StateStore } from '../src/core/store.js';
import { evaluateText } from '../src/core/guard.js';
import { buildIncident } from '../src/core/incident.js';

test('the ledger keeps forensics but never the attack body', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antibug-persist-'));
  const config = {
    thresholdChars: 2000, countMode: 'max', heuristics: true, block: true, deleteMode: 'for-me',
    reportAttempts: 0, reportChannel: 'off', groupsMode: 'ignore', shieldMode: 'enforce',
    maxActionsPerMinute: 500, beepOnThreat: false, ownerNumber: '94771111111', whitelist: [], data: dir, countryCode: 'LK'
  };
  const store = new StateStore({ dir }).load();
  const conn = {
    async updateBlockStatus() {}, async fetchBlocklist() { return []; },
    async chatModify() {}, async sendMessage() { return { key: { id: 'S' } }; },
    async query() { throw new Error('404'); }
  };
  const identity = { ownerJid: '94771111111@s.whatsapp.net', host: { jid: '94771111111@s.whatsapp.net' } };
  const enforcer = new Enforcer({ config, store, ui: null, reportEngine: new ReportEngine({ config, store }), identity });

  const secret = 'SECRET-PAYLOAD-' + 'x'.repeat(2500);
  const message = {
    key: { remoteJid: '94770000000@s.whatsapp.net', id: 'P1', fromMe: false },
    pushName: 'Crash Bot', messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: secret }
  };
  const decision = evaluateText(secret, { threshold: 2000, countMode: 'max', heuristics: true });
  decision.text = secret;
  const incident = buildIncident({ message, decision, config, identity, store });
  incident.brief = 'A'.repeat(5000);
  await enforcer.process({ conn, message, decision, incident });
  await store.flush();

  const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  assert.ok(!raw.includes('x'.repeat(200)), 'the attack body is never stored whole — only a short excerpt');
  const persisted = store.state.incidents[0];
  assert.equal(persisted.brief, undefined, 'no 5kb of rendered prose in the state file');
  assert.ok(persisted.detection.preview.length <= 160);
  assert.equal(persisted.actions.block.status, 'ok');
  assert.equal(persisted.actions.notify.status, 'ok');
  assert.ok(raw.length < 20_000, `state file stays small: ${raw.length}`);

  assert.ok(persisted.detection.counted > 2500, 'but the measurements are exact');
  assert.equal(persisted.sender.phone, '+94770000000');
  const ledger = fs.readFileSync(path.join(dir, 'incidents.jsonl'), 'utf8');
  assert.match(ledger, /"id":"INC-/);
  assert.ok(!ledger.includes('x'.repeat(200)), 'the jsonl ledger is excerpted too');
});
