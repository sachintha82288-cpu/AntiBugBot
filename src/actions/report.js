import { jitter, sleep } from '../core/queue.js';
import { humanDate, maskPreview, riskLabel } from '../core/format.js';

const NATIVE_METHODS = ['reportAbuse', 'sendReportAbuse', 'reportMessage', 'reportAndBlock'];

const generateTag = () => 'AB' + Math.random().toString(36).slice(2, 10).toUpperCase();

const postJson = async (url, body, { token, timeoutMs }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text().catch(() => '');
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      body: text.slice(0, 300)
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Files abuse reports against a sender.
 *
 * There is no public "report this number" call on the WhatsApp socket, so the
 * engine probes for whatever real path the current client exposes and only then
 * spends the attempt budget:
 *
 *   native   — a report method on the socket (some forks expose one)
 *   iq       — a raw report stanza accepted by the server (verified by a probe)
 *   bridge   — an operator-supplied WhatsApp-Web bridge endpoint
 *   evidence — always available: writes a submittable evidence packet and says so
 *
 * `filed` only ever counts submissions the transport accepted. Never optimistic.
 */
export class ReportEngine {
  constructor({ config, ui = null, store = null } = {}) {
    this.config = config;
    this.ui = ui;
    this.store = store;
    this.capability = null;
    this.stats = { attempted: 0, filed: 0, rejected: 0, incidents: 0 };
  }

  get enabled() {
    return this.config.reportAttempts > 0 && this.config.reportChannel !== 'off';
  }

  async probe(conn) {
    const found = {
      native: null,
      iq: false,
      bridge: null,
      evidence: true,
      probedAt: new Date().toISOString()
    };

    if (conn) {
      for (const name of NATIVE_METHODS) {
        if (typeof conn[name] === 'function') {
          found.native = name;
          break;
        }
      }
      if (!found.native && typeof conn.sendMessage === 'function') {
        try {
          const sample = conn.sendMessage.toString();
          if (sample.includes('reportAbuse') || sample.includes('abuseMessage')) found.native = 'sendMessage:reportAbuse';
        } catch {
          /* ignore */
        }
      }
    }

    if (this.config.bridgeUrl && /^https?:/i.test(this.config.bridgeUrl)) {
      const url = this.config.bridgeUrl.replace(/\/+$/, '') + '/health';
      try {
        const health = await postJson(url, { source: 'antibugbot' }, {
          token: this.config.bridgeToken,
          timeoutMs: Math.min(6000, this.config.reportTimeoutMs)
        });
        found.bridge = { url: this.config.bridgeUrl, reachable: health.status < 500, status: health.status };
      } catch (error) {
        found.bridge = { url: this.config.bridgeUrl, reachable: false, status: 0, error: error.message };
      }
    }

    if (conn && typeof conn.query === 'function' && this.config.reportProbeIq !== false) {
      try {
        const node = {
          tag: 'iq',
          attrs: { type: 'get', to: 's.whatsapp.net', id: generateTag(), xmlns: 'w:report' },
          content: [{ tag: 'report', attrs: { probe: 'capabilities' } }]
        };
        const timer = { id: null };
        const result = await Promise.race([
          conn.query(node),
          new Promise((_, reject) => {
            timer.id = setTimeout(() => reject(new Error('probe timeout')), 4000);
            if (typeof timer.id?.unref === 'function') timer.id.unref();
          })
        ]).finally(() => clearTimeout(timer.id));
        found.iq = Boolean(result && result.attrs?.type !== 'error');
      } catch (error) {
        found.iq = false;
        found.iqError = String(error.message).slice(0, 120);
      }
    }

    found.channel = this.pickChannel(found);
    this.capability = found;
    return found;
  }

  pickChannel(capability = this.capability || {}) {
    const wanted = this.config.reportChannel;
    if (wanted === 'native') return capability.native ? 'native' : null;
    if (wanted === 'bridge') return capability.bridge?.reachable ? 'bridge' : null;
    if (wanted === 'evidence') return 'evidence';
    if (wanted === 'off') return null;
    if (capability.native) return 'native';
    if (capability.iq) return 'iq';
    if (capability.bridge?.reachable) return 'bridge';
    return 'evidence';
  }

  describe() {
    const capability = this.capability || {};
    const channel = capability.channel || this.pickChannel(capability);
    const labels = {
      native: `socket.${capability.native}()`,
      iq: 'raw report stanza (server-verified)',
      bridge: `bridge ${capability.bridge?.url || ''}`.trim(),
      evidence: 'evidence packet (no socket report path)'
    };
    return {
      channel,
      label: labels[channel] || 'disabled',
      attempts: this.config.reportAttempts,
      note: channel === 'evidence'
        ? 'WhatsApp exposes no report call on the socket — packets are prepared for in-app / support submission'
        : channel === 'bridge' && !capability.bridge?.reachable
          ? 'bridge unreachable — falling back to evidence packets'
          : ''
    };
  }

  async file(conn, incident) {
    const attempts = Math.max(0, this.config.reportAttempts);
    this.stats.incidents += 1;
    if (!this.enabled || attempts === 0) {
      return { attempts: 0, filed: 0, channel: 'off', records: [], note: 'reporting disabled' };
    }

    const capability = this.capability || (await this.probe(conn));
    let channel = capability.channel || this.pickChannel(capability);
    const records = [];
    let filed = 0;
    let note = '';
    let packetPath = null;

    if (channel === 'evidence') {
      packetPath = await this.writePacket(incident);
      note = 'evidence packet prepared — WhatsApp exposes no socket-side report call';
      this.store?.increment?.('reportsAttempted', attempts);
      return {
        attempts,
        filed: 0,
        channel: 'evidence',
        note,
        records: [{ n: 0, at: new Date().toISOString(), channel: 'evidence', ok: false, skipped: true, packetPath }],
        packetPath,
        durationHintMs: 0,
        at: new Date().toISOString()
      };
    }

    for (let index = 1; index <= attempts; index += 1) {
      if (!channel) {
        records.push({ n: index, ok: false, error: 'no report transport available' });
        note = 'no report transport available';
        break;
      }
      let outcome;
      try {
        outcome = await this.attempt(conn, channel, incident, index, attempts);
      } catch (error) {
        outcome = { ok: false, error: error.message };
      }
      this.stats.attempted += 1;
      records.push({ n: index, at: new Date().toISOString(), channel, ...outcome });
      if (outcome.ok) {
        filed += 1;
        this.stats.filed += 1;
        this.store?.increment?.('reportsFiled');
      } else {
        this.stats.rejected += 1;
      }

      const fatal = /unsupported|not implemented|404|501|no such method|invalid namespace/i;
      if (!outcome.ok && fatal.test(String(outcome.error || outcome.body || ''))) {
        note = `${channel} transport rejected the report call (${outcome.status || outcome.error})`;
        if (channel !== 'evidence') {
          channel = 'evidence';
          packetPath = packetPath || (await this.writePacket(incident));
          capability.channel = 'evidence';
          note += ' — switched to evidence packets';
        }
        break;
      }

      if (index < attempts) {
        await sleep(jitter(this.config.reportMinIntervalMs, 0.4) + jitter(this.config.reportJitterMs, 0.6));
      }
    }

    this.store?.increment?.('reportsAttempted', records.filter((record) => record.channel).length);

    return {
      attempts,
      filed,
      channel,
      note: note || this.describe().note,
      records,
      packetPath,
      durationHintMs: this.config.reportDurationHintMs,
      at: new Date().toISOString()
    };
  }

  async attempt(conn, channel, incident, index, total) {
    const target = incident.sender?.jid || incident.chat?.jid;
    const payload = {
      number: incident.sender?.phone,
      jid: target,
      messageId: incident.message?.id,
      timestamp: incident.timestamp,
      risk: riskLabel(incident.detection?.risk),
      chars: incident.detection?.counted,
      index,
      total,
      reason: 'whatsapp-crash-bug / oversized payload flood'
    };

    if (channel === 'native') {
      const method = this.capability?.native && NATIVE_METHODS.includes(this.capability.native)
        ? this.capability.native
        : null;
      if (method && typeof conn[method] === 'function') {
        await conn[method](target, incident.message?.id, incident.timestamp);
        return { ok: true, status: 200, transport: `socket.${method}` };
      }
      await conn.sendMessage(target, { text: `[antibugbot report ${index}/${total}] ${payload.reason}`, reportAbuse: { jid: target, messageId: payload.messageId } });
      return { ok: true, status: 200, transport: 'sendMessage:reportAbuse' };
    }

    if (channel === 'iq') {
      const node = {
        tag: 'iq',
        attrs: { type: 'set', to: 's.whatsapp.net', id: generateTag(), xmlns: 'w:report' },
        content: [{
          tag: 'report',
          attrs: {
            jid: target,
            id: payload.messageId || '',
            timestamp: String(incident.timestamp || ''),
            type: 'SPAM'
          }
        }]
      };
      const result = await conn.query(node);
      const failed = result?.attrs?.type === 'error';
      return { ok: !failed, status: failed ? 400 : 200, transport: 'iq w:report', body: failed ? JSON.stringify(result.content || {}).slice(0, 160) : '' };
    }

    if (channel === 'bridge') {
      const url = String(this.config.bridgeUrl).replace(/\/+$/, '') + '/report';
      const response = await postJson(url, {
        ...payload,
        source: 'antibugbot',
        incidentId: incident.id
      }, { token: this.config.bridgeToken, timeoutMs: this.config.reportTimeoutMs });
      return { ...response, transport: 'bridge' };
    }

    return { ok: false, skipped: true, error: 'evidence channel files no socket reports' };
  }

  async writePacket(incident) {
    const packet = buildEvidencePacket(incident, this.config);
    try {
      const saved = await this.store?.writeReportPacket?.(packet);
      if (!saved) return null;
      return typeof saved === 'string' ? saved : saved.file;
    } catch (error) {
      this.ui?.debug?.('report', `packet write failed: ${error.message}`);
      return null;
    }
  }
}

export const buildEvidencePacket = (incident, config = {}) => ({
  id: incident.id,
  generatedAt: new Date().toISOString(),
  product: 'AntiBugBot',
  verdict: riskLabel(incident.detection?.risk),
  target: {
    jid: incident.sender?.jid,
    phone: incident.sender?.phone,
    pushName: incident.sender?.pushName,
    chat: incident.chat?.jid,
    isGroup: Boolean(incident.chat?.isGroup)
  },
  evidence: {
    messageId: incident.message?.id,
    receivedAt: humanDate(incident.timestamp * 1000),
    messageType: incident.message?.type,
    characters: incident.detection?.counted,
    trigger: config.thresholdChars ?? 2000,
    bytes: incident.detection?.metrics?.bytes,
    preview: maskPreview(incident.detection?.preview, 240),
    signals: (incident.detection?.rules || []).map((rule) => ({ id: rule.id, label: rule.label, detail: rule.detail })),
    metrics: incident.detection?.metrics
  },
  actionsTaken: Object.fromEntries(
    Object.entries(incident.actions || {}).map(([name, value]) => [name, value?.status ?? value])
  ),
  reportPlan: {
    attempts: config.reportAttempts ?? 0,
    channel: config.reportChannel ?? 'auto',
    howTo: [
      'WhatsApp → open the chat → tap the contact name → Report → Report (this uploads the last messages to Meta)',
      'or mail the packet above to support@whatsapp.com with the subject "Abuse report: crash payload"'
    ]
  },
  human: renderPacketText(incident, config)
});

export const renderPacketText = (incident, config = {}) => [
  'AntiBugBot — abuse report packet',
  '================================',
  `incident:   ${incident.id}`,
  `generated:  ${humanDate(new Date())}`,
  `target:     ${incident.sender?.phone}  (${incident.sender?.jid})`,
  `chat:       ${incident.chat?.jid}${incident.chat?.isGroup ? '  [group]' : ''}`,
  `message id: ${incident.message?.id}`,
  `received:   ${humanDate(incident.timestamp * 1000)}`,
  `type:       ${incident.message?.type}`,
  `size:       ${incident.detection?.counted} chars / ${incident.detection?.metrics?.bytes} bytes`,
  `trigger:    ${config.thresholdChars ?? 2000} chars (${config.countMode ?? 'max'})`,
  `risk:       ${riskLabel(incident.detection?.risk)} (${incident.detection?.risk})`,
  '',
  'signals:',
  ...(incident.detection?.rules || []).map((rule) => `  - ${rule.label}: ${rule.detail}`),
  '',
  `preview: "${maskPreview(incident.detection?.preview, 240)}"`,
  '',
  'submitted reports:',
  incident.reports
    ? `  channel ${incident.reports.channel} · filed ${incident.reports.filed}/${incident.reports.attempts} · ${incident.reports.note || 'ok'}`
    : '  (enforcement not run for this packet)',
  '',
  'To escalate: WhatsApp → chat → contact name → Report → Report.'
].join('\n');

export default ReportEngine;
