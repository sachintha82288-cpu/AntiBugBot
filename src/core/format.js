export const count = (value) => String(Math.trunc(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const plural = (n, one, many = one + 's') => `${count(n)} ${n === 1 ? one : many}`;

export const humanDate = (input) => {
  const date = input instanceof Date ? input : new Date(typeof input === 'number' && String(input).length === 10 ? input * 1000 : input);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const humanUtc = (input) => {
  const numeric = typeof input === 'number' && Number.isFinite(input);
  const date = input instanceof Date ? input : new Date(numeric && String(input).length === 10 ? input * 1000 : input);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
};

export const relative = (input, now = Date.now()) => {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Math.max(0, now - date.getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
};

export const riskLabel = (risk) => {
  const value = Number(risk) || 0;
  if (value >= 180) return 'CRITICAL';
  if (value >= 120) return 'HIGH';
  if (value >= 80) return 'MEDIUM';
  if (value > 0) return 'LOW';
  return 'NONE';
};

export const shortJid = (jid) => String(jid || '').replace(/@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)$/, '');

export const phoneLabel = (jid) => {
  const raw = shortJid(jid);
  if (/^\d+$/.test(raw)) {
    return '+' + raw.replace(/^(\d{2})(\d{1,3})(\d{3})(\d+)$/, '$1 $2 $3 $4');
  }
  return raw || '—';
};

export const bytes = (value) => {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

export const fence = (text, marker = '```') => `${marker}\n${text}\n${marker}`;

export const maskPreview = (text, limit = 90) => {
  const value = String(text ?? '');
  if (!value) return '(no readable text — binary/emoji payload)';
  const clean = value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '·');
  const collapsed = clean.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '(invisible characters only)';
  return collapsed.length > limit ? collapsed.slice(0, limit) + '…' : collapsed;
};

export default { count, plural, humanDate, humanUtc, relative, riskLabel, shortJid, phoneLabel, bytes, maskPreview };
