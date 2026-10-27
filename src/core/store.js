import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;

const emptyState = () => ({
  version: STATE_VERSION,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  blocked: {},
  whitelist: {},
  incidents: [],
  stats: {
    messagesScanned: 0,
    threatsDetected: 0,
    enforced: 0,
    blocked: 0,
    deleted: 0,
    reportsFiled: 0,
    reportsAttempted: 0,
    alertsSent: 0,
    alertsFailed: 0,
    errors: 0
  },
  sessions: []
});

const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export class StateStore {
  constructor(options = {}) {
    this.dir = options.dir || path.join(process.cwd(), 'data');
    this.file = options.file || path.join(this.dir, 'state.json');
    this.incidentLog = options.incidentLog || path.join(this.dir, 'incidents.jsonl');
    this.reportDir = options.reportDir || path.join(this.dir, 'reports');
    this.maxIncidents = options.maxIncidents ?? 200;
    this.flushDelayMs = options.flushDelayMs ?? 150;
    this.state = emptyState();
    this.dirty = false;
    this.flushTimer = null;
    this.flushing = null;
    this.recovered = null;
  }

  load() {
    ensureDir(this.dir);
    ensureDir(this.reportDir);
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return this;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      this.state = {
        ...emptyState(),
        ...parsed,
        stats: { ...emptyState().stats, ...(parsed.stats || {}) }
      };
      this.state.blocked = this.state.blocked || {};
      this.state.whitelist = this.state.whitelist || {};
      this.state.incidents = Array.isArray(this.state.incidents) ? this.state.incidents : [];
    } catch (error) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.file, backup);
      } catch {
        /* ignore */
      }
      this.recovered = { error: error.message, backup };
      this.state = emptyState();
    }
    return this;
  }

  touch() {
    this.state.updatedAt = new Date().toISOString();
    this.dirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) return this;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, this.flushDelayMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
    return this;
  }

  async flush() {
    if (this.flushing) {
      await this.flushing.catch(() => {});
    }
    if (!this.dirty) return false;
    this.dirty = false;
    const payload = JSON.stringify(this.state, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.flushing = (async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, this.file);
    })();
    try {
      await this.flushing;
      return true;
    } finally {
      this.flushing = null;
    }
  }

  increment(stat, by = 1) {
    if (!(stat in this.state.stats)) this.state.stats[stat] = 0;
    this.state.stats[stat] += by;
    this.touch();
    return this.state.stats[stat];
  }

  isBlocked(jid) {
    return Boolean(this.state.blocked[jid]);
  }

  recordBlock(entry) {
    this.state.blocked[entry.jid] = {
      ...this.state.blocked[entry.jid],
      ...entry,
      blockedAt: entry.blockedAt || new Date().toISOString(),
      blockCount: (this.state.blocked[entry.jid]?.blockCount || 0) + 1
    };
    this.increment('blocked');
    this.touch();
    return this.state.blocked[entry.jid];
  }

  removeBlock(jid) {
    const existed = Boolean(this.state.blocked[jid]);
    delete this.state.blocked[jid];
    this.touch();
    return existed;
  }

  addWhitelist(jid, note = '') {
    this.state.whitelist[jid] = { jid, note, addedAt: new Date().toISOString() };
    this.touch();
    return this.state.whitelist[jid];
  }

  removeWhitelist(jid) {
    const existed = Boolean(this.state.whitelist[jid]);
    delete this.state.whitelist[jid];
    this.touch();
    return existed;
  }

  isWhitelisted(jid) {
    return Boolean(this.state.whitelist[jid]);
  }

  addIncident(incident) {
    this.state.incidents.push(incident);
    const overflow = this.state.incidents.length - this.maxIncidents;
    if (overflow > 0) this.state.incidents.splice(0, overflow);
    this.touch();
    return this.writeIncidentLog(incident);
  }

  async writeIncidentLog(incident) {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.appendFile(this.incidentLog, JSON.stringify(incident) + '\n', 'utf8');
    } catch {
      /* forensics must never break enforcement */
    }
    return this.incidentLog;
  }

  recentIncidents(limit = 10) {
    return this.state.incidents.slice(-limit).reverse();
  }

  async writeReportPacket(packet) {
    const file = path.join(this.reportDir, `${packet.id}.json`);
    const text = path.join(this.reportDir, `${packet.id}.txt`);
    await fsp.mkdir(this.reportDir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(packet, null, 2), 'utf8');
    await fsp.writeFile(text, packet.human, 'utf8');
    return { file, text };
  }

  snapshot() {
    return {
      stats: { ...this.state.stats },
      blockedCount: Object.keys(this.state.blocked).length,
      incidentCount: this.state.incidents.length,
      updatedAt: this.state.updatedAt
    };
  }
}

export const createStore = (options) => new StateStore(options).load();

export default StateStore;
