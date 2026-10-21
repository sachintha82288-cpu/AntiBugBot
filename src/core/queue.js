export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const jitter = (ms, spread = 0.25) => {
  const value = Math.max(0, Number(ms) || 0);
  if (!value) return 0;
  const factor = 1 + (Math.random() * 2 - 1) * spread;
  return Math.round(value * factor);
};

/** Serializes work per key so two incidents for one number never interleave. */
export class KeyedQueue {
  constructor() {
    this.chains = new Map();
    this.lengths = new Map();
  }

  size(key) {
    return this.lengths.get(key) || 0;
  }

  total() {
    let sum = 0;
    for (const value of this.lengths.values()) sum += value;
    return sum;
  }

  push(key, task) {
    this.lengths.set(key, (this.lengths.get(key) || 0) + 1);
    const previous = this.chains.get(key) || Promise.resolve();
    const run = previous.then(() => task());
    const settled = run.catch(() => {}).then(() => {
      const next = (this.lengths.get(key) || 1) - 1;
      if (next <= 0) {
        this.lengths.delete(key);
        this.chains.delete(key);
      } else {
        this.lengths.set(key, next);
      }
    });
    this.chains.set(key, settled);
    return settled.then(() => run);
  }

  async drain() {
    while (this.chains.size > 0) {
      await Promise.allSettled([...this.chains.values()]);
    }
  }
}

/** Sliding-window budget so the shield never behaves like a spammer itself. */
export class RateLimiter {
  constructor({ maxPerMinute = 6, now = () => Date.now() } = {}) {
    this.maxPerMinute = Math.max(1, maxPerMinute);
    this.windowMs = 60_000;
    this.stamps = [];
    this.now = now;
    this.blockedUntil = 0;
  }

  prune() {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
  }

  available() {
    this.prune();
    return Math.max(0, this.maxPerMinute - this.stamps.length);
  }

  pending() {
    return this.stamps.length;
  }

  async acquire({ timeoutMs = 120_000, abort, label = 'action' } = {}) {
    const started = this.now();
    for (;;) {
      this.prune();
      if (this.stamps.length < this.maxPerMinute) {
        this.stamps.push(this.now());
        return { waitedMs: this.now() - started, label };
      }
      if (abort?.aborted) throw new Error(`aborted before ${label} (rate limited)`);
      if (this.now() - started > timeoutMs) {
        throw new Error(`rate limit window saturated for ${label}`);
      }
      await sleep(200);
    }
  }

  release() {
    /* window-based; nothing to free */
  }
}

/** Trips open when the bot is being flooded with incidents, to protect the owner's account. */
export class CircuitBreaker {
  constructor({ threshold = 40, cooldownMs = 5 * 60_000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.events = [];
    this.openedAt = null;
    this.trips = 0;
  }

  get open() {
    if (this.openedAt === null) return false;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      this.openedAt = null;
      this.events = [];
      return false;
    }
    return true;
  }

  record(key = 'threat') {
    const stamp = this.now();
    this.events.push(stamp);
    const cutoff = stamp - 60 * 60_000;
    while (this.events.length && this.events[0] < cutoff) this.events.shift();
    if (this.events.length >= this.threshold && this.openedAt === null) {
      this.openedAt = stamp;
      this.trips += 1;
      return { tripped: true, count: this.events.length };
    }
    return { tripped: false, count: this.events.length };
  }

  status() {
    return {
      open: this.open,
      count: this.events.length,
      threshold: this.threshold,
      trips: this.trips,
      cooldownLeftMs: this.openedAt === null ? 0 : Math.max(0, this.cooldownMs - (this.now() - this.openedAt))
    };
  }

  reset() {
    this.openedAt = null;
    this.events = [];
  }
}

export default { sleep, jitter, KeyedQueue, RateLimiter, CircuitBreaker };
