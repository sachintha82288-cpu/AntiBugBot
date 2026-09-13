/**
 * The screen() entry point that any WhatsApp provider adapter (Baileys /
 * whatsapp-web.js / WA Cloud API webhook) calls for every inbound message.
 *
 * Adapter contract (implemented in src/adapters/<provider>.js, NOT here):
 *   onInbound(evt) -> guard.screen(evt) -> apply(decision)
 * where evt = {
 *   chatId, senderId, text?, mediaSizeBytes?, isGroup, isKnownContact,
 *   isAdmin, isOwner, messageId
 * }
 * and `apply` maps our action onto provider calls that are *deletion/blocking
 * only*. Applying `delete`/`restrict` needs the bot to be a group admin; the
 * adapter must degrade gracefully to `log` when it lacks that power.
 */

import { analyzeText } from './detector.js';
import { SlidingWindow, TokenBucket, Strikes } from './limits.js';
import { decide, noticeText } from './policy.js';
import { redact } from './redact.js';

export class Guard {
  /**
   * @param {object} cfg resolved config
   * @param {{log?: (line:string)=>void, quarantine?: object, clock?: ()=>number}} deps
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.log = deps.log ?? (() => {});
    this.quarantine = deps.quarantine ?? null;
    this.clock = deps.clock ?? Date.now;

    this.chatWindow = new SlidingWindow(cfg.flood.windowMs);
    this.senderWindow = new SlidingWindow(cfg.flood.windowMs);
    this.burst = new TokenBucket({
      capacity: cfg.flood.burstCapacity,
      refillPerSec: cfg.flood.burstRefillPerSec,
    });
    this.strikes = new Strikes({ ttlMs: cfg.strikes.ttlMs });

    /** last notice sent per sender, to avoid nagging (which is itself a flood) */
    this.lastNotice = new Map();
    this.stats = { screened: 0, blocked: 0, byAction: {} };
  }

  /**
   * @param {object} evt
   * @returns {Promise<{decision: object, detection: object, notice?: string}>}
   */
  async screen(evt) {
    const now = this.clock();
    const cfg = this.cfg;

    // Volume first, cheap: window counters always advance, even for clean mail.
    const windowCount = this.senderWindow.hit(evt.senderId ?? evt.chatId ?? 'unknown', now);
    const chatCount = this.chatWindow.hit(evt.chatId ?? 'unknown', now);
    const { allowed: bucketAllowed } = this.burst.take(`s:${evt.senderId ?? '?'}`, now);

    const detection = analyzeText(evt.text ?? '', {
      maxLen: cfg.maxLen,
      scanWindow: cfg.scanWindow,
    });

    const strikes = this.strikes.get(evt.senderId ?? 'unknown', now);
    const trusted =
      evt.isOwner === true ||
      (evt.isAdmin === true && cfg.trust.adminNumbers.length === 0) ||
      cfg.trust.allowlistedChats?.includes(evt.chatId) === true;

    const decision = decide(
      {
        detection,
        windowCount,
        chatCount,
        bucketAllowed,
        strikes,
        trusted,
        isGroup: evt.isGroup === true,
        isKnownContact: evt.isKnownContact === true,
        mediaSizeBytes: evt.mediaSizeBytes ?? 0,
        now,
      },
      cfg,
    );

    this.stats.screened++;
    this.stats.byAction[decision.action] = (this.stats.byAction[decision.action] ?? 0) + 1;
    if (decision.action !== 'allow' && decision.action !== 'log') this.stats.blocked++;

    if (decision.strikes > 0) {
      this.strikes.add(evt.senderId ?? 'unknown', now, decision.strikes);
    }

    if (decision.quarantine) {
      await this.quarantine?.record({
        at: now,
        chatId: evt.chatId,
        senderId: evt.senderId,
        messageId: evt.messageId,
        isGroup: evt.isGroup === true,
        action: decision.action,
        reasons: decision.reasons,
        detection,
        preview: redact(evt.text ?? '', { maxChars: 120 }),
        lengthUnits: detection.stats.chars,
      });
    }

    const line = {
      t: new Date(now).toISOString(),
      chat: short(evt.chatId),
      from: short(evt.senderId),
      action: decision.action,
      verdict: detection.verdict,
      risk: detection.risk,
      signals: detection.signals,
      reasons: decision.reasons,
      strikes: this.strikes.get(evt.senderId ?? 'unknown', now),
      rate: { sender: windowCount, chat: chatCount },
      preview: redact(evt.text ?? '', { maxChars: 60 }),
    };
    this.log(line);

    const notice = await this.#maybeNotice(evt, decision, now);
    return { decision, detection, notice };
  }

  async #maybeNotice(evt, decision, now) {
    const cfg = this.cfg;
    if (!cfg.notices.sendToSender) return undefined;
    if (decision.action !== 'warn' && decision.action !== 'restrict') return undefined;
    const key = evt.senderId ?? 'unknown';
    const last = this.lastNotice.get(key) ?? 0;
    if (now - last < cfg.notices.oncePerSenderMinutes * 60_000) return undefined;
    this.lastNotice.set(key, now);
    return noticeText(cfg.notices.lang);
  }

  /**
   * Housekeeping. Call from the daemon on an interval; keeps long-lived
   * Pterodactyl processes from growing maps without bound.
   */
  maintenance() {
    const now = this.clock();
    this.chatWindow.sweep(now);
    this.senderWindow.sweep(now);
    for (const [key, ts] of this.lastNotice) {
      if (now - ts > 24 * 3600_000) this.lastNotice.delete(key);
    }
  }

  /** Manual override surface for the owner (not an API for attackers to probe). */
  unblock(senderId) {
    this.strikes.clear(senderId);
    this.senderWindow.reset(senderId);
  }
}

function short(id) {
  if (typeof id !== 'string' || id.length <= 12) return id ?? '?';
  return `${id.slice(0, 5)}…${id.slice(-4)}`;
}
