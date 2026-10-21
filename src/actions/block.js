import { sleep } from '../core/queue.js';

const isAlreadyBlocked = (error) => /409|410|already|blocked/i.test(String(error?.message || error || ''));

/**
 * Blocks the sender. Deduped against the live blocklist so a flood of bug
 * messages from one number only spends one block.
 */
export const blockSender = async ({ conn, jid, store, ui, cache }) => {
  if (!jid) return { status: 'fail', detail: 'no sender jid' };
  if (store?.isBlocked?.(jid) && !cache?.force) {
    return { status: 'skip', detail: 'already shielded by this bot' };
  }

  if (cache && !cache.blocklist && !cache.loading) {
    cache.loading = true;
    try {
      const list = await conn.fetchBlocklist();
      cache.blocklist = new Set(Array.isArray(list) ? list : []);
    } catch (error) {
      cache.blocklist = null;
      ui?.debug?.('block', `blocklist lookup failed: ${error.message}`);
    } finally {
      cache.loading = false;
    }
  }

  if (cache?.blocklist?.has(jid)) {
    store?.recordBlock({ jid, reason: 'pre-blocked', incidentId: null, alreadyBlocked: true });
    return { status: 'skip', detail: 'already on WhatsApp blocklist' };
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await conn.updateBlockStatus(jid, 'block');
      cache?.blocklist?.add(jid);
      store?.recordBlock({
        jid,
        reason: 'oversized crash-bug message',
        blockedAt: new Date().toISOString(),
        attempt
      });
      return { status: 'ok', detail: `blocked ${jid}${attempt > 1 ? ` (attempt ${attempt})` : ''}` };
    } catch (error) {
      if (isAlreadyBlocked(error)) {
        cache?.blocklist?.add(jid);
        return { status: 'ok', detail: 'block confirmed (already blocked)' };
      }
      if (attempt === 3) return { status: 'fail', detail: error.message, error };
      await sleep(400 * attempt);
    }
  }
  return { status: 'fail', detail: 'unreachable' };
};

export const unblockSender = async ({ conn, jid, store, cache }) => {
  try {
    await conn.updateBlockStatus(jid, 'unblock');
    cache?.blocklist?.delete(jid);
    store?.removeBlock(jid);
    return { status: 'ok', detail: `unblocked ${jid}` };
  } catch (error) {
    if (store?.removeBlock) store.removeBlock(jid);
    return { status: 'fail', detail: error.message, error };
  }
};

export const fetchBlocked = async (conn) => {
  try {
    const list = await conn.fetchBlocklist();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

export default { blockSender, unblockSender, fetchBlocked };
