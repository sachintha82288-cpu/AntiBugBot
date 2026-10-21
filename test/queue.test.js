import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, KeyedQueue, RateLimiter, jitter, sleep } from '../src/core/queue.js';

test('sleep resolves and tolerates zero', async () => {
  const started = Date.now();
  await sleep(20);
  assert.ok(Date.now() - started >= 15);
  await sleep(0);
});

test('jitter stays around the requested delay', () => {
  for (let i = 0; i < 200; i += 1) {
    const value = jitter(1000, 0.4);
    assert.ok(value >= 600 && value <= 1400, `out of range: ${value}`);
  }
  assert.equal(jitter(0), 0);
});

test('KeyedQueue serialises work for the same number and parallelises across numbers', async () => {
  const queue = new KeyedQueue();
  const log = [];
  const make = (key, id, ms) => queue.push(key, async () => {
    log.push(`start:${id}`);
    await sleep(ms);
    log.push(`end:${id}`);
  });
  await Promise.all([make('a', 'a1', 20), make('a', 'a2', 5), make('b', 'b1', 10)]);
  assert.ok(log.indexOf('end:a1') < log.indexOf('start:a2'), 'same key never overlaps');
  assert.ok(log.indexOf('start:b1') < log.indexOf('end:a1'), 'different keys run together');
  assert.equal(queue.total(), 0);
});

test('KeyedQueue survives a throwing task and keeps the chain alive', async () => {
  const queue = new KeyedQueue();
  const ran = [];
  const first = queue.push('a', async () => { throw new Error('boom'); });
  const second = queue.push('a', async () => ran.push('second'));
  await assert.rejects(first, /boom/);
  await second;
  assert.deepEqual(ran, ['second']);
  assert.equal(queue.size('a'), 0);
});

test('drain waits for everything still in flight', async () => {
  const queue = new KeyedQueue();
  let done = 0;
  queue.push('x', async () => { await sleep(15); done += 1; });
  queue.push('y', async () => { await sleep(25); done += 1; });
  await queue.drain();
  assert.equal(done, 2);
});

test('the action budget holds the shield to N per minute', async () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({ maxPerMinute: 3, now: () => now });
  await limiter.acquire({ label: 'one' });
  await limiter.acquire({ label: 'two' });
  await limiter.acquire({ label: 'three' });
  assert.equal(limiter.available(), 0);
  const started = now;
  const waiter = limiter.acquire({ label: 'fourth', timeoutMs: 5000 });
  await sleep(20);
  assert.equal(limiter.pending(), 3, 'fourth is queued, not dropped');
  now += 60_001;
  const acquired = await waiter;
  assert.ok(acquired.waitedMs >= 0);
  assert.ok(now - started > 0);
});

test('the limiter gives up instead of hanging forever', async () => {
  const limiter = new RateLimiter({ maxPerMinute: 1 });
  await limiter.acquire({ label: 'first' });
  await assert.rejects(
    limiter.acquire({ label: 'second', timeoutMs: 120 }),
    /rate limit window saturated/
  );
});

test('the breaker opens under flood and closes again after cooldown', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: () => now });
  assert.equal(breaker.record('a').tripped, false);
  assert.equal(breaker.record('b').tripped, false);
  assert.equal(breaker.record('c').tripped, true);
  assert.equal(breaker.open, true);
  assert.equal(breaker.status().cooldownLeftMs, 1000);
  now = 1001;
  assert.equal(breaker.open, false);
  assert.equal(breaker.status().count, 0);
});

test('the breaker forgets events older than an hour', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ threshold: 5, cooldownMs: 10, now: () => now });
  for (let i = 0; i < 4; i += 1) breaker.record('x');
  now = 61 * 60_000;
  assert.equal(breaker.record('y').count, 1);
  assert.equal(breaker.open, false);
});
