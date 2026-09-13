/**
 * Quarantine: a *fingerprint* store. It must never contain attacker-controlled
 * text, or the defense system becomes the payload's home and delivery vehicle.
 *
 * What we keep: hash, structural counts, timestamps, ids, reasons.
 * What we never keep: the raw string, the raw media buffer, filenames from clients.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Quarantine {
  /** @param {{dir:string, redact?:boolean}} opts */
  constructor(opts) {
    this.dir = opts.dir;
    this.redact = opts.redact !== false;
    this.ready = fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * @param {object} rec record produced by Guard.screen()
   * @returns {Promise<string>} record id
   */
  async record(rec) {
    const hash = crypto.createHash('sha256').update(String(rec.preview ?? ''), 'utf8');
    // structure, not content
    const fingerprint = {
      v: 1,
      id: crypto.randomBytes(8).toString('hex'),
      at: rec.at,
      chatHash: tag(rec.chatId),
      senderHash: tag(rec.senderId),
      messageId: sanitizeId(rec.messageId),
      isGroup: rec.isGroup,
      action: rec.action,
      reasons: rec.reasons,
      verdict: rec.detection.verdict,
      risk: rec.detection.risk,
      scores: rec.detection.scores,
      stats: rec.detection.stats,
      lengthUnits: rec.lengthUnits,
      previewLen: String(rec.preview ?? '').length,
      digest: hash.digest('hex').slice(0, 32),
    };

    const file = path.join(this.dir, `${day(rec.at)}.jsonl`);
    await fs.promises.appendFile(file, `${JSON.stringify(fingerprint)}\n`, 'utf8');
    return fingerprint.id;
  }

  /** Recent summary for the owner dashboard / status command. */
  async summary(days = 7) {
    const out = [];
    for (let i = 0; i < days; i++) {
      const at = Date.now() - i * 86_400_000;
      const file = path.join(this.dir, `${day(at)}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const lines = (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean);
      const byVerdict = {};
      const byAction = {};
      let topSignals = {};
      for (const l of lines) {
        try {
          const r = JSON.parse(l);
          byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
          byAction[r.action] = (byAction[r.action] ?? 0) + 1;
          for (const [k, v] of Object.entries(r.scores ?? {})) {
            if (v >= 0.6) topSignals[k] = (topSignals[k] ?? 0) + 1;
          }
        } catch {
          /* tolerate a torn last line */
        }
      }
      topSignals = Object.fromEntries(Object.entries(topSignals).sort((a, b) => b[1] - a[1]).slice(0, 8));
      out.push({ day: day(at), records: lines.length, byVerdict, byAction, topSignals });
    }
    return out;
  }

  /**
   * Wipe policy: quarantine entries older than `maxAgeDays` are deleted, because
   * keeping suspicious data forever is a liability, not a defense.
   */
  async purge(maxAgeDays = 30) {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let removed = 0;
    for (const name of await fs.promises.readdir(this.dir).catch(() => [])) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      if (Date.parse(`${m[1]}T23:59:59Z`) < cutoff) {
        await fs.promises.rm(path.join(this.dir, name), { force: true });
        removed++;
      }
    }
    return removed;
  }
}

/** Stable, non-reversible short tag for identifiers (used for cross-day correlation). */
export function tag(id) {
  if (id == null) return null;
  return crypto.createHash('sha256').update(String(id), 'utf8').digest('hex').slice(0, 12);
}

function sanitizeId(id) {
  if (typeof id !== 'string') return null;
  // WhatsApp ids are [A-Za-z0-9+/=]+ and short; anything else is attacker noise.
  return /^[A-Za-z0-9+/=_-]{1,64}$/.test(id) ? id : null;
}

function day(at) {
  return new Date(at ?? Date.now()).toISOString().slice(0, 10);
}
