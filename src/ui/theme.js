const forceColor = /^(1|2|3|true|yes|on)$/i.test(String(process.env.FORCE_COLOR || ''));

const defaultColorOk =
  (Boolean(process.stdout.isTTY) || forceColor) &&
  !('NO_COLOR' in process.env) &&
  process.env.FORCE_COLOR !== '0' &&
  process.env.TERM !== 'dumb';

let colorOk = defaultColorOk;

/** 'on' | 'off' | 'auto' — lets --color / --no-color win over the environment. */
export const setColorMode = (mode) => {
  if (mode === 'on') colorOk = true;
  else if (mode === 'off') colorOk = false;
  else colorOk = defaultColorOk;
  return colorOk;
};

export const getColorMode = () => colorOk;

const ESC = String.fromCharCode(27);
const CSI = (params) => ESC + '[' + params + 'm';

const CODES = {
  reset: 0, bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7,
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94,
  brightMagenta: 95, brightCyan: 96, bgRed: 41, bgGreen: 42, bgYellow: 43, bgBlue: 44, bgGray: 100
};

const wrap = (...names) => {
  const fn = (text) => {
    const s = String(text ?? '');
    if (!colorOk || s === '') return s;
    const params = names.map((n) => CODES[n]).join(';');
    return CSI(params) + s + CSI(CODES.reset);
  };
  return fn;
};

export const style = {
  bold: wrap('bold'),
  dim: wrap('dim'),
  italic: wrap('italic'),
  underline: wrap('underline'),
  inverse: wrap('inverse'),
  red: wrap('red'),
  green: wrap('green'),
  yellow: wrap('yellow'),
  blue: wrap('blue'),
  magenta: wrap('magenta'),
  cyan: wrap('cyan'),
  gray: wrap('gray'),
  white: wrap('white'),
  brightRed: wrap('brightRed'),
  brightGreen: wrap('brightGreen'),
  brightYellow: wrap('brightYellow'),
  brightCyan: wrap('brightCyan'),
  boldRed: wrap('bold', 'red'),
  boldGreen: wrap('bold', 'green'),
  boldYellow: wrap('bold', 'yellow'),
  boldBlue: wrap('bold', 'blue'),
  boldCyan: wrap('bold', 'cyan'),
  boldMagenta: wrap('bold', 'magenta'),
  boldGray: wrap('bold', 'gray'),
  colorOk
};

const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');

export const stripAnsi = (line) => String(line ?? '').replace(ANSI_RE, '');

const EMOJI_PRESENTATION = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3,
  0x25fd, 0x25fe, 0x2614, 0x2615, 0x2648, 0x2649, 0x264a, 0x264b, 0x264c, 0x264d,
  0x264e, 0x264f, 0x2650, 0x2651, 0x2652, 0x2653, 0x267f, 0x2693, 0x26a1, 0x26aa,
  0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3,
  0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753,
  0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c,
  0x3030, 0x303d, 0x3297, 0x3299
]);

export const charWidth = (ch) => {
  const code = ch.codePointAt(0);
  if (code < 0x20) return 0;
  if (code < 0x7f) return 1;
  if (code >= 0x80 && code <= 0x2bff) {
    if (EMOJI_PRESENTATION.has(code)) return 2;
    if (
      (code >= 0x300 && code <= 0x36f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0xfe00 && code <= 0xfe0f)
    ) return 0;
    return 1;
  }
  if (
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x1b000 && code <= 0x1b0ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
};

export const wrapTo = (text, width) => {
  const limit = Math.max(8, Math.trunc(width));
  const words = String(text ?? '').split(/(?<=\s)/);
  const out = [];
  let line = '';
  for (const word of words) {
    if (displayWidth(line) + displayWidth(word) > limit && line.trim()) {
      out.push(line.replace(/\s+$/, ''));
      line = word.replace(/^\s+/, '');
    } else {
      line += word;
    }
    while (displayWidth(line) > limit) {
      let cut = 0;
      let used = 0;
      for (const ch of line) {
        const w = charWidth(ch);
        if (used + w > limit) break;
        used += w;
        cut += ch.length;
      }
      if (cut === 0) cut = 1;
      out.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line.length) out.push(line.replace(/\s+$/, ''));
  return out.length ? out : [''];
};

export const displayWidth = (text) => {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch);
  return width;
};

export const pad = (text, width, align = 'left') => {
  const room = Math.max(0, width - displayWidth(text));
  if (align === 'right') return ' '.repeat(room) + text;
  if (align === 'center') {
    const left = Math.floor(room / 2);
    return ' '.repeat(left) + text + ' '.repeat(room - left);
  }
  return text + ' '.repeat(room);
};

export const truncate = (text, width, mark = '...') => {
  const plain = stripAnsi(text);
  if (displayWidth(plain) <= width) return text;
  const budget = Math.max(0, width - mark.length);
  let out = '';
  let used = 0;
  for (const ch of plain) {
    const w = charWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out + mark;
};

export const terminalWidth = () => {
  const cols = Number(process.stdout.columns || process.env.COLUMNS || 80);
  const clamp = Number.isFinite(cols) ? Math.trunc(cols) : 80;
  return Math.min(120, Math.max(48, clamp));
};

export const BOX = {
  topLeft: '╔', topRight: '╗', bottomLeft: '╚', bottomRight: '╝',
  horizontal: '═', vertical: '║', leftTee: '╠', rightTee: '╣',
  midTop: '╤', midBottom: '╧',
  lightTopLeft: '┌', lightTopRight: '┐', lightBottomLeft: '└', lightBottomRight: '┘',
  lightHorizontal: '─', lightVertical: '│', lightLeftTee: '├', lightRightTee: '┤'
};

const boxChar = (name, asciiOnly) => (asciiOnly ? {
  topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', horizontal: '-', vertical: '|',
  leftTee: '+', rightTee: '+', midTop: '+', midBottom: '+',
  lightTopLeft: '+', lightTopRight: '+', lightBottomLeft: '+', lightBottomRight: '+',
  lightHorizontal: '-', lightVertical: '|', lightLeftTee: '+', lightRightTee: '+'
}[name] : BOX[name]);

export const box = (lines, options = {}) => {
  const {
    title = '',
    color = null,
    width = null,
    padding = 1,
    light = false,
    ascii = !colorOk
  } = options;
  const maxWidth = width || (Math.min(terminalWidth(), 132) - 6);
  const plain = lines
    .flatMap((line) => String(line ?? '').split('\n'))
    .flatMap((line) => (displayWidth(line) > maxWidth ? wrapTo(line, maxWidth) : [line]));
  const inner = Math.max(
    title ? displayWidth(title) + 4 : 0,
    ...plain.map((line) => displayWidth(line)),
    width ? width - 2 - padding * 2 : 0
  );
  const size = inner + padding * 2;
  const paint = (text) => (color ? color(text) : text);
  const glyph = (name) => boxChar(name, ascii);
  const side = glyph(light ? 'lightVertical' : 'vertical');
  const fill = glyph(light ? 'lightHorizontal' : 'horizontal');
  const corners = {
    top: [glyph(light ? 'lightTopLeft' : 'topLeft'), glyph(light ? 'lightTopRight' : 'topRight')],
    bottom: [glyph(light ? 'lightBottomLeft' : 'bottomLeft'), glyph(light ? 'lightBottomRight' : 'bottomRight')]
  };

  const row = (content) => {
    const text = String(content ?? '');
    const filler = ' '.repeat(Math.max(0, size - padding - displayWidth(text)));
    return side + ' '.repeat(padding) + text + filler + side;
  };
  const line = (left, right) => paint(left + fill.repeat(size) + right);

  const out = [];
  if (title) {
    const label = ' ' + title + ' ';
    const labelWidth = displayWidth(label);
    const left = Math.max(0, Math.floor((size - labelWidth) / 2));
    const right = Math.max(0, size - labelWidth - left);
    out.push(
      paint(corners.top[0]) + paint(fill.repeat(left)) +
      (color ? color(label) : style.bold(label)) +
      paint(fill.repeat(right)) + paint(corners.top[1])
    );
  } else {
    out.push(line(...corners.top));
  }
  if (plain.length === 0) out.push(row(''));
  for (const entry of plain) out.push(row(entry));
  out.push(line(...corners.bottom));
  return out.join('\n');
};

export const rule = (label = '', options = {}) => {
  const { width = terminalWidth() - 2, color = style.gray, char = '─' } = options;
  if (!label) return color(char.repeat(width));
  const head = ' ' + label + ' ';
  const rest = Math.max(0, width - displayWidth(head) - 2);
  return color(char.repeat(2) + head + char.repeat(rest));
};

export const icons = {
  shield: '🛡',
  bug: '🐞',
  check: '✔',
  cross: '✖',
  warn: '⚠',
  dot: '●',
  arrow: '→',
  block: '⛔',
  trash: '🗑',
  flag: '🚩',
  mail: '✉',
  key: '🔑',
  spark: '✦',
  clock: '⏱',
  link: '🔗',
  eye: '👁',
  hammer: '🔨'
};

export const asciiIcons = {
  shield: '[+]', bug: '[!]', check: '[ok]', cross: '[x]', warn: '[!]', dot: '*',
  arrow: '->', block: '[block]', trash: '[del]', flag: '[report]', mail: '[msg]',
  key: '[key]', spark: '*', clock: '[t]', link: '[link]', eye: '[watch]', hammer: '#'
};

export const icon = (name) => (colorOk && osSupportsEmoji() ? icons[name] : asciiIcons[name]);

let emojiCache = null;
const osSupportsEmoji = () => {
  if (emojiCache === null) {
    const platform = process.platform;
    const term = String(process.env.TERM_PROGRAM || '');
    emojiCache = platform === 'win32' ? Number(process.env.WT_SESSION || 0) > 0 || term === 'WezTerm' : true;
  }
  return emojiCache;
};

export const elapsed = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.floor(ms / 1000);
  const mins = Math.floor(total / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
  return `${mins}m ${String(total % 60).padStart(2, '0')}s`;
};

export const number = (value) =>
  String(Math.trunc(Math.abs(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const clearStripTo = (lines) => {
  const ESC_CHAR = String.fromCharCode(27);
  let out = '\r' + ESC_CHAR + '[0J';
  for (let i = 0; i < lines; i += 1) out += ESC_CHAR + '[1A\r' + ESC_CHAR + '[2K';
  return out;
};

export const isColorOn = () => colorOk;

export default {
  style, box, rule, pad, truncate, icon, displayWidth, stripAnsi,
  terminalWidth, elapsed, number, clearStripTo, wrapTo, setColorMode, isColorOn
};