import { measureText } from './measure.js';
import { count, phoneLabel } from './format.js';
import { normalizePhone } from '../config.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const makeId = (prefix = 'INC', at = new Date()) => {
  const stamp = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0'),
    '-',
    String(at.getHours()).padStart(2, '0'),
    String(at.getMinutes()).padStart(2, '0'),
    String(at.getSeconds()).padStart(2, '0')
  ].join('');
  let tail = '';
  for (let i = 0; i < 4; i += 1) tail += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `${prefix}-${stamp}-${tail}`;
};

export const classifySource = (message) => {
  const keys = message && typeof message === 'object' ? Object.keys(message) : [];
  if (keys.includes('conversation')) return 'conversation';
  if (keys.includes('extendedTextMessage')) return 'extendedText';
  if (keys.includes('imageMessage')) return 'image caption';
  if (keys.includes('videoMessage')) return 'video caption';
  if (keys.includes('documentMessage')) return 'document caption';
  if (keys.includes('stickerMessage')) return 'sticker';
  if (keys.includes('audioMessage')) return 'audio';
  if (keys.includes('buttonsMessage')) return 'buttons';
  if (keys.includes('listMessage')) return 'list';
  if (keys.includes('interactiveMessage')) return 'interactive';
  if (keys.includes('locationMessage')) return 'location';
  if (keys.includes('contactMessage')) return 'contact vcard';
  if (keys.includes('pollCreationMessageV3')) return 'poll';
  if (keys.includes('ephemeralMessage')) return 'ephemeral wrapper';
  if (keys.includes('viewOnceMessageV2')) return 'view-once';
  return keys[0] || 'unknown';
};

const unwrapEphemeral = (message) => {
  if (!message || typeof message !== 'object') return message;
  if (message.ephemeralMessage?.message) return unwrapEphemeral(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapEphemeral(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapEphemeral(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage?.message) return unwrapEphemeral(message.documentWithCaptionMessage.message);
  if (message.editedMessage?.message?.protocolMessage?.editedMessage) {
    return unwrapEphemeral(message.editedMessage.message.protocolMessage.editedMessage);
  }
  return message;
};

export const extractText = (message) => {
  const payload = unwrapEphemeral(message);
  if (!payload || typeof payload !== 'object') return { text: '', kind: 'empty' };
  const direct = [
    ['conversation', 'conversation'],
    ['extendedTextMessage', 'extendedText'],
    ['imageMessage', 'image caption'],
    ['videoMessage', 'video caption'],
    ['documentMessage', 'document caption'],
    ['stickerMessage', 'sticker'],
    ['buttonsMessage', 'buttons'],
    ['listMessage', 'list'],
    ['interactiveMessage', 'interactive'],
    ['editedMessage', 'edited']
  ];
  for (const [key, kind] of direct) {
    const node = payload[key];
    if (!node) continue;
    const text = typeof node === 'string' ? node : (node.text ?? node.caption ?? '');
    if (typeof text === 'string' && text.length) return { text, kind };
  }
  for (const [key, node] of Object.entries(payload)) {
    if (node && typeof node === 'object') {
      const nested = node.text ?? node.caption;
      if (typeof nested === 'string' && nested.length) return { text: nested, kind: key };
    }
  }
  return { text: '', kind: Object.keys(payload)[0] || 'unknown' };
};

export const vcardLength = (message) => {
  const payload = unwrapEphemeral(message);
  const vcf = payload?.contactMessage?.vcard || payload?.contactsArrayMessage?.contacts?.[0]?.vcard;
  return typeof vcf === 'string' ? vcf.length : 0;
};

export const buildIncident = ({ message, decision, config, identity, store }) => {
  const key = message?.key || {};
  const chatJid = key.remoteJid || '';
  const isGroup = /@g\.us$/.test(chatJid);
  const senderJid = key.participant || (isGroup ? '' : chatJid) || key.remoteJid || '';
  const senderPhone = normalizePhone((String(senderJid).split('@')[0] || '').replace(/[^0-9]/g, ''), config.countryCode);
  const metrics = decision.metrics || measureText(decision.text || '');
  const seq = store ? store.increment('threatsDetected') : 1;

  const incident = {
    id: makeId('INC'),
    sequence: seq,
    createdAt: new Date().toISOString(),
    timestamp: Math.floor((message?.messageTimestamp || Date.now() / 1000)),
    mode: config.shieldMode,
    isGroup,
    groupId: isGroup ? chatJid : null,
    senderLabel: null,
    chat: {
      jid: chatJid,
      isGroup,
      name: isGroup ? chatJid.replace('@g.us', '') : null
    },
    sender: {
      jid: senderJid,
      phone: senderPhone ? `+${senderPhone}` : phoneLabel(senderJid),
      display: senderPhone ? `+${senderPhone}` : phoneLabel(senderJid),
      pushName: message?.pushName || null,
      savedName: identity?.savedNames?.[senderJid] || null
    },
    message: {
      id: key.id || null,
      fromMe: Boolean(key.fromMe),
      type: classifySource(unwrapEphemeral(message?.message)),
      sourceType: message?.type || null,
      hasMedia: Boolean(
        message?.message &&
        (message.message.imageMessage || message.message.videoMessage || message.message.audioMessage ||
          message.message.documentMessage || message.message.stickerMessage)
      )
    },
    detection: {
      triggered: decision.triggered,
      counted: decision.counted,
      threshold: decision.threshold,
      countMode: config.countMode,
      risk: decision.risk,
      primary: decision.primary,
      rules: decision.rules,
      preview: decision.preview,
      metrics: {
        graphemes: metrics.graphemes,
        codeUnits: metrics.codeUnits,
        bytes: metrics.bytes,
        lines: metrics.lines,
        invisible: metrics.invisible,
        unicodeTags: metrics.unicodeTags,
        controlChars: metrics.controlChars,
        zwj: metrics.zwj,
        rtlOverrides: metrics.rtlOverrides,
        unpairedSurrogates: metrics.unpairedSurrogates
      },
      vcardLength: vcardLength(message?.message)
    },
    actions: {},
    reports: null,
    brief: null
  };

  incident.senderLabel = `${incident.sender.display}${incident.sender.pushName ? ` “${incident.sender.pushName}”` : ''}`;
  return incident;
};

export const summarizeIncident = (incident) => ({
  id: incident.id,
  at: incident.createdAt,
  sender: incident.sender.phone,
  chars: count(incident.detection.counted),
  rules: incident.detection.rules.map((rule) => rule.id).join('+'),
  blocked: incident.actions.block?.status || 'none',
  deleted: incident.actions.delete?.status || 'none',
  reports: incident.reports ? `${incident.reports.filed}/${incident.reports.attempts}` : 'n/a',
  alerted: incident.actions.notify?.status || 'none'
});

export const repeatOffender = (store, senderJid) => {
  if (!store) return { count: 0, lastAt: null };
  const prior = store.state.incidents.filter((item) => item.sender?.jid === senderJid);
  return {
    count: prior.length,
    lastAt: prior.length ? prior[prior.length - 1].createdAt : null
  };
};

export default { makeId, buildIncident, classifySource, extractText, summarizeIncident };
