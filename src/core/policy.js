/**
 * Decision layer: turns (content risk + volume + relationship trust) into one
 * action. Kept as a pure function of inputs so the whole abuse-handling ladder
 * is reviewable and testable in one file.
 *
 * NOTE: there is intentionally no "reply with", "send", or "forward" action here.
 * The bot's only outbound traffic is a short, redacted warning to the sender and,
 * if enabled, to the owner. Payload text never leaves quarantine.
 */

/** Escalation ladder, low -> high. */
export const ACTIONS = ['allow', 'log', 'warn', 'delete', 'restrict', 'mute', 'cooldown', 'block'];

export const actionIndex = (a) => ACTIONS.indexOf(a);
const maxAction = (a, b) => (actionIndex(a) >= actionIndex(b) ? a : b);

/**
 * @typedef {object} Decision
 * @property {'allow'|'log'|'warn'|'delete'|'restrict'|'mute'|'cooldown'|'block'} action
 * @property {string[]} reasons machine-readable reason codes (never contains payload text)
 * @property {number} strikes strikes attributed to this event
 * @property {boolean} quarantine store a redacted fingerprint
 */

/**
 * @param {object} ctx
 * @param {{verdict:string, risk:number, signals:string[]}} ctx.detection
 * @param {number} [ctx.windowCount] messages from sender in window
 * @param {number} [ctx.chatCount] messages in chat in window
 * @param {boolean} [ctx.bucketAllowed] token-bucket admission for sender
 * @param {number} [ctx.strikes] current strike count for sender
 * @param {boolean} [ctx.trusted] sender in allowlist (owner/admins)
 * @param {boolean} [ctx.isGroup]
 * @param {number} [ctx.mediaSizeBytes]
 * @param {number} ctx.now
 * @param {object} cfg policy config (see config.defaults.json)
 */
export function decide(ctx, cfg) {
  const {
    detection,
    windowCount = 0,
    chatCount = 0,
    bucketAllowed = true,
    strikes = 0,
    trusted = false,
    isGroup = false,
    mediaSizeBytes = 0,
  } = ctx;

  const reasons = [];
  let action = 'allow';

  if (trusted) {
    // allowlisted accounts still get screened for their own safety, but never punished
    if (detection.verdict !== 'clean') action = 'log';
    return finalize(action, reasons, 0, false, cfg);
  }

  // 1. content
  if (detection.verdict === 'hostile') {
    action = maxAction(action, 'delete');
    reasons.push(`content.hostile:risk=${detection.risk}`);
    for (const s of detection.signals) reasons.push(`content.signal.${s}`);
  } else if (detection.verdict === 'suspect') {
    action = maxAction(action, 'log');
    reasons.push(`content.suspect:risk=${detection.risk}`);
  }

  // 2. media oversized -> never downloaded past the cap; reject the *reference*
  if (mediaSizeBytes > cfg.maxMediaBytes) {
    action = maxAction(action, 'delete');
    reasons.push('media.oversize');
  }

  // 3. volume
  if (chatCount >= cfg.flood.chatMsgsPerMin) {
    action = maxAction(action, 'cooldown');
    reasons.push(`flood.chat:${chatCount}/min`);
  } else if (windowCount >= cfg.flood.msgsPerMin) {
    action = maxAction(action, 'warn');
    reasons.push(`flood.sender:${windowCount}/min`);
  }
  if (!bucketAllowed) {
    action = maxAction(action, 'restrict');
    reasons.push('flood.burst');
  }

  // 4. unknown-sender amplification: hostile content from a non-contact is the
  //    exact crash-bot signature (drive-by blast to strangers).
  if (detection.verdict === 'hostile' && !ctx.isKnownContact) {
    action = maxAction(action, 'restrict');
    reasons.push('driveby.hostileFromUnknown');
  }

  // 5. strike escalation
  let strikeAdd = 0;
  if (actionIndex(action) >= actionIndex('delete')) strikeAdd = 2;
  else if (actionIndex(action) >= actionIndex('warn')) strikeAdd = 1;

  const escalated = escalate(action, strikes, cfg, isGroup);
  action = escalated.action;
  reasons.push(...escalated.reasons);

  const quarantine = actionIndex(action) >= actionIndex('delete');
  return finalize(action, reasons, strikeAdd, quarantine, cfg);
}

function escalate(action, strikes, cfg, isGroup) {
  const reasons = [];
  if (strikes >= cfg.strikes.blockAfter) {
    if (actionIndex(action) < actionIndex('block')) {
      reasons.push(`escalate.block@strikes=${strikes}`);
      action = 'block';
    }
  } else if (strikes >= cfg.strikes.muteAfter) {
    if (actionIndex('mute') > actionIndex(action)) {
      reasons.push(`escalate.mute@strikes=${strikes}`);
      action = isGroup ? maxAction(action, 'mute') : maxAction(action, 'restrict');
    }
  }
  return { action, reasons };
}

function finalize(action, reasons, strikeAdd, quarantine, cfg) {
  return {
    action,
    reasons: dedupe(reasons),
    strikes: strikeAdd,
    quarantine: quarantine && cfg.quarantine.enabled,
  };
}

/**
 * Short, non-reflective notice to the sender. Deliberately contains zero
 * attacker-supplied text (no quoting) and never explains detection thresholds
 * in a way that helps an evader tune a payload.
 */
export function noticeText(lang = 'si') {
  return lang === 'si'
    ? 'මේ message එක auto-block කරලා තියෙනවා (crash/bug bot traffic filter). Spam යවන්න එපා.'
    : 'This message was blocked by the crash-bot traffic filter. Do not send automated payloads.';
}

function dedupe(arr) {
  return [...new Set(arr)];
}
