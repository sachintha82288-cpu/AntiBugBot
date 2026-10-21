import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ReportEngine, buildEvidencePacket, renderPacketText } from '../src/actions/report.js';
import { StateStore } from '../src/core/store.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'antibug-' + name + '-'));

const baseConfig = (over = {}) => ({
  thresholdChars: 2000,
  countMode: 'max',
  reportAttempts: 3,
  reportChannel: 'auto',
  reportMinIntervalMs: 0,
  reportJitterMs: 0,
  reportTimeoutMs: 2000,
  reportProbeIq: true,
  bridgeUrl: '',
  bridgeToken: '',
  shieldMode: 'enforce',
  data: tmp('report'),
  ...over
});

const incident = {
  id: 'INC-TEST-1',
  timestamp: 1_700_000_000,
  createdAt: new Date().toISOString(),
  mode: 'enforce',
  sender: { jid: '94770000000@s.whatsapp.net', phone: '+94770000000', pushName: 'Crash Bot' },
  chat: { jid: '94770000000@s.whatsapp.net', isGroup: false },
  message: { id: 'ABC123', type: 'conversation' },
  detection: {
    counted: 2600,
    threshold: 2000,
    risk: 100,
    rules: [{ id: 'oversize', label: 'Oversized message', detail: '600 over' }],
    preview: 'x'.repeat(80),
    metrics: { bytes: 2600, lines: 1, graphemes: 2600, codeUnits: 2600, invisible: 0, unicodeTags: 0, controlChars: 0, zwj: 0, rtlOverrides: 0, unpairedSurrogates: 0 }
  },
  actions: { delete: { status: 'ok' }, block: { status: 'ok' } }
};

const fakeSocket = (over = {}) => ({
  calls: [],
  async query(node) {
    this.calls.push(['query', node?.attrs?.xmlns]);
    const error = new Error('404 unsupported');
    throw error;
  },
  async sendMessage(jid, content) {
    this.calls.push(['sendMessage', jid, Object.keys(content).join('+')]);
    return { key: { id: 'X' } };
  },
  ...over
});

test('with no socket report call, the engine admits it and writes a packet', async () => {
  const dir = tmp('evidence');
  const store = new StateStore({ dir }).load();
  const config = baseConfig();
  const engine = new ReportEngine({ config, store });
  const conn = fakeSocket();
  const capability = await engine.probe(conn);
  assert.equal(capability.channel, 'evidence');
  assert.equal(capability.native, null);
  assert.equal(capability.iq, false);

  const result = await engine.file(conn, incident);
  assert.equal(result.filed, 0, 'never claim reports that were not accepted');
  assert.equal(result.attempts, 3);
  assert.equal(result.channel, 'evidence');
  assert.match(result.note, /no socket-side report call/);
  assert.ok(fs.existsSync(result.packetPath), 'evidence packet written to disk');
  const packet = JSON.parse(fs.readFileSync(result.packetPath, 'utf8'));
  assert.equal(packet.evidence.messageId, 'ABC123');
  assert.equal(packet.evidence.characters, 2600);
  assert.equal(packet.target.phone, '+94770000000');
  assert.match(fs.readFileSync(result.packetPath.replace('.json', '.txt'), 'utf8'), /Abuse report packet|abuse report packet/i);
});

test('a reachable bridge gets every attempt, and successes are counted', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      hits.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(req.url === '/report' ? 202 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const store = new StateStore({ dir: tmp('bridge') }).load();
    const config = baseConfig({
      reportChannel: 'bridge',
      reportAttempts: 30,
      bridgeUrl: `http://127.0.0.1:${port}`,
      bridgeToken: 'secret'
    });
    const engine = new ReportEngine({ config, store });
    const conn = fakeSocket();
    const capability = await engine.probe(conn);
    assert.equal(capability.bridge.reachable, true);
    assert.equal(capability.channel, 'bridge');

    const result = await engine.file(conn, incident);
    assert.equal(result.channel, 'bridge');
    assert.equal(result.filed, 30, '30 report submissions accepted');
    assert.equal(result.records.length, 30);
    assert.equal(store.state.stats.reportsFiled, 30);
    const reportHits = hits.filter((hit) => hit.url === '/report');
    assert.equal(reportHits.length, 30);
    assert.equal(reportHits[0].headers.authorization, 'Bearer secret');
    assert.equal(reportHits[0].body.incidentId, 'INC-TEST-1');
    assert.equal(reportHits[0].body.chars, 2600);
    assert.deepEqual(
      reportHits.map((hit) => hit.body.index),
      Array.from({ length: 30 }, (_, i) => i + 1),
      'attempts are ordered and paced'
    );
  } finally {
    server.close();
  }
});

test('a rejected bridge never inflates the filed count', async () => {
  const store = new StateStore({ dir: tmp('reject') }).load();
  const config = baseConfig({ reportAttempts: 2 });
  const engine = new ReportEngine({ config, store });
  const conn = fakeSocket({
    async query() { throw new Error('nope'); }
  });
  const result = await engine.file(conn, incident);
  assert.equal(result.filed, 0);
  assert.equal(store.state.stats.reportsFiled, 0);
});

test('a socket that does expose reportAbuse is used for real', async () => {
  const store = new StateStore({ dir: tmp('native') }).load();
  const config = baseConfig({ reportAttempts: 4 });
  const engine = new ReportEngine({ config, store });
  const seen = [];
  const conn = {
    async reportAbuse(jid, id, timestamp) { seen.push([jid, id, timestamp]); },
    async query() { throw new Error('no iq'); },
    async sendMessage() { throw new Error('unused'); }
  };
  const capability = await engine.probe(conn);
  assert.equal(capability.channel, 'native');
  const result = await engine.file(conn, incident);
  assert.equal(result.filed, 4);
  assert.equal(seen.length, 4);
  assert.deepEqual(seen[0], ['94770000000@s.whatsapp.net', 'ABC123', 1_700_000_000]);
});

test('reporting off is reported as off, not silently skipped', async () => {
  const engine = new ReportEngine({ config: baseConfig({ reportChannel: 'off', reportAttempts: 30 }), store: null });
  assert.equal(engine.enabled, false);
  const result = await engine.file(fakeSocket(), incident);
  assert.equal(result.channel, 'off');
  assert.equal(result.attempts, 0);
});

test('attempts zero means no work', async () => {
  const engine = new ReportEngine({ config: baseConfig({ reportAttempts: 0 }), store: null });
  const result = await engine.file(fakeSocket(), incident);
  assert.equal(result.attempts, 0);
  assert.equal(result.filed, 0);
});

test('an unsupported transport stops the loop instead of burning all 30 attempts', async () => {
  const store = new StateStore({ dir: tmp('fatal') }).load();
  const config = baseConfig({ reportChannel: 'bridge', reportAttempts: 30, bridgeUrl: 'http://127.0.0.1:9' });
  const engine = new ReportEngine({ config, store });
  const conn = { async query() { throw new Error('nope'); } };
  await engine.probe(conn);
  const result = await engine.file(conn, incident);
  assert.ok(result.attempts === 30);
  assert.ok(result.filed === 0);
  assert.ok(result.records.length <= 30, 'loop ends early or reports failures, never hangs');
});

test('evidence packets render for humans as well as machines', () => {
  const packet = buildEvidencePacket(incident, { thresholdChars: 2000, countMode: 'max', reportAttempts: 30, reportChannel: 'auto' });
  assert.match(packet.human, /incident:   INC-TEST-1/);
  assert.match(packet.human, /size:       2600 chars/);
  assert.match(packet.human, /Report → Report|Report$/m);
  assert.equal(packet.verdict, 'MEDIUM');
  assert.equal(packet.evidence.signals.length, 1);
  assert.match(renderPacketText(incident, {}), /AntiBugBot — abuse report packet/);
});
