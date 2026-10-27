import { bytes, count, humanDate, humanUtc, maskPreview, riskLabel } from './format.js';

const tick = (status) => (status === 'ok' ? '✔' : status === 'skip' ? '◽' : status === 'dry' ? '◌' : '✖');

const line = (label, value) => `${label}: ${value}`;

export const renderBrief = (incident, context = {}) => {
  const { config = {}, host = {}, reports = null } = context;
  const detection = incident.detection || {};
  const actions = incident.actions || {};
  const sender = incident.sender || {};
  const threshold = config.thresholdChars ?? 2000;
  const over = Math.max(0, (detection.counted || 0) - threshold);

  const signalList = (detection.rules || []).length
    ? (detection.rules || []).map((rule) => `  • ${rule.label} — ${rule.detail}`).join('\n')
    : '  • no secondary signals (plain length overflow)';

  const reportLine = reports
    ? reports.channel === 'evidence'
      ? `🚩 reports — 0/${count(reports.attempts)} filed · WhatsApp has no report call on the socket\n   evidence packet: ${reports.packetPath || 'not written'}\n   in-app: open the chat → tap the contact → Report → Report`
      : `🚩 reports — ${count(reports.filed)}/${count(reports.attempts)} filed via ${reports.channel}${reports.note ? ` · ${reports.note}` : ''}`
    : '🚩 reports — not attempted';

  const mode = incident.mode === 'observe' ? 'OBSERVE (nothing enforced)' : 'ENFORCE';

  return [
    '🛡 *AntiBugBot — threat neutralised*',
    `ID ${incident.id} · risk *${riskLabel(detection.risk)}* (${detection.risk || 0}) · ${mode}`,
    '',
    '*What happened / මොකද වුණේ*',
    `Someone sent a *${count(detection.counted)}-character* message to this number —`,
    `*${count(over)} chars over* the ${count(threshold)}-character crash trigger.`,
    'Messages that long are used to freeze or crash WhatsApp and the phone,',
    'so the shield quarantined it before the client had to render it.',
    '',
    `අකුරු *${count(detection.counted)}* මැසේජ් එකක් මේ අංකෙට එවලා තියෙනවා. අකුරු`,
    `*${count(threshold)}* ට වැඩි නිසා ෆෝන් එකට / WhatsApp එකට වැදුණොත්`,
    `freeze හෝ crash වෙන්න පුළුවන්. ඒ නිසා shield එක මේක bug attack එකක්`,
    'විදිහට හඳුනාගෙන *දුර්වල කළ* අතර යවපු අංකය block කළා.',
    '',
    '*Sender / යවපු අංකය*',
    `  ${line('number', sender.phone || 'unknown')}`,
    sender.pushName ? `  ${line('name in chat', sender.pushName)}` : null,
    `  ${line('jid', incident.chat?.jid || '—')}`,
    `  ${line('chat type', incident.chat?.isGroup ? `group (${incident.chat.jid})` : 'direct message')}`,
    `  ${line('message id', incident.message?.id || '—')}`,
    `  ${line('repeat offender', context.repeat?.count ? `${count(context.repeat.count)} prior incident(s), last ${humanDate(context.repeat.lastAt)}` : 'first time from this number')}`,
    '',
    '*Payload / මැසේජ් එක*',
    `  ${line('type', incident.message?.type || '—')}`,
    `  ${line('size', `${count(detection.counted)} chars · ${bytes(detection.metrics?.bytes)} · ${count(detection.metrics?.lines)} lines`)}`,
    `  ${line('counted as', `${config.countMode || 'max'} (graphemes ${count(detection.metrics?.graphemes)} / utf16 ${count(detection.metrics?.codeUnits)})`)}`,
    `  ${line('hidden chars', `${count(detection.metrics?.invisible)} zero-width/bidi · ${count(detection.metrics?.unicodeTags)} unicode tags · ${count(detection.metrics?.controlChars)} control codes`)}`,
    '  signals:',
    signalList,
    `  preview: "${maskPreview(detection.preview, 60)}"`,
    '',
    '*Action taken / කළ වැඩ*',
    `  ${tick(actions.delete?.status)} message — ${actions.delete?.detail || 'not attempted'}`,
    `  ${tick(actions.block?.status)} block — ${actions.block?.detail || 'not attempted'}`,
    actions.mute?.status ? `  ${tick(actions.mute.status)} group muted — ${actions.mute.detail}` : null,
    `  ${reportLine}`,
    '',
    '*When*',
    `  ${line('received', humanDate(incident.timestamp * 1000) + `  (${humanUtc(incident.timestamp * 1000)})`)}`,
    `  ${line('neutralised', humanDate(incident.createdAt))}`,
    host.uptime ? `  ${line('shield uptime', host.uptime)}` : null,
    host.jid ? `  ${line('this account', host.jid)}` : null,
    '',
    'Tip: unblock later with `npm run unblock -- ' + String(sender.phone || '').replace('+', '') + '`'
  ]
    .filter((entry) => entry !== null && entry !== undefined && entry !== '')
    .join('\n');
};

export const renderArmNotice = (host, config, capability) => {
  const lines = [
    '🛡 *AntiBugBot armed*',
    '',
    `trigger  ${count(config.thresholdChars)} chars (${config.countMode})`,
    `block    ${config.block ? 'on' : 'off'}`,
    `delete   ${config.deleteMode}`,
    `reports  ${count(config.reportAttempts)}× via ${capability?.channel || config.reportChannel}`,
    `groups   ${config.groupsMode}`,
    `mode     ${config.shieldMode === 'observe' ? 'OBSERVE (no enforcement)' : 'ENFORCE'}`,
    `account  ${host.jid || '—'}`,
    '',
    config.heuristics
      ? 'Watching for: length overflow, zero-width/bidi inflation, unicode tag blocks, ZWJ bombs, control chars, broken encoding.'
      : 'Watching for: length overflow only (heuristics off).',
    '',
    'බලාගන්නවා: අකුරු 2,000ට වැඩි මැසේජ්, hidden character attacks. එව්වාම block + delete + මේ number එකට brief එකක්.'
  ];
  return lines.join('\n');
};

export const renderStatsReply = (snapshot, config, capability) => {
  const stats = snapshot.stats || {};
  return [
    '📊 *AntiBugBot status*',
    '',
    `scanned  ${count(stats.messagesScanned)} messages`,
    `threats  ${count(stats.threatsDetected)}`,
    `blocked  ${count(stats.blocked)} (${count(snapshot.blockedCount)} numbers currently shielded)`,
    `deleted  ${count(stats.deleted)}`,
    `reports  ${count(stats.reportsFiled)}/${count(stats.reportsAttempted)} filed · channel ${capability?.channel || config.reportChannel}`,
    `alerts   ${count(stats.alertsSent)} sent, ${count(stats.alertsFailed)} failed`,
    `errors   ${count(stats.errors)}`,
    '',
    `trigger ${count(config.thresholdChars)} chars · mode ${config.shieldMode} · groups ${config.groupsMode}`
  ].join('\n');
};

export default { renderBrief, renderArmNotice, renderStatsReply };
