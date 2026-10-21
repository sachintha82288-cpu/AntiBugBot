import { blockSender } from './block.js';
import { deleteBugMessage } from './delete-for-me.js';
import { notifyIncident } from './notify.js';
import { CircuitBreaker, KeyedQueue, RateLimiter, sleep } from '../core/queue.js';
import { renderBrief } from '../core/brief.js';
import { repeatOffender } from '../core/incident.js';
import { isBroadcastish } from '../core/jid.js';

/**
 * Turns one detection into a chain of enforced actions, in the order that
 * protects the phone first and the account second:
 *
 *   delete for me → block → file reports → brief the owner
 *
 * Every step is best-effort, deduped, rate-limited, and recorded. One failing
 * step never cancels the rest, and nothing is reported to the owner as done
 * unless the transport actually accepted it.
 */
export class Enforcer {
  constructor({ config, store, ui, reportEngine, identity, now = () => Date.now() } = {}) {
    this.config = config;
    this.store = store;
    this.ui = ui;
    this.reportEngine = reportEngine;
    this.identity = identity;
    this.queue = new KeyedQueue();
    this.limiter = new RateLimiter({ maxPerMinute: config.maxActionsPerMinute, now });
    this.breaker = new CircuitBreaker({
      threshold: Math.max(config.maxActionsPerMinute * 6, 30),
      cooldownMs: 5 * 60_000,
      now
    });
    this.blockCache = { blocklist: null, loading: false };
    this.handled = new Set();
    this.handledOrder = [];
    this.busy = false;
  }

  get state() {
    return {
      queued: this.queue.total(),
      breaker: this.breaker.status(),
      limiter: { available: this.limiter.available(), budget: this.limiter.maxPerMinute }
    };
  }

  /** Returns null when the message is not eligible, otherwise an outcome object. */
  eligibility(ctx) {
    const { config } = this;
    const { message, decision } = ctx;
    const key = message?.key || {};
    const chatJid = key.remoteJid || '';
    const senderJid = key.participant || chatJid;

    if (!decision.triggered) return { eligible: false, reason: 'no rule fired' };
    if (key.fromMe) return { eligible: false, reason: 'message sent by this account' };
    if (isBroadcastish(chatJid)) return { eligible: false, reason: 'broadcast / status / system chat' };
    if (this.handled.has(key.id)) return { eligible: false, reason: 'already handled' };
    if (!config.block && config.deleteMode === 'off' && config.reportAttempts === 0) {
      return { eligible: false, reason: 'all enforcement actions disabled' };
    }

    if (this.identity?.ownerJid && senderJid === this.identity.ownerJid) {
      return { eligible: false, reason: 'sender is the owner number' };
    }
    if (storeWhitelisted(this.store, senderJid) || (config.whitelist || []).includes(digitsOf(senderJid))) {
      return { eligible: false, reason: 'whitelisted number', warn: true };
    }

    if (key.remoteJid?.endsWith('@g.us')) {
      if (config.groupsMode === 'ignore') return { eligible: false, reason: 'group traffic ignored' };
      if (config.groupsMode === 'observe') {
        return { eligible: false, reason: 'group incident — observe mode (delete + block skipped)', warn: true, alert: true };
      }
    }
    return { eligible: true };
  }

  /** Single entry point from the socket handler. Never throws. */
  async process(ctx) {
    const verdict = this.eligibility(ctx);
    if (!verdict.eligible) {
      if (verdict.reason) this.ui?.debug?.('shield', `skipped: ${verdict.reason}`);
      if (verdict.alert) {
        const incident = { ...ctx.incident, actions: { block: { status: 'skip', detail: verdict.reason } } };
        this.notifySafely(incident, ctx);
      }
      return { skipped: true, reason: verdict.reason };
    }

    const senderKey = ctx.message?.key?.participant || ctx.message?.key?.remoteJid || 'unknown';
    this.busy = true;
    return this.queue.push(senderKey, async () => {
      try {
        return await this.run(ctx);
      } finally {
        this.busy = false;
      }
    });
  }

  async run(ctx) {
    const { incident, conn } = ctx;
    const chatJid = ctx.message?.key?.remoteJid || '';
    const senderJid = ctx.message?.key?.participant || chatJid;
    const key = ctx.message?.key || {};
    const observe = this.config.shieldMode === 'observe';
    const startedAt = Date.now();

    this.markHandled(key.id);
    const breakerHit = this.breaker.record(incident.id);
    if (breakerHit.tripped) {
      this.ui?.warn?.(
        'shield',
        `flood detected — ${breakerHit.count} incidents in an hour. Enforcement paused for 5 minutes to protect your account.`
      );
      incident.actions.breaker = {
        status: 'ok',
        detail: `paused after ${breakerHit.count} incidents/hour`
      };
    }

    incident.brief = null;
    incident.repeat = repeatOffender(this.store, senderJid);

    // 1. delete the payload before the phone ever has to render it
    if (observe) {
      incident.actions.delete = { status: 'dry', detail: 'observe mode — nothing deleted' };
    } else if (this.config.deleteMode === 'off') {
      incident.actions.delete = { status: 'skip', detail: 'delete disabled' };
    } else {
      incident.actions.delete = await deleteBugMessage({
        conn,
        chatJid,
        key,
        timestampSec: incident.timestamp,
        mode: this.config.deleteMode,
        store: this.store
      });
    }
    this.ui?.action?.('delete for me', incident.actions.delete.status, incident.actions.delete.detail);

    // 2. cut the sender off
    const flood = this.breaker.open;
    if (flood) {
      incident.actions.block = { status: 'skip', detail: 'circuit breaker open — paused to protect your account' };
      this.ui?.action?.('block', 'skip', incident.actions.block.detail);
    } else if (observe || !this.config.block) {
      incident.actions.block = { status: observe ? 'dry' : 'skip', detail: observe ? 'observe mode — not blocked' : 'blocking disabled' };
      this.ui?.action?.('block', incident.actions.block.status, incident.actions.block.detail);
    } else {
      try {
        await this.limiter.acquire({ label: 'block', timeoutMs: 30_000 });
      } catch (error) {
        this.ui?.debug?.('shield', `rate limit: ${error.message}`);
      }
      incident.actions.block = await blockSender({
        conn,
        jid: senderJid,
        store: this.store,
        ui: this.ui,
        cache: this.blockCache
      });
      this.ui?.action?.('block', incident.actions.block.status, incident.actions.block.detail);
    }

    // 3. escalate: file the report attempts
    if (flood || observe || this.config.reportAttempts === 0 || this.config.reportChannel === 'off') {
      incident.reports = {
        attempts: observe ? this.config.reportAttempts : 0,
        filed: 0,
        channel: flood ? 'paused' : observe ? 'observe' : 'off',
        note: flood
          ? 'circuit breaker open — reporting paused'
          : observe
            ? 'observe mode — reports not filed'
            : 'reporting disabled',
        records: []
      };
    } else {
      this.ui?.setTask?.(`filing ${this.config.reportAttempts} reports`);
      incident.reports = await this.reportEngine.file(conn, incident);
      this.ui?.setTask?.('');
    }
    this.ui?.action?.(
      'reports',
      incident.reports.filed > 0 ? 'ok' : incident.reports.channel === 'evidence' ? 'skip' : 'fail',
      `${incident.reports.filed}/${incident.reports.attempts} filed · ${incident.reports.channel}${incident.reports.note ? ` · ${incident.reports.note}` : ''}`
    );

    // 4. tell the owner, with everything that matters
    this.ui?.setTask?.('writing incident brief');
    incident.brief = renderBrief(incident, {
      config: this.config,
      host: this.identity?.host || {},
      reports: incident.reports,
      repeat: incident.repeat
    });
    this.ui?.setTask?.('');
    await this.notifySafely(incident, ctx);

    incident.durationMs = Date.now() - startedAt;
    if (!observe) this.store?.increment?.('enforced');
    this.store?.addIncident(stripMessage(incident));

    if (this.config.beepOnThreat && this.ui?.level !== 'silent') {
      process.stdout.write('\u0007');
    }

    return incident;
  }

  async notifySafely(incident, ctx) {
    try {
      const result = await notifyIncident({
        conn: ctx.conn,
        incident,
        config: this.config,
        store: this.store,
        identity: this.identity,
        ui: this.ui
      });
      incident.actions.notify = result;
      return result;
    } catch (error) {
      incident.actions.notify = { status: 'fail', detail: error.message };
      this.store?.increment?.('alertsFailed');
      this.ui?.error?.('alert', `brief failed: ${error.message}`);
      return incident.actions.notify;
    }
  }

  markHandled(id) {
    if (!id) return;
    this.handled.add(id);
    this.handledOrder.push(id);
    if (this.handledOrder.length > 500) {
      const stale = this.handledOrder.splice(0, 200);
      for (const entry of stale) this.handled.delete(entry);
    }
  }

  async drain() {
    await this.queue.drain();
    while (this.busy) await sleep(120);
  }
}

/**
 * What the ledger keeps. The full body never lands on disk — only the
 * measurements, a short sanitised preview, and the outcome of each action.
 * The brief itself is regenerated from `data/reports/` when needed.
 */
const stripMessage = (incident) => ({
  ...incident,
  brief: undefined,
  senderLabel: undefined,
  durationMs: incident.durationMs,
  detection: {
    ...incident.detection,
    preview: String(incident.detection?.preview || '').slice(0, 160)
  },
  reports: incident.reports
    ? {
        attempts: incident.reports.attempts,
        filed: incident.reports.filed,
        channel: incident.reports.channel,
        note: incident.reports.note,
        packetPath: incident.reports.packetPath,
        rejected: (incident.reports.records || []).filter((record) => !record.ok).length
      }
    : null,
  actions: Object.fromEntries(
    Object.entries(incident.actions || {}).map(([name, value]) => [
      name,
      { status: value?.status, detail: value?.detail ? String(value.detail).slice(0, 200) : undefined }
    ])
  )
});

const storeWhitelisted = (store, jid) => {
  if (!store?.isWhitelisted) return false;
  return store.isWhitelisted(jid) || store.isWhitelisted(digitsOf(jid));
};

const digitsOf = (jid) => String(jid || '').replace(/@.*$/, '').replace(/\D/g, '');

export default Enforcer;
