import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  isJidGroup,
  jidNormalizedUser,
  delay
} from '@whiskeysockets/baileys';
import { evaluateText, extraPayloadLength } from './core/guard.js';
import { buildIncident, extractText, vcardLength } from './core/incident.js';
import { isBroadcastish, phoneOf } from './core/jid.js';
import { Enforcer } from './actions/enforce.js';
import { ReportEngine } from './actions/report.js';
import { notifyArm, resolveOwnerJid } from './actions/notify.js';
import { renderStatsReply } from './core/brief.js';
import { box, elapsed, pad, style } from './ui/theme.js';

const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 15_000, 30_000];

const CLOSE_REASONS = {
  401: { title: 'session logged out on the phone', action: 'relink' },
  403: { title: 'forbidden — WhatsApp refused this session', action: 'relink' },
  408: { title: 'server timeout', action: 'retry' },
  411: { title: 'device conflict (another client took over)', action: 'retry' },
  428: { title: 'pairing timed out before the code was used', action: 'retry' },
  440: { title: 'replaced by a second client using this session', action: 'retry' },
  500: { title: 'WhatsApp internal error', action: 'retry' },
  503: { title: 'WhatsApp maintenance', action: 'retry' },
  515: { title: 'restart requested by WhatsApp', action: 'retry' }
};

const describeClose = (statusCode, error) => {
  const message = String(error?.message || error || '');
  const known = CLOSE_REASONS[statusCode];
  const network = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|network|fetch failed|socket hang up/i;
  if (network.test(message)) {
    return {
      title: `no route to WhatsApp${statusCode ? ` (socket ${statusCode})` : ''}`,
      detail: message,
      action: 'retry'
    };
  }
  if (known) return { title: `${statusCode} ${known.title}`, detail: message, action: known.action };
  return {
    title: statusCode ? `socket closed (${statusCode})` : 'socket closed',
    detail: message,
    action: 'retry'
  };
};

const makeLogger = (ui, level) => {
  const map = { silent: 'silent', error: 'error', warn: 'warn', info: 'info', debug: 'debug' };
  const enabled = map[level] !== undefined && level !== 'silent';
  const emit = (name, message, extra) => {
    if (!enabled) return;
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    ui?.debug?.('wa', name + ' ' + text + (extra && level === 'debug' ? ' ' + JSON.stringify(extra).slice(0, 200) : ''));
  };
  const logger = {
    level: map[level] || 'info',
    child: (bindings = {}) => {
      const label = bindings.name ? `[${bindings.name}] ` : '';
      return {
        ...logger,
        child: logger.child,
        fatal: (obj, msg) => emit('fatal', label + (typeof obj === 'string' ? obj : msg), obj),
        error: (obj, msg) => emit('error', label + (typeof obj === 'string' ? obj : msg), obj),
        warn: (obj, msg) => emit('warn', label + (typeof obj === 'string' ? obj : msg), obj),
        info: (obj, msg) => emit('info', label + (typeof obj === 'string' ? obj : msg), obj),
        debug: (obj, msg) => emit('debug', label + (typeof obj === 'string' ? obj : msg), obj),
        trace: (obj, msg) => emit('debug', label + (typeof obj === 'string' ? obj : msg), obj)
      };
    },
    fatal: (obj, msg) => emit('fatal', typeof obj === 'string' ? obj : msg, obj),
    error: (obj, msg) => emit('error', typeof obj === 'string' ? obj : msg, obj),
    warn: (obj, msg) => emit('warn', typeof obj === 'string' ? obj : msg, obj),
    info: (obj, msg) => emit('info', typeof obj === 'string' ? obj : msg, obj),
    debug: (obj, msg) => emit('debug', typeof obj === 'string' ? obj : msg, obj),
    trace: (obj, msg) => emit('trace', typeof obj === 'string' ? obj : msg, obj)
  };
  return logger;
};

export class AntiBugBot {
  constructor({ config, store, ui }) {
    this.config = config;
    this.store = store;
    this.ui = ui;
    this.identity = { me: null, ownerJid: resolveOwnerJid(config, {}), host: {} };
    this.reportEngine = new ReportEngine({ config, ui, store });
    this.enforcer = new Enforcer({
      config,
      store,
      ui,
      reportEngine: this.reportEngine,
      identity: this.identity
    });
    this.conn = null;
    this.phase = 'idle';
    this.running = false;
    this.intentionalStop = false;
    this.attempt = 0;
    this.lastQr = null;
    this.capability = null;
  }

  setPhase(phase, extra = {}) {
    this.phase = phase;
    Object.assign(this.identity.host, extra);
    this.ui?.renderStrip?.();
  }

  get hostState() {
    return {
      phase: this.phase,
      jid: this.identity.host.jid || '',
      startedAt: this.identity.host.startedAt
    };
  }

  async start() {
    this.running = true;
    this.intentionalStop = false;
    this.setPhase('connecting');
    await this.connect();
  }

  async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.config.auth);
    const logger = makeLogger(this.ui, this.config.logLevel);

    const version = this.config.baileysVersion ? this.config.baileysVersion.split('.').map(Number) : undefined;

    this.conn = makeWASocket({
      logger,
      auth: state,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      fireInitQueries: true,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: this.config.keepAliveMs,
      ...(version ? { version } : {}),
      browser: ['AntiBugBot', 'shield', this.config.userAgent || '1.0.0'],
      shouldIgnoreJid: (jid) => isBroadcastish(jid) && !this.config.debugJids
    });

    const socket = this.conn;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', (update) => {
      if (this.conn !== socket) return;
      this.onConnectionUpdate(update).catch((error) => {
        this.ui?.error?.('socket', `connection handler: ${error.message}`);
      });
    });
    socket.ev.on('messages.upsert', (payload) => {
      if (this.conn !== socket) return;
      this.onMessagesUpsert(payload).catch((error) => {
      this.store.increment('errors');
      this.ui?.error?.('shield', `handler crashed: ${error.message}`);
      });
    });

    this.ui?.[this.attempt > 1 ? 'debug' : 'info']?.('socket', `auth state loaded from ${this.config.auth}${state.creds?.noiseKeyBuffer ? ' (resuming session)' : ' (fresh session — no QR scanned yet)'}`);
    return this.conn;
  }

  async onConnectionUpdate(update) {
    const { connection, lastReceived, qr, pairingCode, isNewLogin, lastDisconnect } = update;

    if (qr) {
      this.lastQr = qr;
      this.setPhase('pairing');
      this.ui?.qr?.(qr, { rotateSec: 45, sub: `payload ${qr.slice(0, 12)}…` });
    }

    if (pairingCode) {
      this.ui?.pairingCode?.(pairingCode);
    }

    if (connection === 'connecting') {
      this.setPhase('connecting');
      this.ui?.debug?.('socket', 'connecting…');
    }

    if (connection === 'open') {
      this.attempt = 0;
      const me = this.conn.authState?.creds?.me || {};
      this.identity.me = me;
      this.identity.ownerJid = this.config.ownerNumber
        ? `${this.config.ownerNumber}@s.whatsapp.net`
        : resolveOwnerJid({ ownerNumber: '' }, this.identity);
      this.identity.host = {
        ...this.identity.host,
        jid: jidNormalizedUser(me.id || '') || phoneOf(me.id) + '@s.whatsapp.net',
        name: me.name || '',
        startedAt: this.identity.host.startedAt || Date.now(),
        lastReceived: lastReceived ? new Date(lastReceived).toISOString() : null
      };
      this.setPhase('armed');
      this.reportEngine.capability = null;
      this.capability = await this.ui.spin('probing report transport', async () => {
        const probed = await this.reportEngine.probe(this.conn);
        return probed;
      }).catch((error) => {
        this.ui?.warn?.('report', `capability probe failed: ${error.message}`);
        return this.reportEngine.describe();
      });

      const described = this.reportEngine.describe();
      this.ui?.keyPanel?.('SHIELD LIVE', [
        ['account', this.identity.host.jid],
        ['device', me.name ? `${me.name}` : 'linked device'],
        ['alerts go to', this.identity.ownerJid || 'this number (self chat)'],
        ['trigger', `${this.config.thresholdChars} characters (${this.config.countMode})`],
        ['enforcement', this.config.shieldMode === 'observe'
          ? 'OBSERVE — detect + alert only'
          : `block ✔ · delete ${this.config.deleteMode} ✔ · ${this.config.reportAttempts}× report`],
        ['report path', described.label + (described.note ? `  (${described.note})` : '')],
        ['budget', `${this.config.maxActionsPerMinute} actions/min · groups ${this.config.groupsMode}`],
        ['log file', this.ui.logFilePath || 'off']
      ]);

      this.store.state.sessions.push({
        startedAt: new Date().toISOString(),
        jid: this.identity.host.jid,
        mode: this.config.shieldMode,
        threshold: this.config.thresholdChars
      });
      if (this.store.state.sessions.length > 50) this.store.state.sessions.splice(0, this.store.state.sessions.length - 50);
      this.store.touch();

      if (this.config.notifyOn === 'everything' || this.config.welcomeMessage) {
        notifyArm({
          conn: this.conn,
          config: this.config,
          store: this.store,
          identity: this.identity,
          ui: this.ui,
          host: { jid: this.identity.host.jid, uptime: elapsed(Date.now() - this.identity.host.startedAt) },
          capability: described
        }).catch(() => {});
      }
      this.ui?.done?.(`shield armed — watching for messages over ${this.config.thresholdChars} characters`);
      if (isNewLogin) this.ui?.info?.('socket', 'new session linked');
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error;
      const statusCode =
        error?.output?.statusCode ?? error?.data?.status ?? error?.data?.statusCode ?? error?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      this.setPhase(loggedOut ? 'logged-out' : 'reconnecting');
      if (loggedOut) {
        this.running = false;
        this.ui?.fail?.('this session was logged out from the phone — delete the auth folder and pair again');
        return;
      }
      if (this.intentionalStop || !this.running) return;
      const retryIn = BACKOFF_STEPS[Math.min(this.attempt, BACKOFF_STEPS.length - 1)];
      this.attempt += 1;
      const reason = describeClose(statusCode, error);
      this.ui?.warn?.('socket', `${reason.title} — retry ${this.attempt} in ${elapsed(retryIn)}`);
      if (this.attempt === 3) {
        this.ui?.raw?.(box([
          ` ${style.dim(pad('last error', 14))}${style.yellow(reason.title)}`,
          ` ${style.dim(pad('detail', 14))}${style.gray(reason.detail || 'no detail from the socket')}`,
          ` ${style.dim(pad('endpoint', 14))}${style.gray('web.whatsapp.com:443 · g.whatsapp.net')}`,
          '',
          style.dim('  Keep trying? Retries continue automatically, backing off to 30s.'),
          style.dim('  Check: internet/VPN on this machine, system clock, and that WhatsApp'),
          style.dim('  is still logged in on the phone. Firewall or proxy blocks on port 443'),
          style.dim('  are the usual cause. Ctrl-C to stop.')
        ], { title: ' CANNOT REACH WHATSAPP ', color: style.brightYellow }));
      }
      await delay(retryIn);
      if (!this.running || this.intentionalStop) return;
      await this.connect();
    }

  }

  async onMessagesUpsert({ type, messages = [] }) {
    if (type === 'append' && !this.config.scanHistory) return;
    for (const message of messages) {
      await this.inspect(message);
    }
  }

  async inspect(message) {
    if (!message?.message) return null;
    const key = message.key || {};
    if (key.fromMe) {
      const handled = await this.maybeCommand(message);
      return handled ? { command: true } : null;
    }
    if (isBroadcastish(key.remoteJid)) return null;

    this.store.increment('messagesScanned');

    const { text, kind } = extractText(message.message);
    const extra = vcardLength(message.message) + extraPayloadLength(message.message, this.config);
    if (!text && !extra) return null;

    const decision = evaluateText(text, {
      threshold: this.config.thresholdChars,
      countMode: this.config.countMode,
      heuristics: this.config.heuristics,
      extraLength: extra
    });
    decision.text = text;
    decision.sourceKind = kind;

    if (!decision.triggered) {
      this.ui?.debug?.('shield', `clean ${decision.counted}c from ${key.remoteJid?.replace(/@.*/, '') || '?'} (${kind})`);
      return null;
    }

    const incident = buildIncident({
      message,
      decision,
      config: this.config,
      identity: this.identity,
      store: this.store
    });
    incident.senderLabel = incident.sender?.display || incident.sender?.phone;
    incident.groupId = isJidGroup(key.remoteJid) ? key.remoteJid : null;
    incident.isGroup = Boolean(incident.groupId);
    incident.timeLabel = new Date(incident.timestamp * 1000).toLocaleString();

    this.ui?.threat?.(incident);

    try {
      await this.enforcer.process({ conn: this.conn, message, decision, incident });
    } catch (error) {
      this.store.increment('errors');
      this.ui?.error?.('enforce', `pipeline error: ${error.message}`);
      this.ui?.debug?.('enforce', error.stack || '');
    }
    return incident;
  }

  async maybeCommand(message) {
    const text = String(message.message?.conversation || message.message?.extendedTextMessage?.text || '').trim();
    if (!text.startsWith('!')) return false;
    const body = text.slice(1).trim().toLowerCase();
    const sender = message.key?.remoteJid || '';
    const ownerDigits = phoneOf(this.identity.host.jid);
    const senderDigits = phoneOf(sender);
    const fromSelf = ownerDigits && senderDigits === ownerDigits;
    if (!fromSelf && !this.config.whitelist.includes(senderDigits)) return false;

    if (body.startsWith('status') || body === 'stats' || body === 'shield status') {
      const reply = renderStatsReply(this.store.snapshot(), this.config, this.reportEngine.describe());
      await this.conn.sendMessage(sender, { text: reply, linkPreview: null }).catch(() => {});
      return true;
    }
    if (body.startsWith('threshold')) {
      const next = Number(body.split(/\s+/)[1]);
      if (Number.isFinite(next) && next >= 40) {
        this.config.thresholdChars = Math.trunc(next);
        this.ui?.notice?.('shield', `trigger moved to ${next} characters`);
        await this.conn.sendMessage(sender, { text: `🛡 trigger is now ${next} characters (this session).`, linkPreview: null }).catch(() => {});
      } else {
        await this.conn.sendMessage(sender, { text: `usage: !threshold 2000`, linkPreview: null }).catch(() => {});
      }
      return true;
    }
    if (body.startsWith('unblock')) {
      const digits = body.replace(/\D/g, '');
      if (digits) {
        const jid = `${digits}@s.whatsapp.net`;
        await this.conn.updateBlockStatus(jid, 'unblock').catch(() => {});
        this.store.removeBlock(jid);
        this.reportEngine.capability = null;
        await this.conn.sendMessage(sender, { text: `🛡 unblocked +${digits}`, linkPreview: null }).catch(() => {});
      }
      return true;
    }
    if (body.startsWith('whitelist')) {
      const digits = body.replace(/\D/g, '');
      if (digits) {
        this.store.addWhitelist(`${digits}@s.whatsapp.net`, 'via whatsapp command');
        await this.conn.sendMessage(sender, { text: `🛡 +${digits} whitelisted (never blocked)`, linkPreview: null }).catch(() => {});
      }
      return true;
    }
    if (body === 'test') {
      await this.conn.sendMessage(sender, { text: '🛡 AntiBugBot online — send a long message to yourself from another number to see a full incident.', linkPreview: null }).catch(() => {});
      return true;
    }
    await this.conn.sendMessage(sender, {
      text: [
        '🛡 AntiBugBot commands',
        '!status — counters',
        '!threshold 2000 — change trigger',
        '!whitelist <number> — never block',
        '!unblock <number> — lift a block',
        '!test — connectivity check'
      ].join('\n'),
      linkPreview: null
    }).catch(() => {});
    return true;
  }

  async stop({ flush = true } = {}) {
    this.intentionalStop = true;
    this.running = false;
    this.setPhase('stopping');
    try {
      await this.enforcer.drain();
    } catch {
      /* shutdown must not hang */
    }
    if (flush) {
      try {
        await this.store.flush();
      } catch {
        /* ignore */
      }
    }
    try {
      this.conn?.end?.(undefined);
    } catch {
      /* ignore */
    }
    this.setPhase('stopped');
  }

  async logout() {
    try {
      await this.conn?.logout?.();
      return { status: 'ok' };
    } catch (error) {
      return { status: 'fail', detail: error.message };
    }
  }
}

export default AntiBugBot;
