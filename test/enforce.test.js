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

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'antibug-' + name + '-'));

const config = (over = {}) => ({
  thresholdChars: 2000,
  countMode: 'max',
  heuristics: true,
  block: true,
  deleteMode: 'for-me',
  reportAttempts: 0,
  reportChannel: 'off',
  reportMinIntervalMs: 0,
  reportJitterMs: 0,
  groupsMode: 'observe',
  shieldMode: 'enforce',
  maxActionsPerMinute: 500,
  beepOnThreat: false,
  ownerNumber: '94771111111',
  whitelist: [],
  data: tmp('enforce'),
  countryCode: 'LK',
  ...over
});

const makeMessage = (over = {}) => ({
  key: { remoteJid: '94770000000@s.whatsapp.net', id: 'M' + Math.random().toString(36).slice(2, 8), fromMe: false },
  pushName: 'Crash Bot',
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: 'x'.repeat(2600) },
  ...over
});

const harness = ({ socketOver = {}, configOver = {}, storeOver = {} } = {}) => {
  const calls = [];
  const conn = {
    async updateBlockStatus(jid, action) { calls.push(['block', action, jid]); },
    async fetchBlocklist() { calls.push(['fetchBlocklist']); return []; },
    async chatModify(mod, jid) { calls.push(['chatModify', Object.keys(mod)[0], jid]); },
    async sendMessage(jid, content) { calls.push(['send', jid, Object.keys(content).join('+')]); return { key: { id: 'SENT1' } }; },
    async query() { const error = new Error('404'); throw error; },
    ...socketOver
  };
  const cfg = config(configOver);
  const store = new StateStore({ dir: tmp('store'), ...storeOver }).load();
  const uiEvents = [];
  const ui = {
    level: 'silent',
    action: (name, status, detail) => uiEvents.push(['action', name, status, detail]),
    alert: (...args) => uiEvents.push(['alert', ...args]),
    debug: () => {},
    info: () => {},
    warn: (...args) => uiEvents.push(['warn', ...args]),
    error: (...args) => uiEvents.push(['error', ...args]),
    notice: () => {},
    setTask: () => {},
    raw: () => {}
  };
  const reportEngine = new ReportEngine({ config: cfg, store, ui });
  const identity = { me: { id: '94771111111:12@s.whatsapp.net' }, ownerJid: '94771111111@s.whatsapp.net', host: { jid: '94771111111@s.whatsapp.net' } };
  const enforcer = new Enforcer({ config: cfg, store, ui, reportEngine, identity });
  return { conn, calls, cfg, store, ui, uiEvents, enforcer, identity };
};

const run = async (harnessObj, messageOver = {}) => {
  const message = makeMessage(messageOver);
  const decision = evaluateText(message.message.conversation, {
    threshold: harnessObj.cfg.thresholdChars,
    countMode: harnessObj.cfg.countMode,
    heuristics: harnessObj.cfg.heuristics
  });
  decision.text = message.message.conversation;
  const incident = buildIncident({
    message,
    decision,
    config: harnessObj.cfg,
    identity: harnessObj.identity,
    store: harnessObj.store
  });
  incident.senderLabel = incident.sender.display;
  const outcome = await harnessObj.enforcer.process({ conn: harnessObj.conn, message, decision, incident });
  return { message, decision, incident, outcome };
};

test('a threat is deleted, blocked and briefed, in that order', async () => {
  const harnessObj = harness();
  const { incident } = await run(harnessObj);
  const order = harnessObj.calls.map((call) => call[0]);
  assert.deepEqual(order, ['chatModify', 'fetchBlocklist', 'block', 'send'], 'delete → block → alert');
  assert.equal(incident.actions.delete.status, 'ok');
  assert.match(incident.actions.delete.detail, /deleted for me/);
  assert.equal(incident.actions.block.status, 'ok');
  assert.equal(incident.actions.notify.status, 'ok');
  assert.equal(incident.actions.notify.to, '94771111111@s.whatsapp.net');
  assert.equal(harnessObj.store.state.stats.deleted, 1);
  assert.equal(harnessObj.store.state.stats.blocked, 1);
  assert.equal(harnessObj.store.state.stats.alertsSent, 1);
  assert.match(incident.brief, /2,600-character/);
});

test('observe mode analyses but never touches the chat', async () => {
  const harnessObj = harness({ configOver: { shieldMode: 'observe' } });
  const { incident } = await run(harnessObj);
  assert.deepEqual(harnessObj.calls.map((call) => call[0]), ['send'], 'only the owner alert leaves the process');
  assert.equal(incident.actions.delete.status, 'dry');
  assert.equal(incident.actions.block.status, 'dry');
  assert.equal(incident.reports.channel, 'observe');
  assert.match(incident.brief, /OBSERVE/);
});

test('whitelisted and own numbers are never enforced against', async () => {
  const whitelisted = harness({ configOver: { whitelist: ['94770000000'] } });
  const skip = await run(whitelisted);
  assert.equal(skip.outcome.skipped, true);
  assert.match(skip.outcome.reason, /whitelist/);
  assert.deepEqual(whitelisted.calls, []);

  const mine = harness();
  const self = await run(mine, { key: { remoteJid: '94770000000@s.whatsapp.net', id: 'X1', fromMe: true } });
  assert.equal(self.outcome.skipped, true);
  assert.match(self.outcome.reason, /sent by this account/);
});

test('a sender already on the whatsapp blocklist is not re-blocked', async () => {
  const harnessObj = harness({
    socketOver: {
      async fetchBlocklist() { return ['94770000000@s.whatsapp.net']; },
      async updateBlockStatus() { throw new Error('should not be called'); }
    }
  });
  const { incident } = await run(harnessObj);
  assert.equal(incident.actions.block.status, 'skip');
  assert.match(incident.actions.block.detail, /already on WhatsApp blocklist/);
});

test('group traffic is logged, not policed, in the default groups mode', async () => {
  const harnessObj = harness();
  const message = await run(harnessObj, {
    key: { remoteJid: '1234567890-123456@g.us', id: 'G1', fromMe: false, participant: '94770000000@s.whatsapp.net' }
  });
  assert.equal(message.outcome.skipped, true);
  assert.match(message.outcome.reason, /observe mode/);
  assert.equal(message.incident.chat.isGroup, true);
  assert.equal(message.incident.sender.jid, '94770000000@s.whatsapp.net', 'the participant, not the group, is the target');
});

test('groups mode enforce blocks the participant in the group chat', async () => {
  const harnessObj = harness({ configOver: { groupsMode: 'enforce' } });
  const { incident } = await run(harnessObj, {
    key: { remoteJid: '1234567890-123456@g.us', id: 'G2', fromMe: false, participant: '94770000000@s.whatsapp.net' }
  });
  assert.equal(incident.actions.block.status, 'ok');
  assert.ok(harnessObj.calls.some((call) => call[0] === 'chatModify' && /@g\.us$/.test(call[2])), 'deletes inside the group chat');
});

test('the same message id is only handled once', async () => {
  const harnessObj = harness();
  const first = await run(harnessObj, { key: { remoteJid: '94770000000@s.whatsapp.net', id: 'DUP', fromMe: false } });
  assert.equal(first.outcome.skipped, undefined);
  const second = await run(harnessObj, { key: { remoteJid: '94770000000@s.whatsapp.net', id: 'DUP', fromMe: false } });
  assert.equal(second.outcome.skipped, true);
  assert.match(second.outcome.reason, /already handled/);
});

test('a blocked socket never blocks the shield: failures are recorded and the alert still goes out', async () => {
  const harnessObj = harness({
    socketOver: {
      async updateBlockStatus() { throw new Error('503 service unavailable'); },
      async chatModify() { throw new Error('phone offline'); }
    }
  });
  const { incident } = await run(harnessObj);
  assert.equal(incident.actions.block.status, 'fail');
  assert.match(incident.actions.block.detail, /503/);
  assert.equal(incident.actions.delete.status, 'fail');
  assert.equal(incident.actions.notify.status, 'ok', 'the owner still gets told what failed');
  assert.match(incident.brief, /✖ block/);
});

test('a flood trips the breaker and pauses enforcement to protect the owner account', async () => {
  const harnessObj = harness({ configOver: { reportAttempts: 0 } });
  const enforcer = harnessObj.enforcer;
  enforcer.breaker.threshold = 3;
  enforcer.breaker.record('seed');
  enforcer.breaker.record('seed');
  enforcer.breaker.record('seed');
  assert.equal(enforcer.breaker.open, true);
  const { incident } = await run(harnessObj);
  assert.equal(incident.actions.block.status, 'skip');
  assert.match(incident.actions.block.detail, /circuit breaker/);
  assert.equal(incident.reports.channel, 'paused');
  assert.equal(incident.actions.notify.status, 'ok', 'still tells the owner');
});

test('delivery failure keeps a copy on disk instead of losing the brief', async () => {
  const dir = tmp('outbox');
  const harnessObj = harness({
    socketOver: {
      async sendMessage() { throw new Error('socket closed while sending'); }
    }
  });
  harnessObj.enforcer.config.data = dir;
  const { incident } = await run(harnessObj);
  assert.equal(incident.actions.notify.status, 'fail');
  const files = fs.readdirSync(path.join(dir, 'outbox'));
  assert.equal(files.length, 1, 'one undelivered alert saved');
  assert.match(fs.readFileSync(path.join(dir, 'outbox', files[0]), 'utf8'), /AntiBugBot — threat neutralised/);
});

test('drain waits for queued work and the store persists it', async () => {
  const harnessObj = harness();
  const promises = [run(harnessObj), run(harnessObj), run(harnessObj)];
  await harnessObj.enforcer.drain();
  const results = await Promise.all(promises);
  assert.equal(results.filter((r) => r.outcome?.skipped).length, 0);
  assert.equal(harnessObj.store.state.incidents.length, 3);
  await harnessObj.store.flush();
  const reloaded = new StateStore({ dir: harnessObj.store.dir }).load();
  assert.equal(reloaded.state.incidents.length, 3);
  assert.equal(reloaded.state.stats.blocked, 1, 'same number blocked once in the ledger, three records');
});
