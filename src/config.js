import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const GROUP_MODES = ['enforce', 'observe', 'ignore'];
export const SHIELD_MODES = ['enforce', 'observe'];
export const COUNT_MODES = ['max', 'grapheme', 'utf16'];
export const DELETE_MODES = ['for-me', 'revoke-if-able', 'off'];
export const REPORT_CHANNELS = ['auto', 'native', 'bridge', 'evidence', 'off'];

const DEFAULTS = {
  thresholdChars: 2000,
  countMode: 'max',
  heuristics: true,
  countPayload: false,
  block: true,
  deleteMode: 'for-me',
  reportAttempts: 30,
  reportChannel: 'auto',
  reportMinIntervalMs: 700,
  reportJitterMs: 350,
  reportTimeoutMs: 15000,
  reportProbeIq: true,
  bridgeUrl: '',
  bridgeToken: '',
  groupsMode: 'observe',
  shieldMode: 'enforce',
  maxActionsPerMinute: 6,
  keepAliveMs: 30000,
  reconnectMaxDelayMs: 30000,
  logLevel: 'info',
  logFile: true,
  beepOnThreat: true,
  statsPanel: true,
  welcomeMessage: true,
  notifyOn: 'threats',
  authDir: 'auth',
  dataDir: 'data',
  ownerNumber: '',
  whitelist: [],
  countryCode: 'LK',
  sessionName: 'antibugbot',
  baileysVersion: '',
  debugJids: false,
  scanHistory: false,
  userAgent: 'AntiBugBot/1.0'
};

const ENV_MAP = {
  THRESHOLD_CHARS: ['thresholdChars', 'int', { min: 40 }],
  COUNT_MODE: ['countMode', 'enum', { values: COUNT_MODES }],
  HEURISTICS: ['heuristics', 'bool'],
  COUNT_PAYLOAD: ['countPayload', 'bool'],
  BLOCK_ENABLED: ['block', 'bool'],
  DELETE_MODE: ['deleteMode', 'enum', { values: DELETE_MODES }],
  REPORT_ATTEMPTS: ['reportAttempts', 'int', { min: 0, max: 200 }],
  REPORT_CHANNEL: ['reportChannel', 'enum', { values: REPORT_CHANNELS }],
  REPORT_MIN_INTERVAL_MS: ['reportMinIntervalMs', 'int', { min: 0 }],
  REPORT_JITTER_MS: ['reportJitterMs', 'int', { min: 0 }],
  REPORT_TIMEOUT_MS: ['reportTimeoutMs', 'int', { min: 1000 }],
  REPORT_PROBE_IQ: ['reportProbeIq', 'bool'],
  WA_BRIDGE_URL: ['bridgeUrl', 'string'],
  WA_BRIDGE_TOKEN: ['bridgeToken', 'string'],
  GROUPS_MODE: ['groupsMode', 'enum', { values: GROUP_MODES }],
  SHIELD_MODE: ['shieldMode', 'enum', { values: SHIELD_MODES }],
  MAX_ACTIONS_PER_MINUTE: ['maxActionsPerMinute', 'int', { min: 1 }],
  KEEP_ALIVE_MS: ['keepAliveMs', 'int', { min: 5000 }],
  RECONNECT_MAX_DELAY_MS: ['reconnectMaxDelayMs', 'int', { min: 1000 }],
  LOG_LEVEL: ['logLevel', 'enum', { values: ['silent', 'error', 'warn', 'info', 'debug'] }],
  LOG_FILE: ['logFile', 'bool'],
  BEEP_ON_THREAT: ['beepOnThreat', 'bool'],
  STATS_PANEL: ['statsPanel', 'bool'],
  WELCOME_MESSAGE: ['welcomeMessage', 'bool'],
  NOTIFY_ON: ['notifyOn', 'enum', { values: ['threats', 'everything'] }],
  AUTH_DIR: ['authDir', 'path'],
  DATA_DIR: ['dataDir', 'path'],
  OWNER_NUMBER: ['ownerNumber', 'phone'],
  WHITELIST: ['whitelist', 'list'],
  COUNTRY_CODE: ['countryCode', 'string'],
  BAILEYS_VERSION: ['baileysVersion', 'string'],
  SCAN_HISTORY: ['scanHistory', 'bool'],
};

const parseEnvFile = (filePath) => {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (!(key in process.env)) out[key] = value;
  }
  return out;
};

const truthy = new Set(['1', 'true', 'yes', 'on', 'y']);
const falsy = new Set(['0', 'false', 'no', 'off', 'n']);

export const toBool = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toLowerCase();
  if (s === '') return null;
  if (truthy.has(s)) return true;
  if (falsy.has(s)) return false;
  return null;
};

const digits = (value) => String(value ?? '').replace(/[^\d]/g, '');

export const normalizePhone = (value, fallbackCountry = '94') => {
  const cleaned = String(value ?? '').trim();
  if (!cleaned) return '';
  const number = cleaned.replace(/\D/g, '');
  if (!number) return '';
  if (cleaned.startsWith('+')) return number;
  if (number.startsWith('00')) return number.slice(2);
  if (number.startsWith('0') && fallbackCountry) return fallbackCountry + number.slice(1);
  return number;
};

const countryDial = {
  LK: '94', IN: '91', PK: '92', BD: '880', GB: '44', US: '1', CA: '1', AE: '971',
  SA: '966', QA: '974, '.replace(',', ''), MY: '60', SG: '65', AU: '61', DE: '49',
  FR: '33', NL: '31', IT: '39', ES: '34', TR: '90', ID: '62', TH: '66', PH: '63',
  ZA: '27', NG: '234', KE: '254', BR: '55', AR: '54', JP: '81', KR: '82', CN: '86',
  RU: '7', UA: '380', PL: '48', SE: '46', NO: '47', DK: '45', FI: '358', CH: '41',
  AT: '43', BE: '32', PT: '351', IE: '353', NZ: '64', OM: '968', BH: '973', KW: '965'
};

const coerce = (label, spec, rawValue, errors, dial = '94') => {
  const [, type, opts = {}] = spec;
  const key = label;
  const value = rawValue;
  if (value === undefined || value === null || value === '') return undefined;
  switch (type) {
    case 'int': {
      const num = Number(String(value).replace(/[_,\s]/g, ''));
      if (!Number.isFinite(num)) {
        errors.push({ key, message: 'must be a whole number', got: String(value) });
        return undefined;
      }
      const int = Math.trunc(num);
      if ('min' in opts && int < opts.min) {
        errors.push({ key, message: `must be >= ${opts.min}`, got: String(value) });
        return undefined;
      }
      if ('max' in opts && int > opts.max) {
        errors.push({ key, message: `must be <= ${opts.max}`, got: String(value) });
        return undefined;
      }
      return int;
    }
    case 'bool': {
      const bool = toBool(value);
      if (bool === null) {
        errors.push({ key, message: 'expected true/false', got: String(value) });
        return undefined;
      }
      return bool;
    }
    case 'enum': {
      const s = String(value).trim().toLowerCase();
      if (!opts.values.includes(s)) {
        errors.push({ key, message: `expected one of: ${opts.values.join(', ')}`, got: s });
        return undefined;
      }
      return s;
    }
    case 'phone': {
      const phone = normalizePhone(value, dial);
      if (phone.length < 7) {
        errors.push({
          key,
          message: 'not a usable phone number — use international format, e.g. +94771234567',
          got: String(value)
        });
        return undefined;
      }
      return phone;
    }
    case 'list':
      return String(value)
        .split(/[,;]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => normalizePhone(entry, dial))
        .filter(Boolean);
    case 'path':
      return String(value).trim();
    default:
      return String(value);
  }
};

const CLI_SPEC = {
  threshold: ['thresholdChars', 'int', { min: 40 }],
  'max-chars': ['thresholdChars', 'int', { min: 40 }],
  'count-mode': ['countMode', 'enum', { values: COUNT_MODES }],
  heuristics: ['heuristics', 'bool'],
  'delete-mode': ['deleteMode', 'enum', { values: DELETE_MODES }],
  'report-attempts': ['reportAttempts', 'int', { min: 0, max: 200 }],
  'report-channel': ['reportChannel', 'enum', { values: REPORT_CHANNELS }],
  'bridge-url': ['bridgeUrl', 'string'],
  groups: ['groupsMode', 'enum', { values: GROUP_MODES }],
  mode: ['shieldMode', 'enum', { values: SHIELD_MODES }],
  'log-level': ['logLevel', 'enum', { values: ['silent', 'error', 'warn', 'info', 'debug'] }],
  'auth-dir': ['authDir', 'path'],
  'data-dir': ['dataDir', 'path'],
  owner: ['ownerNumber', 'phone'],
  whitelist: ['whitelist', 'list'],
  'country-code': ['countryCode', 'string']
};

export const parseArgs = (argv = []) => {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const body = token.replace(/^--?/, '');
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { flags, command: positional[0] || 'start', positional };
};

export const loadConfig = ({ argv = [], env = process.env, cwd = process.cwd() } = {}) => {
  const fileEnv = parseEnvFile(path.join(cwd, '.env'));
  const preFlags = parseArgs(argv);
  const preDial = countryDial[String(preFlags.flags['country-code'] || '').toUpperCase()] ||
    countryDial[String(env.COUNTRY_CODE || '').toUpperCase()] ||
    '94';
  const source = { ...fileEnv, ...Object.fromEntries(
    Object.keys(ENV_MAP).flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]]))
  ) };
  const { flags, command, positional } = parseArgs(argv);
  const errors = [];
  const config = { ...DEFAULTS };
  const applied = { env: {}, cli: {}, default: {} };

  for (const key of Object.keys(DEFAULTS)) applied.default[key] = true;

  for (const [envKey, spec] of Object.entries(ENV_MAP)) {
    const value = coerce(`env ${envKey}`, spec, source[envKey], errors, preDial);
    if (value !== undefined) {
      config[spec[0]] = value;
      applied.env[spec[0]] = envKey;
      delete applied.default[spec[0]];
    }
  }

  for (const [flag, spec] of Object.entries(CLI_SPEC)) {
    if (!(flag in flags)) continue;
    const value = coerce(`--${flag}`, spec, flags[flag], errors, preDial);
    if (value !== undefined) {
      config[spec[0]] = value;
      applied.cli[spec[0]] = `--${flag}`;
      delete applied.default[spec[0]];
    }
  }

  const cliBooleans = {
    'dry-run': ['shieldMode', 'observe'],
    observe: ['shieldMode', 'observe'],
    enforce: ['shieldMode', 'enforce'],
    'no-block': ['block', false],
    'no-heuristics': ['heuristics', false],
    'no-report': ['reportAttempts', 0],
    'no-beep': ['beepOnThreat', false],
    'no-stats': ['statsPanel', false],
    'no-log-file': ['logFile', false],
    verbose: ['logLevel', 'debug'],
    quiet: ['logLevel', 'warn'],
    silent: ['logLevel', 'silent']
  };
  for (const [flag, [key, value]] of Object.entries(cliBooleans)) {
    if (flag in flags) {
      config[key] = value;
      applied.cli[key] = `--${flag}`;
      delete applied.default[key];
    }
  }

  let colorFlag = null;
  if ('no-color' in flags && flags['no-color'] !== false) colorFlag = false;
  else if ('color' in flags) colorFlag = toBool(flags.color);
  if (env.NO_COLOR !== undefined && colorFlag === null) colorFlag = false;
  config.color = colorFlag === null ? 'auto' : colorFlag ? 'on' : 'off';

  const dial = countryDial[String(config.countryCode).toUpperCase()] || '94';
  config.ownerNumber = config.ownerNumber ? normalizePhone(config.ownerNumber, dial) : '';
  config.whitelist = (config.whitelist || []).map((n) => normalizePhone(n, dial)).filter(Boolean);

  config.auth = path.isAbsolute(config.authDir)
    ? config.authDir
    : path.resolve(cwd, config.authDir);
  config.data = path.isAbsolute(config.dataDir)
    ? config.dataDir
    : path.resolve(cwd, config.dataDir);
  config.appliedFrom = { ...applied, command, positional };
  config.errors = errors;

  if (config.reportAttempts > 0 && config.reportChannel !== 'off') {
    const expectMs = (config.reportMinIntervalMs + config.reportJitterMs / 2) * config.reportAttempts;
    config.reportDurationHintMs = expectMs;
  } else {
    config.reportDurationHintMs = 0;
  }

  return { config, flags, command, positional, errors };
};

export const describeConfig = (config) => [
  ['Trigger threshold', `${config.thresholdChars} characters`],
  ['Count mode', config.countMode],
  ['Heuristic rules', config.heuristics ? 'on (unicode/zwj/bidi traps)' : 'off (length only)'],
  ['Block sender', config.block ? 'yes' : 'no'],
  ['Delete mode', config.deleteMode],
  ['Report attempts', `${config.reportAttempts}x per incident`],
  ['Report channel', config.reportChannel],
  ['Groups', config.groupsMode],
  ['Shield mode', config.shieldMode === 'observe' ? 'observe (no enforcement)' : 'enforce'],
  ['Action budget', `${config.maxActionsPerMinute}/min`],
  ['Owner alerts', config.ownerNumber ? `+${config.ownerNumber}` : 'self chat (this number)'],
  ['Whitelist', config.whitelist.length ? `${config.whitelist.length} number(s)` : 'none'],
  ['Auth state', config.auth],
  ['Data state', config.data]
];

export default loadConfig;
