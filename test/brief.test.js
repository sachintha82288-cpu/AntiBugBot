import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderArmNotice, renderStatsReply } from '../src/core/brief.js';
import { renderBrief } from '../src/core/brief.js';
import { measureText } from '../src/core/measure.js';
import { evaluateText } from '../src/core/guard.js';
import { buildIncident } from '../src/core/incident.js';

const config = { thresholdChars: 2000, countMode: 'max', heuristics: true, shieldMode: 'enforce', deleteMode: 'for-me', block: true, reportAttempts: 30, reportChannel: 'auto', groupsMode: 'observe' };

const makeIncident = (over = {}) => {
  const text = 'x'.repeat(2400) + '\u200b'.repeat(30);
  const decision = evaluateText(text, { threshold: 2000, countMode: 'max', heuristics: true });
  decision.text = text;
  const message = {
    key: { remoteJid: '94770000000@s.whatsapp.net', id: 'MSG99', fromMe: false },
    pushName: 'Crash Bot',
    messageTimestamp: 1_700_000_000,
    message: { conversation: text }
  };
  const incident = buildIncident({ message, decision, config, identity: {}, store: null });
  return { ...incident, ...over };
};

test('the owner brief answers who, what, how big, and what was done', () => {
  const incident = makeIncident();
  incident.actions = {
    delete: { status: 'ok', detail: 'deleted for me (device + linked devices)' },
    block: { status: 'ok', detail: 'blocked 94770000000@s.whatsapp.net' },
    notify: { status: 'ok' }
  };
  incident.reports = { attempts: 30, filed: 0, channel: 'evidence', note: 'no socket call', packetPath: 'data/reports/INC.txt' };
  const text = renderBrief(incident, { config, host: { jid: '94771111111@s.whatsapp.net' }, reports: incident.reports });

  assert.match(text, /AntiBugBot — threat neutralised/);
  assert.match(text, /\+94770000000/);
  assert.match(text, /2,430|2,430-character|2,430-character/);
  assert.match(text, /MSG99/);
  assert.match(text, /Oversized message/);
  assert.match(text, /✔ message — deleted for me/);
  assert.match(text, /✔ block — blocked/);
  assert.match(text, /reports — 0\/30 filed/);
  assert.match(text, /අකුරු/, 'Sinhala explanation included');
  assert.match(text, /මොකද වුණේ/, 'Sinhala heading included');
  assert.match(text, /ENFORCE/);
  assert.ok(text.length < 3000, `brief stays readable on a phone: ${text.length}`);
});

test('the brief tells the truth when a step failed', () => {
  const incident = makeIncident();
  incident.actions = {
    delete: { status: 'fail', detail: 'delete for me failed: phone offline' },
    block: { status: 'skip', detail: 'already on WhatsApp blocklist' },
    notify: { status: 'ok' }
  };
  incident.reports = { attempts: 30, filed: 12, channel: 'bridge', note: 'bridge partial' };
  const text = renderBrief(incident, { config, host: {}, reports: incident.reports });
  assert.match(text, /✖ message — delete for me failed/);
  assert.match(text, /◽ block — already on WhatsApp blocklist/);
  assert.match(text, /reports — 12\/30 filed via bridge/);
});

test('observe mode says so in the brief', () => {
  const incident = makeIncident({ mode: 'observe' });
  incident.actions = { delete: { status: 'dry', detail: 'observe mode — nothing deleted' }, block: { status: 'dry', detail: 'observe mode — not blocked' } };
  const text = renderBrief(incident, { config: { ...config, shieldMode: 'observe' }, host: {}, reports: { attempts: 30, filed: 0, channel: 'observe', note: 'observe mode — reports not filed', records: [] } });
  assert.match(text, /OBSERVE \(nothing enforced\)/);
  assert.match(text, /observe mode — nothing deleted/);
});

test('repeat offenders are called out with history', () => {
  const incident = makeIncident();
  incident.actions = {};
  const text = renderBrief(incident, { config, host: {}, repeat: { count: 4, lastAt: new Date().toISOString() } });
  assert.match(text, /repeat offender: 4 prior incident\(s\)/);
});

test('arm notice summarises the live policy', () => {
  const text = renderArmNotice({ jid: '94771111111@s.whatsapp.net' }, config, { channel: 'evidence' });
  assert.match(text, /AntiBugBot armed/);
  assert.match(text, /trigger  2,000 chars/);
  assert.match(text, /reports  30× via evidence/);
  assert.match(text, /block    on/);
  assert.match(text, /බලාගන්නවා/);
});

test('stats reply is compact enough for whatsapp', () => {
  const text = renderStatsReply(
    { stats: { messagesScanned: 12345, threatsDetected: 7, blocked: 6, deleted: 7, reportsFiled: 0, reportsAttempted: 210, alertsSent: 7, alertsFailed: 0, errors: 1 } },
    config,
    { channel: 'bridge' }
  );
  assert.match(text, /scanned  12,345 messages/);
  assert.match(text, /reports  0\/210 filed · channel bridge/);
  assert.ok(text.length < 600);
});

test('metrics survive being measured twice', () => {
  const incident = makeIncident();
  const first = measureText(incident.detection.preview || '');
  assert.ok(Number.isFinite(first.graphemes));
  assert.equal(incident.detection.metrics.invisible, 30);
  assert.equal(incident.detection.metrics.codeUnits, 2430);
  assert.equal(incident.detection.metrics.graphemes, 2430);
});
