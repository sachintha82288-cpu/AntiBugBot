#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, describeConfig, normalizePhone } from './config.js';
import { createStore } from './core/store.js';
import { createUi } from './ui/console.js';
import { box, elapsed, icon, pad, setColorMode, style } from './ui/theme.js';
import { AntiBugBot } from './bot.js';
import { Enforcer } from './actions/enforce.js';
import { ReportEngine } from './actions/report.js';
import { evaluateText } from './core/guard.js';
import { buildIncident } from './core/incident.js';
import { renderBrief } from './core/brief.js';
import { count, humanDate, maskPreview, relative } from './core/format.js';

import os from 'node:os';

const VERSION = '1.0.0';

const envWantsDataDir = () => Boolean(process.env.DATA_DIR);

const HELP = [
  '',
  '  AntiBugBot — WhatsApp crash-bug shield',
  '',
  '  usage: node src/index.js [command] [flags]',
  '',
  '  commands',
  '    start                     link the account and run the shield (default)',
  '    pair --number 9477...     link with a pairing code instead of a QR',
  '    status                    counters, config and last incidents (offline)',
  '    history --limit 20        incident ledger        (--json for raw records)',
  '    blocked                   numbers this shield has blocked',
  '    unblock <number>          clear a block from the shield ledger',
  '    whitelist list|add|remove <number>   never enforce against these',
  '    logout                    unlink the device and drop stored auth',
  '    selftest                  push a synthetic attack through the whole pipeline',
  '',
  '  flags',
  '    --threshold 2000          character trigger (default 2000)',
  '    --count-mode max          max | grapheme | utf16 | codepoints',
  '    --report-attempts 30      reports filed per incident',
  '    --report-channel auto     auto | native | bridge | evidence | off',
  '    --delete-mode for-me      for-me | revoke-if-able | off',
  '    --groups observe          enforce | observe | ignore',
  '    --mode observe            dry run: detect + alert, never touch the chat',
  '    --owner +94771234567      where briefs are sent (default: message yourself)',
  '    --whitelist 9477...,94... comma separated numbers to ignore',
  '    --country-code LK         expands local 077... numbers',
  '    --verbose | --quiet | --no-beep | --no-stats | --no-log-file',
  '    --no-block | --no-report | --no-heuristics | --no-color',
  '',
  '  env (see .env.example): THRESHOLD_CHARS, REPORT_ATTEMPTS, OWNER_NUMBER, GROUPS_MODE,',
  '                        SHIELD_MODE, DELETE_MODE, WA_BRIDGE_URL, WHITELIST, LOG_LEVEL',
  ''
].join('\n');

const finish = async (store, ui) => {
  try {
    await store.flush();
  } catch {
    /* never lose an exit over a disk hiccup */
  }
  await ui.close();
};

const main = async () => {
  const { config, command, positional, flags, errors } = loadConfig({ argv: process.argv.slice(2) });
  void envWantsDataDir;
  setColorMode(config.color === 'auto' ? 'auto' : config.color);
  const ui = createUi({
    level: config.logLevel,
    statsPanel: config.statsPanel,
    logFile: config.logFile ? path.join(config.data, 'logs', 'bot.log') : null
  });
  let store = createStore({ dir: config.data });

  const failFast = () => {
    if (errors.length === 0) return;
    ui.raw(box(
      errors.map((error) =>
        `${style.brightRed(icon('cross'))} ${style.bold(error.key)}\n${style.dim('   ' + error.message + '   got: ' + error.got)}`
      ),
      { title: ' CONFIG ERROR ', color: style.brightRed }
    ));
    ui.raw(style.dim('  fix it in .env or pass the flag on the command line — see `node src/index.js help`'));
    process.exitCode = 2;
    return true;
  };

  if (flags.help || command === 'help' || command === '?') {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (failFast()) return;

  if (store.recovered) {
    ui.warn?.('store', `state file was unreadable (${store.recovered.error}) — rebuilt from scratch, old copy at ${store.recovered.backup}`);
  }

  switch (command) {
    case 'status':
      return showStatus({ config, store, ui });
    case 'history':
      return showHistory({ config, store, ui, flags });
    case 'blocked':
      return showBlocked({ config, store, ui });
    case 'selftest': {
      // (see below: exit code is propagated)
      // A verification run must be deterministic: unless the operator pointed us at
      // a data dir on purpose, work in a scratch copy that starts empty.
      if (!flags['data-dir'] && !envWantsDataDir()) {
        const scratch = path.join(os.tmpdir(), 'antibugbot-selftest');
        fs.rmSync(scratch, { recursive: true, force: true });
        config.data = scratch;
        store = createStore({ dir: scratch });
        ui.note(`selftest runs against a scratch ledger: ${scratch}`);
      }
      process.exitCode = (await selfTest({ config, store, ui, flags })) || 0;
      return;
    }
    case 'whitelist':
      return whitelistCommand({ config, store, ui, positional, flags });
    case 'logout':
      return logout({ config, store, ui });
    case 'unblock':
      return unblockCommand({ config, store, ui, positional });
    case 'start':
    case 'pair':
      return run({ config, store, ui, command, flags });
    default:
      ui.raw(box([
        `${style.brightRed(icon('cross'))} unknown command ${style.bold(command)}`,
        style.dim('  try: start · status · history · selftest · blocked · unblock · whitelist · logout')
      ], { title: ' ANTI-BUGBOT ', color: style.brightRed }));
      process.exitCode = 2;
      return undefined;
  }
};

const run = async ({ config, store, ui, command, flags }) => {
  fs.mkdirSync(config.auth, { recursive: true });
  fs.mkdirSync(config.data, { recursive: true });
  ui.banner({
    version: VERSION,
    threshold: config.thresholdChars,
    reportAttempts: config.reportAttempts,
    deleteMode: config.deleteMode,
    groupsMode: config.groupsMode,
    shieldMode: config.shieldMode,
    owner: config.ownerNumber ? `+${config.ownerNumber}` : 'self chat',
    baileys: '7.0.0-rc14'
  });

  ui.keyPanel('RUNTIME CONFIG', describeConfig(config).map(([key, value]) => [key, value]), style.cyan);

  const bot = new AntiBugBot({ config, store, ui });
  if (command === 'pair' || flags.pair) {
    const number = positional[1] || flags.number || config.ownerNumber || '';
    if (!number) {
      ui.fail('pairing needs the phone number:  node src/index.js pair --number 94771234567');
      process.exitCode = 2;
      await ui.close();
      return;
    }
    bot.setPhase('pairing');
    await bot.connect();
    try {
      const code = await bot.conn.requestPairingCode(String(number).replace(/\D/g, ''));
      ui.pairingCode(code || '');
      ui.note('give that code to the phone you want to link — the shield arms automatically once it accepts.');
    } catch (error) {
      ui.fail(`pairing code failed: ${error.message}`);
      ui.note('falling back to the QR code on this screen');
    }
  } else {
    await bot.start();
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.raw('');
    ui.note(`${icon('clock')} ${signal} received — finishing ${store.state.incidents.length ? 'queued enforcement' : 'shutdown'}, saving state…`);
    const started = Date.now();
    await bot.stop();
    const snapshot = store.snapshot();
    await store.flush();
    ui.raw(box([
      ` ${style.dim(pad('scanned', 12))}${count(snapshot.stats.messagesScanned)}`,
      ` ${style.dim(pad('threats', 12))}${count(snapshot.stats.threatsDetected)}`,
      ` ${style.dim(pad('blocked', 12))}${pad(count(snapshot.stats.blocked) + ' numbers', 18)}${style.dim('deleted ')}${count(snapshot.stats.deleted)}`,
      ` ${style.dim(pad('reports', 12))}${pad(count(snapshot.stats.reportsFiled) + '/' + count(snapshot.stats.reportsAttempted) + ' filed', 18)}${style.dim('alerts ')}${count(snapshot.stats.alertsSent)}`,
      ` ${style.dim(pad('uptime', 12))}${pad(elapsed(Date.now() - (bot.identity.host.startedAt || Date.now())), 18)}${style.dim('errors ')}${count(snapshot.stats.errors)}`,
      ` ${style.dim('state saved in ' + elapsed(Date.now() - started))}`
    ], { title: ' NEST CLOSED ', color: style.cyan }));
    await ui.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    store.increment('errors');
    ui.error('crash', `unhandled rejection: ${reason?.stack || reason}`);
  });
  process.on('uncaughtException', (error) => {
    store.increment('errors');
    ui.error('crash', `uncaught exception: ${error.stack || error.message}`);
    store.flush().finally(() => setTimeout(() => process.exit(1), 250));
  });

  setInterval(() => ui.renderStrip(), 1000).unref?.();
};

const showStatus = async ({ config, store, ui }) => {
  const snapshot = store.snapshot();
  const last = snapshot.updatedAt ? relative(snapshot.updatedAt) : 'never';
  ui.raw(box([
    ` ${style.dim(pad('mode', 16))}${config.shieldMode === 'observe' ? style.brightYellow('OBSERVE') : style.brightGreen('ENFORCE')}` +
      `   ${style.dim(pad('trigger', 10))}${style.cyan(count(config.thresholdChars) + ' chars')}`,
    ` ${style.dim(pad('scanned', 16))}${count(snapshot.stats.messagesScanned)}` +
      `   ${style.dim(pad('threats', 10))}${style.yellow(count(snapshot.stats.threatsDetected))}`,
    ` ${style.dim(pad('blocked', 16))}${count(snapshot.stats.blocked)} (${snapshot.blockedCount} active)` +
      `   ${style.dim(pad('deleted', 10))}${count(snapshot.stats.deleted)}`,
    ` ${style.dim(pad('reports', 16))}${count(snapshot.stats.reportsFiled)}/${count(snapshot.stats.reportsAttempted)} filed` +
      `   ${style.dim(pad('alerts', 10))}${count(snapshot.stats.alertsSent)}`,
    ` ${style.dim(pad('errors', 16))}${count(snapshot.stats.errors)}` +
      `   ${style.dim(pad('saved', 10))}${last}`,
    '',
    style.dim(' incidents kept in memory: ') + snapshot.incidentCount +
      style.dim('   ledger: ') + path.join(config.data, 'incidents.jsonl')
  ], { title: ' SHIELD STATUS ', color: style.brightCyan }));

  const recent = store.recentIncidents(5);
  if (recent.length) {
    ui.raw(box(recent.map((incident) =>
      ` ${style.gray(humanDate(incident.createdAt))}  ${style.cyan(pad(String(incident.sender?.phone || ''), 16))}` +
      ` ${style.yellow(pad(count(incident.detection?.counted) + 'c', 10))}` +
      ` ${style.dim((incident.detection?.rules || []).map((rule) => rule.id).join('+'))}` +
      ` ${style.brightRed(incident.actions?.block?.status === 'ok' ? 'blocked' : '')}`
    ), { title: ' LAST INCIDENTS ', color: style.gray }));
  } else {
    ui.note('no incidents yet — send yourself a 2,100-character message to see the shield work.');
  }
  await ui.close();
};

const showHistory = async ({ config, store, ui, flags }) => {
  const limit = Number(flags.limit) || 20;
  const incidents = store.recentIncidents(limit);
  if (flags.json) {
    process.stdout.write(JSON.stringify(incidents, null, 2) + '\n');
    return;
  }
  if (!incidents.length) {
    ui.note(`no incidents recorded in ${path.join(config.data, 'state.json')}`);
    await ui.close();
    return;
  }
  const rows = incidents.map((incident, index) =>
    ` ${style.gray(pad('#' + (index + 1), 4))} ${style.cyan(pad(incident.id, 30))} ${style.yellow(pad(count(incident.detection?.counted) + 'c', 8))} ` +
    `${style.dim(humanDate(incident.createdAt))}\n      sender ${incident.sender?.phone} · rules ${(incident.detection?.rules || []).map((r) => r.id).join('+')} · ` +
    `block ${incident.actions?.block?.status || '—'} · delete ${incident.actions?.delete?.status || '—'} · ` +
    `reports ${(incident.reports?.filed ?? 0)}/${(incident.reports?.attempts ?? 0)}`
  );
  ui.raw(box(rows, { title: ` INCIDENT HISTORY (last ${limit}) `, color: style.cyan }));
  await finish(store, ui);
};

const showBlocked = async ({ store, ui }) => {
  const entries = Object.values(store.state.blocked);
  if (!entries.length) {
    ui.note('nothing blocked yet.');
    await finish(store, ui);
    return;
  }
  ui.raw(box(entries.map((entry) =>
    ` ${style.cyan(pad(String(entry.jid).replace(/@.*/, ''), 18))} ${style.dim(humanDate(entry.blockedAt))}` +
    ` ${style.gray('×' + (entry.blockCount || 1))} ${style.dim(entry.reason || '')}`
  ), { title: ` BLOCKED (${entries.length}) `, color: style.brightRed }));
  ui.note('unblock with: node src/index.js unblock <number>');
  await finish(store, ui);
};

const whitelistCommand = async ({ config, store, ui, positional, flags }) => {
  const action = positional[1] || (flags.number ? 'add' : 'list');
  const dial = { LK: '94', IN: '91', PK: '92', BD: '880' }[String(config.countryCode).toUpperCase()] || '94';
  const raw = String(positional[2] || flags.number || '');
  const number = normalizePhone(raw, dial);
  const jid = number ? `${number}@s.whatsapp.net` : '';
  if ((action === 'add' || action === 'remove') && !number) {
    ui.fail(`usage: node src/index.js whitelist ${action} <number>   e.g. 0771234567 or +94771234567`);
    process.exitCode = 2;
    await finish(store, ui);
    return;
  }
  if (action === 'add' && jid) {
    store.addWhitelist(jid, 'manual');
    ui.done(`${jid.replace('@s.whatsapp.net', '')} added to the whitelist (${config.data})`);
  } else if (action === 'remove' && jid) {
    const removed = store.removeWhitelist(jid);
    if (removed) ui.done(`${jid.replace('@s.whatsapp.net', '')} removed from the whitelist`);
    else ui.fail('that number was not whitelisted');
  } else {
    const entries = Object.values(store.state.whitelist);
    if (!entries.length) ui.note('whitelist is empty');
    else ui.raw(box(entries.map((entry) => ` ${style.cyan(pad(String(entry.jid).replace(/@.*/, ''), 18))} ${style.dim(entry.note || '')} ${style.gray(relative(entry.addedAt))}`),
      { title: ` WHITELIST (${entries.length}) `, color: style.brightGreen }));
  }
  await finish(store, ui);
};

const unblockCommand = async ({ config, store, ui, positional }) => {
  const number = String(positional[1] || '').replace(/\D/g, '');
  if (!number) {
    ui.fail('usage: node src/index.js unblock <number>   e.g. 94771234567');
    process.exitCode = 2;
    await ui.close();
    return;
  }
  const jid = `${number}@s.whatsapp.net`;
  const known = store.state.blocked[jid];
  if (!known) {
    ui.warn?.('unblock', `${jid.replace('@s.whatsapp.net', '')} is not in this shield's ledger — removing on the phone needs a live session.`);
  }
  store.removeBlock(jid);
  ui.done(`${number} cleared from the shield ledger.`);
  ui.note('start the bot and it will call the real unblock on WhatsApp for you (or send !unblock ' + number + ' to your own chat).');
  void config;
  await finish(store, ui);
};

const logout = async ({ config, store, ui }) => {
  const authFiles = fs.existsSync(config.auth) ? fs.readdirSync(config.auth) : [];
  if (!authFiles.length) {
    ui.note('no stored session — nothing to log out.');
    await ui.close();
    return;
  }
  ui.warn?.('logout', `this unlinks the device and removes ${config.auth} (${authFiles.length} files)`);
  const bot = new AntiBugBot({ config, store, ui });
  await bot.connect();
  ui.note('contacting WhatsApp to unregister this linked device…');
  const result = await bot.logout();
  if (result.status === 'ok') ui.done('device unlinked');
  else ui.fail(`server did not confirm (${result.detail}) — removing local auth anyway`);
  fs.rmSync(config.auth, { recursive: true, force: true });
  ui.done(`auth folder removed. data (incidents, ledger) kept in ${config.data}`);
  await finish(store, ui);
};

/**
 * Runs a synthetic attack through the real pipeline with a fake socket, so the
 * whole chain — detection, delete, block, reports, brief — can be verified
 * without a phone and without touching WhatsApp.
 */
export const selfTest = async ({ config, store, ui, flags }) => {
  const threshold = config.thresholdChars;
  const samples = [
    { name: 'clean short message', text: 'hey, are we still on for tomorrow?' },
    { name: 'exactly at the trigger', text: 'x'.repeat(threshold) },
    { name: 'one over the trigger', text: 'x'.repeat(threshold + 1) },
    { name: 'zero-width inflation', text: 'x'.repeat(Math.floor(threshold / 2)) + '\u200b'.repeat(400) + '\u202E'.repeat(12) },
    { name: 'unicode tag block', text: 'a'.repeat(60) + '\u{E0041}'.repeat(300) },
    { name: 'zwj emoji bomb', text: '\u{1F468}\u200D'.repeat(600) }
  ];

  ui.raw(box(samples.map((sample) => {
    const decision = evaluateText(sample.text, {
      threshold,
      countMode: config.countMode,
      heuristics: config.heuristics
    });
    const verdict = decision.triggered
      ? style.brightRed(`${icon('flag')} flagged`)
      : style.brightGreen(`${icon('check')} clean`);
    return ` ${style.dim(pad(sample.name, 26))} ${style.yellow(pad(count(decision.counted) + 'c', 9))} ${pad(verdict, 14)} ` +
      style.dim(decision.rules.map((rule) => rule.id).join(' + ') || '—');
  }), { title: ` DETECTION MATRIX (trigger ${count(threshold)} chars) `, color: style.brightCyan }));

  const calls = [];
  const fakeConn = {
    async updateBlockStatus(jid, action) { calls.push(['updateBlockStatus', action, jid]); },
    async fetchBlocklist() { return []; },
    async chatModify(mod, jid) { calls.push(['chatModify', Object.keys(mod)[0], jid]); },
    async sendMessage(jid, content) { calls.push(['sendMessage', jid, Object.keys(content).join('+')]); return { key: { id: 'FAKE-' + calls.length } }; },
    async query(node) { calls.push(['query', node?.attrs?.xmlns || 'iq']); const error = new Error('404 unsupported'); throw error; }
  };

  const reportEngine = new ReportEngine({ config: { ...config, reportMinIntervalMs: 5, reportJitterMs: 2 }, store, ui: null });
  const enforcer = new Enforcer({
    config: { ...config, reportMinIntervalMs: 5, reportJitterMs: 2, beepOnThreat: false },
    store,
    ui,
    reportEngine,
    identity: {
      me: { id: '94771111111:12@s.whatsapp.net', name: 'SelfTest' },
      ownerJid: '',
      host: { jid: '94771111111@s.whatsapp.net' }
    }
  });

  const text = 'x'.repeat(threshold + 540) + '\u200b'.repeat(60);
  const decision = evaluateText(text, { threshold, countMode: config.countMode, heuristics: config.heuristics });
  decision.text = text;
  const message = {
    key: { remoteJid: '94770000000@s.whatsapp.net', id: 'SELFTEST01', fromMe: false },
    pushName: 'Crash Bot',
    messageTimestamp: Math.floor(Date.now() / 1000) - 45,
    message: { conversation: text }
  };
  const identity = { me: { id: '94771111111:12@s.whatsapp.net' }, host: { jid: '94771111111@s.whatsapp.net' } };
  const incident = buildIncident({ message, decision, config, identity, store });
  incident.senderLabel = incident.sender.display;
  incident.brief = renderBrief(incident, { config, host: identity.host, repeat: { count: 0, lastAt: null } });

  ui.raw(box([
    ` ${style.dim(pad('sender', 12))}${style.cyan(incident.sender.phone)}  ${style.gray('"' + incident.sender.pushName + '"')}`,
    ` ${style.dim(pad('payload', 12))}${style.yellow(count(decision.counted) + ' chars')} ${style.dim('→ ' + maskPreview(decision.preview, 34))}`,
    ` ${style.dim(pad('brief', 12))}${style.dim(count(incident.brief.length) + ' characters for the owner chat')}`
  ], { title: ' SYNTHETIC ATTACK ', color: style.brightRed }));

  await enforcer.process({ conn: fakeConn, message, decision, incident });
  await store.flush();

  const observing = config.shieldMode === 'observe';
  const enforcementDisabled =
    !config.block && config.deleteMode === 'off' && config.reportAttempts === 0;
  const expect = {
    none: enforcementDisabled,
    delete: observing ? 'dry' : config.deleteMode === 'off' ? 'skip' : 'ok',
    block: observing ? 'dry' : config.block ? 'ok' : 'skip',
    socketCalls: !observing && config.block && config.deleteMode !== 'off'
  };
  const checks = [
    ['detection fired', decision.triggered === true],
    ['delete call reached the socket', expect.socketCalls ? calls.some((call) => call[0] === 'chatModify') : true, expect.socketCalls],
    ['block call reached the socket', expect.socketCalls ? calls.some((call) => call[0] === 'updateBlockStatus' && call[1] === 'block') : true, expect.socketCalls],
    ['owner brief attempted', enforcementDisabled || calls.some((call) => call[0] === 'sendMessage' && /@s\.whatsapp\.net$/.test(String(call[1])))],
    ['report engine resolved a channel', enforcementDisabled || Boolean(incident.reports?.channel), !enforcementDisabled],
    ['incident persisted', enforcementDisabled || store.state.incidents.some((item) => item.id === incident.id)],
    ['delete outcome', [expect.delete, 'skip'].includes(incident.actions?.delete?.status) || config.deleteMode === 'off'],
    ['block outcome', enforcementDisabled || [expect.block, 'skip'].includes(incident.actions?.block?.status), !enforcementDisabled]
  ];

  if (enforcementDisabled) {
    ui.note('every enforcement action is switched off, so nothing was sent to the socket — detection and alerting are still verified.');
  }
  ui.raw(box(checks.map(([label, ok, applies = true]) =>
    ` ${ok ? style.brightGreen(icon('check')) : style.brightRed(icon('cross'))} ${pad(label, 34)} ${applies ? '' : style.gray('(not applicable)')}`
  ), { title: ' PIPELINE CHECK ', color: style.brightCyan }));

  ui.raw('');
  ui.raw(style.brightGreen('  ' + icon('mail') + ' OWNER BRIEF — exactly what your number receives'));
  ui.raw(style.dim('  ' + '─'.repeat(58)));
  for (const line of incident.brief.split('\n')) {
    ui.raw('  ' + (line.startsWith('*') ? style.bold(line.replace(/\*/g, '')) : line));
  }
  ui.raw(style.dim('  ' + '─'.repeat(58)));
  const passed = checks.filter(([, ok]) => ok).length;
  if (passed === checks.length) {
    ui.done(`selftest passed — ${passed}/${checks.length} checks · pipeline is wired end to end`);
    await finish(store, ui);
    return 0;
  }
  ui.fail(`selftest ${passed}/${checks.length}`);
  await finish(store, ui);
  return 1;
};

main()
  .catch((error) => {
    process.stderr.write('\n' + (error?.stack || error?.message || String(error)) + '\n');
    process.exitCode = 1;
  });
