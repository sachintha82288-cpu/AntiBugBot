import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntiBugBot } from '../src/bot.js';
import { StateStore } from '../src/core/store.js';
import { loadConfig } from '../src/config.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'antibug-' + name + '-'));

const makeBot = (extraArgs = [], socketOver = {}) => {
  const dir = tmp('bot');
  const { config } = loadConfig({
    argv: ['--data-dir', dir, '--auth-dir', path.join(dir, 'auth'), '--no-log-file', '--no-stats', '--no-beep', ...extraArgs],
    env: {},
    cwd: dir
  });
  const store = new StateStore({ dir }).load();
  const printed = [];
  const ui = {
    level: 'silent',
    logFilePath: null,
    raw: (line) => printed.push(String(line)),
    debug: () => {},
    info: (tag, msg) => printed.push(`info:${tag}:${msg}`),
    notice: () => {},
    warn: () => {},
    error: (tag, msg) => printed.push(`error:${tag}:${msg}`),
    threat: (incident) => printed.push(`threat:${incident.id}`),
    action: () => {},
    alert: () => {},
    done: () => {},
    fail: () => {},
    note: () => {},
    keyPanel: () => {},
    qr: () => {},
    setTask: () => {},
    renderStrip: () => {},
    close: () => {},
    async spin(label, task) { return task({ update: () => {} }); }
  };
  const calls = [];
  const conn = {
    async updateBlockStatus(jid, action) { calls.push(['block', action, jid]); },
    async fetchBlocklist() { return []; },
    async chatModify(mod, jid) { calls.push(['chatModify', Object.keys(mod)[0], jid]); },
    async sendMessage(jid, content) { calls.push(['send', jid, String(content.text || '').slice(0, 40)]); return { key: { id: 'S' + calls.length } }; },
    async query() { const error = new Error('404'); throw error; },
    ...socketOver
  };
  const bot = new AntiBugBot({ config, store, ui });
  bot.conn = conn;
  bot.identity = { me: { id: '94771111111:12@s.whatsapp.net', name: 'Owner' }, ownerJid: '94771111111@s.whatsapp.net', host: { jid: '94771111111@s.whatsapp.net', startedAt: Date.now() } };
  bot.enforcer.identity = bot.identity;
  return { bot, store, calls, printed, ui, dir };
};

const attack = (over = {}) => ({
  key: { remoteJid: '94770000000@s.whatsapp.net', id: 'ATTACK1', fromMe: false },
  pushName: 'Crash Bot',
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { conversation: 'x'.repeat(2400) },
  ...over
});

test('an incoming bug message is detected, stripped and the sender blocked', async () => {
  const { bot, calls, store, printed } = makeBot();
  await bot.inspect(attack());
  assert.deepEqual(calls.map((call) => call[0]), ['chatModify', 'block', 'send']);
  assert.equal(store.state.stats.threatsDetected, 1);
  assert.equal(store.state.stats.messagesScanned, 1);
  assert.equal(store.state.stats.blocked, 1);
  assert.ok(printed.some((line) => line.startsWith('threat:INC-')), 'incident panel rendered');
  const brief = calls.find((call) => call[0] === 'send');
  assert.equal(brief[1], '94771111111@s.whatsapp.net', 'owner gets the brief');
  assert.match(brief[2], /AntiBugBot/);
});

test('normal chat is only counted, never touched', async () => {
  const { bot, calls, store } = makeBot();
  await bot.inspect({ ...attack(), message: { conversation: 'on my way, 5 minutes' } });
  await bot.inspect({ ...attack(), message: { imageMessage: { caption: 'look at this' } } });
  assert.equal(calls.length, 0);
  assert.equal(store.state.stats.threatsDetected, 0);
  assert.equal(store.state.stats.messagesScanned, 2);
});

test('history backfill, own messages and status broadcasts are ignored', async () => {
  const { bot, calls } = makeBot();
  await bot.onMessagesUpsert({ type: 'append', messages: [attack()] });
  await bot.inspect(attack({ key: { remoteJid: '94770000000@s.whatsapp.net', id: 'SELF', fromMe: true } }));
  await bot.inspect(attack({ key: { remoteJid: 'status@broadcast', id: 'ST', fromMe: false } }));
  assert.equal(calls.length, 0, 'nothing enforced for history, self, or status');
});

test('captions on media carry the attack too', async () => {
  const { bot, calls } = makeBot();
  await bot.inspect(attack({ message: { videoMessage: { caption: 'x'.repeat(3000) } } }));
  assert.ok(calls.some((call) => call[0] === 'chatModify'), 'caption payload deleted');
});

test('a vcard contact-bomb is caught even though it has no text body', async () => {
  const { bot, calls } = makeBot();
  await bot.inspect(attack({
    message: { contactMessage: { displayName: 'hi', vcard: 'BEGIN:VCARD\n' + 'A'.repeat(4000) + '\nEND:VCARD' } }
  }));
  assert.ok(calls.some((call) => call[0] === 'block'), 'contact bomb blocked');
});

test('a dead socket is recorded as failures, never as a crash', async () => {
  const { bot, store, calls } = makeBot([], {
    async updateBlockStatus() { throw new Error('socket exploded'); },
    async fetchBlocklist() { throw new Error('socket exploded'); },
    async chatModify() { throw new Error('phone offline'); },
    async sendMessage() { throw new Error('no route'); },
    async query() { throw new Error('404'); }
  });
  const incident = await bot.inspect(attack());
  assert.equal(incident.actions.delete.status, 'fail');
  assert.equal(incident.actions.block.status, 'fail');
  assert.equal(incident.actions.notify.status, 'fail');
  assert.equal(store.state.stats.alertsFailed, 1, 'a failed alert is counted, not retried forever');
  assert.equal(store.state.stats.threatsDetected, 1, 'the incident is still on the record');
  assert.equal(calls.length, 0);
  const saved = fs.readdirSync(path.join(store.dir, 'outbox'));
  assert.equal(saved.length, 1, 'the brief is kept on disk so nothing is lost');
});

test('owner commands answer over whatsapp and change live settings', async () => {
  const { bot, calls } = makeBot();
  await bot.maybeCommand({ key: { remoteJid: '94771111111@s.whatsapp.net', fromMe: true }, message: { conversation: '!status' } });
  assert.match(calls.at(-1)[2], /AntiBugBot status/);
  await bot.maybeCommand({ key: { remoteJid: '94771111111@s.whatsapp.net', fromMe: true }, message: { conversation: '!threshold 3500' } });
  assert.equal(bot.config.thresholdChars, 3500);
  assert.match(calls.at(-1)[2], /trigger is now 3500/);
  await bot.maybeCommand({ key: { remoteJid: '94771111111@s.whatsapp.net', fromMe: true }, message: { conversation: '!help' } });
  assert.match(calls.at(-1)[2], /AntiBugBot commands/);
});

test('strangers cannot issue commands', async () => {
  const { bot, calls } = makeBot();
  const handled = await bot.maybeCommand({ key: { remoteJid: '94779999999@s.whatsapp.net', fromMe: false }, message: { conversation: '!unblock 94770000000' } });
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

test('rate limited enforcement keeps working instead of dropping incidents', async () => {
  const { bot, store } = makeBot(['--report-attempts', '0', '--quiet']);
  bot.enforcer.limiter.maxPerMinute = 3;
  const messages = Array.from({ length: 3 }, (_, i) => attack({ key: { remoteJid: `9477000000${i}@s.whatsapp.net`, id: 'F' + i, fromMe: false } }));
  await Promise.all(messages.map((message) => bot.inspect(message)));
  await bot.enforcer.drain();
  assert.equal(store.state.stats.threatsDetected, 3);
});

test('stop() drains queued work and persists state', async () => {
  const { bot, store, dir } = makeBot();
  await bot.inspect(attack({ key: { remoteJid: '94770000000@s.whatsapp.net', id: 'Q1', fromMe: false } }));
  await bot.stop();
  const reloaded = new StateStore({ dir }).load();
  assert.equal(reloaded.state.incidents.length, 1);
  assert.equal(reloaded.state.stats.blocked, 1);
});
