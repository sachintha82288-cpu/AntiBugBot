/**
 * Flood / rate behaviour. A crash bot is almost never one message - it is
 * thousands, so volume is often a *stronger* signal than content.
 *
 * Time is injected (`now` argument) so the whole module is deterministically testable.
 */

export class SlidingWindow {
  /** @param {number} windowMs */
  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.buckets = new Map();
  }

  /**
   * @param {string} key
   * @param {number} now epoch ms
   * @param {number} [weight=1]
   */
  hit(key, now, weight = 1) {
    let arr = this.buckets.get(key);
    if (!arr) {
      arr = [];
      this.buckets.set(key, arr);
    }
    arr.push(now, weight); // flat pairs: [t, w, t, w...]
    this.#prune(arr, now);
    return this.count(key, now);
  }

  count(key, now) {
    const arr = this.buckets.get(key);
    if (!arr) return 0;
    this.#prune(arr, now);
    let n = 0;
    for (let i = 1; i < arr.length; i += 2) n += arr[i];
    return n;
  }

  /** Approximate events-per-second within the window. */
  rate(key, now) {
    return this.count(key, now) / (this.windowMs / 1000);
  }

  reset(key) {
    this.buckets.delete(key);
  }

  #prune(arr, now) {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop + 1 < arr.length && arr[drop] < cutoff) drop += 2;
    if (drop > 0) arr.splice(0, drop);
  }

  /** Sweep stale keys; call periodically from the daemon. */
  sweep(now) {
    for (const [key, arr] of this.buckets) {
      this.#prune(arr, now);
      if (arr.length === 0) this.buckets.delete(key);
    }
  }
}

/**
 * Token bucket for burst control on top of the sliding window.
 */
export class TokenBucket {
  constructor({ capacity = 5, refillPerSec = 0.5 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    /** @type {Map<string, {tokens:number, ts:number}>} */
    this.buckets = new Map();
  }

  /**
   * @returns {{allowed:boolean, tokens:number}}
   */
  take(key, now, cost = 1) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, ts: now };
      this.buckets.set(key, b);
    }
    const elapsedSec = Math.max(0, (now - b.ts) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.ts = now;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, tokens: b.tokens };
    }
    return { allowed: false, tokens: b.tokens };
  }

  /**
   * Refund-only variant used when a message is screened *after* admission:
   * never grants extra budget, just avoids double-punishing retries.
   */
  peek(key) {
    return this.buckets.get(key) ?? null;
  }
}

/**
 * Strike counter with decay, feeding escalation in policy.js.
 */
export class Strikes {
  constructor({ ttlMs = 60 * 60 * 1000, max = 10 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    /** @type {Map<string, {n:number, ts:number}>} */
    this.map = new Map();
  }

  add(key, now, amount = 1) {
    const cur = this.map.get(key);
    const decayed = cur && now - cur.ts > this.ttlMs ? 0 : cur?.n ?? 0;
    const n = Math.min(this.max, decayed + amount);
    this.map.set(key, { n, ts: now });
    return n;
  }

  get(key, now) {
    const cur = this.map.get(key);
    if (!cur) return 0;
    if (now - cur.ts > this.ttlMs) {
      this.map.delete(key);
      return 0;
    }
    return cur.n;
  }

  clear(key) {
    this.map.delete(key);
  }
}
