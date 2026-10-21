import { count } from './format.js';
import { countedLength, measureText, previewText } from './measure.js';

export const RULES = [
  {
    id: 'oversize',
    label: 'Oversized message',
    detail: (ctx) => `${count(ctx.counted)} characters — ${count(ctx.counted - ctx.threshold)} over the ${count(ctx.threshold)} character trigger`,
    severity: 100,
    test: (ctx) => ctx.counted > ctx.threshold
  },
  {
    id: 'invisible-inflation',
    label: 'Invisible character inflation',
    detail: (ctx) =>
      `${ctx.metrics.invisible} zero-width/bidi characters hidden in ${ctx.metrics.graphemes} graphemes`,
    severity: 80,
    test: (ctx) =>
      ctx.metrics.invisible >= 8 &&
      (ctx.metrics.invisibleRatio > 0.25 ||
        (ctx.counted > ctx.threshold / 2 && ctx.metrics.invisibleRatio > 0.08))
  },
  {
    id: 'unicode-tags',
    label: 'Unicode tag-block payload',
    detail: (ctx) => `${ctx.metrics.unicodeTags} characters in the U+E0000 tag block`,
    severity: 90,
    test: (ctx) => ctx.metrics.unicodeTags >= 4
  },
  {
    id: 'control-chars',
    label: 'Raw control characters',
    detail: (ctx) => `${ctx.metrics.controlChars} non-printing control codes`,
    severity: 70,
    test: (ctx) => ctx.metrics.controlChars >= 4
  },
  {
    id: 'bidi-override',
    label: 'Bidirectional override spam',
    detail: (ctx) => `${ctx.metrics.rtlOverrides} RTL/LTR override codes`,
    severity: 60,
    test: (ctx) => ctx.metrics.rtlOverrides >= 3
  },
  {
    id: 'zwj-bomb',
    label: 'ZWJ / variation-selector bomb',
    detail: (ctx) =>
      `${ctx.metrics.zwj} joiners + ${ctx.metrics.variationSelectors} variation selectors`,
    severity: 85,
    test: (ctx) => ctx.metrics.zwj >= 200 || ctx.metrics.variationSelectors >= 300
  },
  {
    id: 'combining-stack',
    label: 'Stacked combining marks',
    detail: (ctx) => `${ctx.metrics.maxCombiningStack} combining marks in one run`,
    severity: 65,
    test: (ctx) => ctx.metrics.maxCombiningStack >= 60
  },
  {
    id: 'line-bomb',
    label: 'Line-count flood',
    detail: (ctx) => `${ctx.metrics.lines} newline-separated lines`,
    severity: 55,
    test: (ctx) => ctx.metrics.lines >= 5000
  },
  {
    id: 'broken-encoding',
    label: 'Malformed encoding',
    detail: (ctx) =>
      `${ctx.metrics.unpairedSurrogates} unpaired surrogate code units (breaks renderers)`,
    severity: 75,
    test: (ctx) => ctx.metrics.unpairedSurrogates >= 2
  }
];

export const evaluateText = (text, options = {}) => {
  const {
    threshold = 2000,
    countMode = 'max',
    heuristics = true,
    rules = RULES,
    extraLength = 0
  } = options;

  const metrics = measureText(text);
  const counted = countedLength(metrics, countMode) + Math.max(0, extraLength);
  const context = { threshold, countMode, metrics, counted, text: String(text ?? '') };

  const matched = [];
  for (const rule of rules) {
    if (!heuristics && rule.id !== 'oversize') continue;
    let hit = false;
    try {
      hit = Boolean(rule.test(context));
    } catch {
      hit = false;
    }
    if (hit) {
      matched.push({
        id: rule.id,
        label: rule.label,
        detail: rule.detail(context),
        severity: rule.severity
      });
    }
  }

  const risk = matched.reduce((total, rule) => total + rule.severity, 0);

  return {
    triggered: matched.length > 0,
    rules: matched,
    primary: matched.find((rule) => rule.id === 'oversize') ? 'oversize' : (matched[0]?.id ?? null),
    risk,
    counted,
    threshold,
    metrics,
    preview: previewText(text, 160)
  };
};

const SECONDARY_FIELDS = ['formattedCaption', 'title', 'description', 'fileName', 'footerText', 'body', 'contentText'];

/**
 * Some payloads repeat the same text across sibling fields — caption plus formatted
 * caption plus a title and footer — so every renderer lays the string out again.
 * The primary body is already measured, so only the secondary fields are added here,
 * and only when COUNT_PAYLOAD is on.
 */
export const extraPayloadLength = (message, config = {}) => {
  if (!config.countPayload || !message || typeof message !== 'object') return 0;
  let total = 0;
  for (const value of Object.values(message)) {
    if (!value || typeof value !== 'object') continue;
    for (const field of SECONDARY_FIELDS) {
      const candidate = value[field];
      if (typeof candidate === 'string') total += candidate.length;
    }
  }
  return total;
};

export default { evaluateText, RULES, extraPayloadLength };
