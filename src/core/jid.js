export const BROADCAST_SUFFIXES = ['@broadcast', '@status@broadcast', '@newsletter', '@lid'];

export const phoneOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

export const isGroup = (jid) => String(jid || '').endsWith('@g.us');

export const isUser = (jid) => String(jid || '').endsWith('@s.whatsapp.net') || String(jid || '').endsWith('@s.whatsapp.net:');

export const isBroadcastish = (jid) => {
  const value = String(jid || '');
  if (!value) return true;
  if (value === 'status@broadcast') return true;
  if (value.endsWith('@broadcast')) return true;
  if (value.endsWith('@newsletter')) return true;
  if (value.endsWith('@lid')) return true;
  if (value.startsWith('2@') || value === 's.whatsapp.net') return true;
  return false;
};

export const isSystemChat = (jid) => {
  const value = String(jid || '');
  return /@(broadcast|newsletter)$/.test(value) || value.startsWith('1500@') || value === '2@xyx';
};

export const toJid = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  return `${digits}@s.whatsapp.net`;
};

export const toGroupJid = (id) => {
  const digits = String(id || '').replace(/\D/g, '');
  return digits ? `${digits}@g.us` : '';
};

export const parseJid = (jid) => {
  const raw = String(jid || '');
  const [userPart = '', server = ''] = raw.split('@');
  const [user, device = '0'] = userPart.split(':');
  return { raw, user, device, server, serverFull: server ? `${user}@${server}` : user };
};

export default { phoneOf, isGroup, isUser, isBroadcastish, isSystemChat, toJid, toGroupJid, parseJid };
