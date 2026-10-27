import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../core/queue.js';

const MAX_SEND_TRIES = 3;

export const resolveOwnerJid = (config, identity) => {
  if (config.ownerNumber) return `${config.ownerNumber}@s.whatsapp.net`;
  const self = identity?.me?.id || identity?.me?.jid || '';
  if (!self) return '';
  return `${String(self).split(':')[0].replace(/[^0-9]/g, '')}@s.whatsapp.net`;
};

/** Sends text to a chat with retries; never throws — returns an outcome object. */
export const deliver = async ({ conn, jid, text, store, label = 'message', outboxDir }) => {
  if (!jid) {
    return { status: 'skip', detail: 'no destination resolved', text };
  }
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SEND_TRIES; attempt += 1) {
    try {
      const sent = await conn.sendMessage(jid, { text, linkPreview: null });
      store?.increment?.('alertsSent');
      return {
        status: 'ok',
        detail: `${label} → ${jid.replace('@s.whatsapp.net', '')}${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
        messageId: sent?.key?.id || null,
        attempt
      };
    } catch (error) {
      lastError = error;
      store?.increment?.('errors');
      if (attempt < MAX_SEND_TRIES) await sleep(900 * attempt);
    }
  }
  const saved = writeOutbox(outboxDir, jid, text, lastError);
  store?.increment?.('alertsFailed');
  return {
    status: 'fail',
    detail: `delivery failed${saved ? ` — saved to ${path.basename(saved)}` : ''}: ${lastError?.message || 'unknown'}`,
    outbox: saved,
    error: lastError
  };
};

const writeOutbox = (dir, jid, text, error) => {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${String(jid).replace(/\W+/g, '')}.txt`);
    fs.writeFileSync(
      file,
      [
        `# undelivered alert — ${new Date().toISOString()}`,
        `# to: ${jid}`,
        error ? `# error: ${error.message}` : null,
        '',
        text
      ].filter(Boolean).join('\n'),
      'utf8'
    );
    return file;
  } catch {
    return null;
  }
};

export const notifyIncident = async ({ conn, incident, config, store, identity, ui }) => {
  const jid = resolveOwnerJid(config, identity);
  const text = incident.brief;
  const result = await deliver({
    conn,
    jid: config.notifyOn === 'off' ? '' : jid,
    text,
    store,
    label: 'incident brief',
    outboxDir: path.join(config.data, 'outbox')
  });
  ui?.alert?.(jid || 'owner', result.status, result.detail);
  return { ...result, to: jid };
};

export const notifyArm = async ({ conn, config, store, identity, ui, host, capability }) => {
  if (!config.welcomeMessage) return { status: 'skip', detail: 'welcome message disabled' };
  const { renderArmNotice } = await import('../core/brief.js');
  const jid = resolveOwnerJid(config, identity);
  const result = await deliver({
    conn,
    jid,
    text: renderArmNotice(host, config, capability),
    store,
    label: 'arm notice',
    outboxDir: path.join(config.data, 'outbox')
  });
  if (result.status !== 'skip') ui?.info?.('shield', `arm notice ${result.status}: ${result.detail || ''}`);
  return result;
};

export default { deliver, notifyIncident, notifyArm, resolveOwnerJid };
