import fs from 'node:fs';
import path from 'node:path';
import qrcodeTerminal from 'qrcode-terminal';
import {
  box, clearStripTo, displayWidth, elapsed, icon, number, pad, stripAnsi,
  style, terminalWidth, truncate
} from './theme.js';

const LEVELS = { silent: -1, error: 0, warn: 1, notice: 2, info: 3, debug: 4 };

const LEVEL_STYLE = {
  error: { color: style.brightRed, label: 'ERROR ' },
  warn: { color: style.brightYellow, label: 'WARN  ' },
  notice: { color: style.brightCyan, label: 'NOTICE' },
  info: { color: style.gray, label: 'INFO  ' },
  debug: { color: style.dim, label: 'DEBUG ' }
};

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const clock = (date = new Date()) =>
  date.toTimeString().slice(0, 8) + '.' + String(date.getMilliseconds()).padStart(3, '0');

const renderQr = (value) => {
  let output = '';
  qrcodeTerminal.generate(String(value ?? ''), { small: true }, (buffer) => {
    output = buffer;
  });
  return output
    .split('\n')
    .filter((line) => stripAnsi(line).trim().length > 0)
    .map((line) => stripAnsi(line));
};

export const riskBadge = (risk) => {
  const value = Number(risk) || 0;
  if (value >= 180) return style.brightRed(`CRITICAL ${value}`);
  if (value >= 120) return style.red(`HIGH ${value}`);
  if (value >= 80) return style.brightYellow(`MEDIUM ${value}`);
  return style.yellow(`LOW ${value}`);
};

export const createUi = (options = {}) => {
  const {
    out = process.stdout,
    level = 'info',
    statsPanel = true,
    logFile = null,
    startedAt = Date.now(),
    getStats = () => ({}),
    getState = () => ({})
  } = options;

  const threshold = LEVELS[level] ?? LEVELS.info;
  const interactive = Boolean(out.isTTY) && statsPanel !== false;
  let stream = null;
  let stripLines = 0;
  let stripVisible = false;
  let taskLabel = '';
  let spinTimer = null;
  let spinFrame = 0;

  let broken = false;
  const noteBroken = () => {
    broken = true;
  };
  // A closed pipe (`antibugbot status | head -1`) must never take the process down.
  if (out && typeof out.on === 'function') out.on('error', noteBroken);

  const writeOut = (text) => {
    if (broken) return;
    try {
      out.write(text);
    } catch {
      noteBroken();
    }
  };

  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      stream = fs.createWriteStream(logFile, { flags: 'a' });
      stream.on('error', () => {
        stream = null;
      });
    } catch {
      stream = null;
    }
  }

  const clearStrip = () => {
    if (!interactive || !stripVisible) return;
    writeOut(clearStripTo(stripLines));
    stripVisible = false;
    stripLines = 0;
  };

  const renderStrip = () => {
    if (!interactive) return;
    const stats = getStats() || {};
    const state = getState() || {};
    const phase = state.phase || 'idle';
    const armed = phase === 'armed';
    const dot = armed
      ? style.brightGreen(icon('dot'))
      : phase === 'pairing' || phase === 'connecting'
        ? style.brightYellow(icon('dot'))
        : style.red(icon('dot'));
    const width = terminalWidth();
    const head = ' ' + dot + ' ' +
      (armed ? style.brightGreen('SHIELD ARMED') : style.bold('ANTIBUGBOT')) +
      style.dim(' · ' + phase) +
      (state.jid ? style.dim(' · ') + style.cyan(state.jid) : '') +
      (taskLabel ? style.dim(' · ') + style.magenta(SPINNER[spinFrame] + ' ' + taskLabel) : '') +
      style.dim(' · up ' + elapsed(Date.now() - startedAt));

    const counters = [
      ['scanned', number(stats.messagesScanned)],
      ['threats', number(stats.threatsDetected)],
      ['blocked', number(stats.blocked)],
      ['deleted', number(stats.deleted)],
      ['reports', `${number(stats.reportsFiled)}/${number(stats.reportsAttempted)}`],
      ['alerts', number(stats.alertsSent)]
    ];
    const cell = Math.max(10, Math.floor((width - 2) / counters.length));
    const body = ' ' + counters
      .map(([label, value]) => pad(style.dim(label) + ' ' + style.bold(value), cell))
      .join('');

    const lines = [truncate(head, width), truncate(body, width), style.dim(' ' + '─'.repeat(Math.max(0, width - 1)))];
    const wasVisible = stripVisible;
    if (wasVisible) {
      writeOut('\r' + String.fromCharCode(27) + '[0J');
      for (let i = 0; i < stripLines; i += 1) writeOut(String.fromCharCode(27) + '[1A\r' + String.fromCharCode(27) + '[2K');
    }
    writeOut(lines.join('\n') + '\n');
    stripLines = lines.length;
    stripVisible = true;
  };

  const emit = (line = '') => {
    clearStrip();
    const text = String(line ?? '');
    if (text !== '') writeOut(text + '\n');
    if (stream) {
      try {
        stream.write(stripAnsi(text) + '\n');
      } catch {
        stream = null;
      }
    }
    if (interactive) renderStrip();
  };

  const allow = (name) => (LEVELS[name] ?? 3) <= threshold;

  const log = (name, tag, message) => {
    const text = String(message ?? '');
    if (stream) {
      stream.write(`${new Date().toISOString()} ${String(name).toUpperCase().padEnd(6)} [${tag}] ${stripAnsi(text)}\n`);
    }
    if (!allow(name) && name !== 'error') return;
    const meta = LEVEL_STYLE[name] || LEVEL_STYLE.info;
    const label = String(tag || '').padEnd(9).slice(0, 9);
    emit(style.dim(clock()) + ' ' + meta.color(meta.label) + ' ' + style.bold(label) + ' ' + text);
  };

  const setTask = (label) => {
    taskLabel = label || '';
    renderStrip();
  };

  const banner = (info = {}) => {
    const art = [
      style.brightCyan('  ▄▄▄  ') + style.bold('AntiBugBot') + style.dim(`  v${info.version || '1.0.0'}`),
      style.brightCyan('  █▀ ▀█  ') + 'WhatsApp crash-bug shield',
      style.brightCyan('  ▀█▄█▀  ') + style.dim(`baileys ${info.baileys || 'v7'} · node ${process.version} · ${info.platform || 'linux'}`)
    ];
    const modeLine = info.shieldMode === 'observe'
      ? style.brightYellow('OBSERVE') + style.dim(' detect + alert, no enforcement')
      : style.brightGreen('ENFORCE') + style.dim(' block · delete for me · report · alert');
    const rows = [
      ...art,
      style.dim('  ' + '─'.repeat(56)),
      '  ' + style.bold('trigger ') + style.cyan(`${number(info.threshold)} chars`) +
        style.dim('   reports ') + style.cyan(`${number(info.reportAttempts)}×`) +
        style.dim('   delete ') + style.cyan(info.deleteMode),
      '  ' + style.bold('groups  ') + style.cyan(info.groupsMode) +
        style.dim('   owner  ') + style.cyan(info.owner || 'self chat'),
      '  ' + style.bold('mode    ') + modeLine
    ];
    writeOut('\n' + box(rows, { title: ' ANTI-BUG SHIELD ', color: style.brightCyan }) + '\n');
  };

  const keyPanel = (title, entries, color = style.cyan) => {
    const rows = entries.map(([key, value]) =>
      style.dim(pad(String(key), 22)) + (value === undefined || value === '' ? style.gray('—') : String(value))
    );
    emit(box(rows, { title, color }));
  };

  const panel = (title, rows, color = style.cyan) =>
    emit(box(rows.map((row) => (Array.isArray(row) ? style.dim(pad(row[0], row[2] ?? 20)) + row[1] : String(row))), { title, color }));

  const qr = (code, info = {}) => {
    clearStrip();
    const buffer = renderQr(code);
    const width = Math.max(...buffer.map((line) => displayWidth(line)));
    const quiet = 2;
    const framed = [
      ...buffer.map((line) => style.inverse(pad(' '.repeat(quiet) + line + ' '.repeat(quiet), width + quiet * 2))),
      style.inverse(pad('', width + quiet * 2))
    ];
    writeOut('\n');
    writeOut(box(framed, { title: ' SCAN WITH WHATSAPP ', color: style.brightMagenta, padding: 1 }) + '\n');
    if (info.sub) writeOut(style.dim('  ' + info.sub) + '\n');
    writeOut(
      style.dim(
        `  WhatsApp → Settings → Linked devices → Link a device.  ${info.rotateSec ? `Code rotates every ${info.rotateSec}s.` : ''}`
      ) + '\n\n'
    );
    if (interactive) renderStrip();
  };

  const pairingCode = (code) => {
    emit(box([
      style.dim('  On the other phone: WhatsApp → Settings → Linked devices → Link a device → '),
      style.dim('  tap ') + style.bold('"Link with phone number instead"') + style.dim(' and enter:'),
      '',
      '      ' + style.brightGreen(style.bold(code || '')),
      ''
    ], { title: ' PAIRING CODE ', color: style.brightGreen }));
  };

  const threat = (incident) => {
    const rows = [
      style.boldRed(icon('bug') + ' ' + incident.rules.map((item) => item.label).join(' · ')),
      style.dim(pad('sender', 10)) + style.cyan(incident.senderLabel || incident.sender || 'unknown') +
        (incident.isGroup ? style.dim('  in group ') + style.yellow(incident.groupId) : ''),
      style.dim(pad('length', 10)) + style.brightYellow(`${number(incident.counted)} chars`) +
        style.dim(` / trigger ${number(incident.threshold)}`) + style.dim('  risk ') + riskBadge(incident.risk),
      style.dim(pad('evidence', 10)) + style.gray('"' + truncate(incident.preview || '(no text payload)', 90) + '"'),
      ...incident.rules
        .filter((item) => item.id !== 'oversize')
        .map((item) => style.dim(pad('signal', 10)) + style.magenta(`${item.label} — ${item.detail}`)),
      style.dim(pad('time', 10)) + style.gray(incident.timeLabel || clock(new Date(incident.timestamp * 1000)))
    ];
    emit(box(rows, { title: ` INCIDENT ${incident.id} `, color: style.brightRed }));
  };

  const action = (name, status, detail = '') => {
    const marks = {
      ok: style.brightGreen(icon('check')),
      skip: style.gray('·'),
      dry: style.brightYellow('◌'),
      fail: style.brightRed(icon('cross')),
      wait: style.brightYellow('…')
    };
    emit('   ' + (marks[status] || marks.ok) + ' ' + style.bold(pad(String(name), 14)) + ' ' + detail);
  };

  const alert = (target, status, detail = '') => {
    if (status === 'ok') log('notice', 'alert', `${icon('mail')} brief delivered to ${style.cyan(target)} ${style.dim(detail)}`);
    else if (status === 'skip') log('notice', 'alert', `no owner number set — brief saved to disk and printed here`);
    else log('warn', 'alert', `${icon('cross')} could not deliver brief to ${target} ${style.dim(detail)}`);
  };

  const done = (text) => emit(style.brightGreen(' ' + icon('check')) + ' ' + text);
  const fail = (text) => emit(style.brightRed(' ' + icon('cross')) + ' ' + text);
  const note = (text, color = style.dim) => emit(' ' + color(text));

  const spin = async (text, task) => {
    const started = Date.now();
    setTask(text);
    log('info', 'task', style.magenta(SPINNER[0]) + ' ' + text);
    if (interactive) {
      spinTimer = setInterval(() => {
        spinFrame = (spinFrame + 1) % SPINNER.length;
        renderStrip();
      }, 110);
      if (typeof spinTimer.unref === 'function') spinTimer.unref();
    }
    const stop = () => {
      if (spinTimer) clearInterval(spinTimer);
      spinTimer = null;
      setTask('');
    };
    try {
      const result = await task({ update: (next) => setTask(next) });
      log('info', 'task', style.brightGreen(icon('check')) + ' ' + text + style.dim(` · ${elapsed(Date.now() - started)}`));
      return result;
    } catch (error) {
      log('error', 'task', style.brightRed(icon('cross')) + ' ' + text + style.dim(` · ${elapsed(Date.now() - started)}`) + ' ' + style.red(error?.message || String(error)));
      throw error;
    } finally {
      stop();
    }
  };

  const close = async () => {
    clearStrip();
    if (spinTimer) clearInterval(spinTimer);
    if (stream) await new Promise((resolve) => stream.end(resolve));
  };

  return {
    log,
    info: (tag, msg) => log('info', tag, msg),
    warn: (tag, msg) => log('warn', tag, msg),
    error: (tag, msg) => log('error', tag, msg),
    debug: (tag, msg) => log('debug', tag, msg),
    notice: (tag, msg) => log('notice', tag, msg),
    raw: emit,
    banner,
    panel,
    keyPanel,
    qr,
    pairingCode,
    threat,
    action,
    alert,
    done,
    fail,
    note,
    spin,
    setTask,
    renderStrip,
    clearStrip,
    close,
    level,
    logFilePath: logFile
  };
};

export default createUi;
