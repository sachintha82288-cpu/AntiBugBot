/**
 * Config = built-in defaults  <  ./antibugbot.config.json  <  env vars (ABB_*).
 * Env overrides exist so a Pterodactyl Egg can tune the bot without re-deploying
 * files into the server container.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  scanWindow: 8000,
  maxLen: 6000,
  maxMediaBytes: 8 * 1024 * 1024,
  flood: {
    windowMs: 60_000,
    msgsPerMin: 8,
    chatMsgsPerMin: 25,
    burstCapacity: 6,
    burstRefillPerSec: 0.4,
  },
  strikes: {
    ttlMs: 60 * 60 * 1000,
    muteAfter: 4,
    blockAfter: 8,
  },
  quarantine: {
    enabled: true,
    dir: './data/quarantine',
    redact: true,
  },
  audit: {
    dir: './data/audit',
    rotateMb: 8,
  },
  notices: {
    lang: 'si',
    sendToSender: true,
    oncePerSenderMinutes: 30,
  },
  trust: {
    ownerNumbers: [],
    adminNumbers: [],
    allowlistedChats: [],
    allowContactsOnly: true,
  },
  group: {
    restrictUnknownMembers: true,
    cooldownSeconds: 600,
  },
};

export function loadConfig(root = process.cwd(), env = process.env) {
  let fileCfg = {};
  const cfgPath = path.join(root, 'antibugbot.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      throw new Error(`antibugbot.config.json is not valid JSON: ${err.message}`);
    }
  }

  const cfg = deepMerge(structuredClone(DEFAULTS), fileCfg);

  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith('ABB_')) continue;
    const segs = key.slice(4).toLowerCase().split('__');
    const value = coerce(raw);
    setPath(cfg, segs, value);
  }

  validate(cfg);
  return cfg;
}

function coerce(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
  }
  if (raw.includes(',')) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return raw;
}

function setPath(obj, segs, value) {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    cur[segs[i]] ??= {};
    cur = cur[segs[i]];
  }
  cur[segs.at(-1)] = value;
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object') {
      base[k] = deepMerge(base[k] ?? {}, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

function validate(cfg) {
  const errs = [];
  if (cfg.scanWindow < 512 || cfg.scanWindow > 200_000) errs.push('scanWindow must be 512..200000');
  if (cfg.flood.msgsPerMin < 1) errs.push('flood.msgsPerMin must be >= 1');
  if (cfg.strikes.blockAfter <= cfg.strikes.muteAfter) errs.push('strikes.blockAfter must exceed muteAfter');
  if (!Array.isArray(cfg.trust.ownerNumbers)) errs.push('trust.ownerNumbers must be an array');
  if (errs.length) throw new Error(`invalid config: ${errs.join('; ')}`);
  return cfg;
}

export { DEFAULTS };
