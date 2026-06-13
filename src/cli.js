#!/usr/bin/env node
import fs from 'node:fs';
import { nip19 } from 'nostr-tools';
import {
  loadConfig,
  readRawConfig,
  writeRawConfig,
  configFilePath,
  parseDuration,
  normalizeUrl,
} from './config.js';
import { initDb, getSendRelays, getRelayStats, getLastOutcomes, getMeta } from './db.js';
import { nextWipeMs } from './scheduler.js';
import {
  addManualRelay,
  removeManualRelay,
  reconcileManualRelays,
} from './relays-store.js';

const [, , group, ...rest] = process.argv;

function die(msg) {
  console.error(msg);
  process.exit(1);
}
const ok = (m) => console.log(`\u2713 ${m}`);
const restartNote = () => console.log('  (restart the relay for changes to take effect)');

function withDb(fn) {
  const cfg = loadConfig();
  initDb(cfg);
  return fn(cfg);
}

// Read the package version. Guarded so a missing/garbled package.json only
// affects the version display, not every other command.
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}
const VERSION = readVersion();

// ===========================================================================
//  Config schema — single source of truth for editable config.json settings.
//  (Manual blast relays are NOT here; they live in the DB + relays.yml.)
// ===========================================================================

function vPubkey(s) {
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (s.startsWith('npub')) {
    try { if (nip19.decode(s).type === 'npub') return s; } catch {}
  }
  throw new Error('must be an npub (npub1…) or a 64-character hex pubkey');
}
function vSeckey(s) {
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (s.startsWith('nsec')) {
    try { if (nip19.decode(s).type === 'nsec') return s; } catch {}
  }
  throw new Error('must be an nsec (nsec1…) or a 64-character hex secret key');
}
function vUrl(s) {
  const n = normalizeUrl(s);
  if (!/^wss?:\/\/.+/.test(n)) throw new Error(`"${s}" is not a relay URL — must start with wss:// or ws://`);
  return n;
}

const SCHEMA = {
  host:        { type: 'string', desc: 'Bind address (default 0.0.0.0)' },
  port:        { type: 'int', min: 1, max: 65535, desc: 'Listen port' },
  relayUrl:    { type: 'string', validate: vUrl, desc: 'Public wss:// URL of this relay' },
  name:        { type: 'string', desc: 'Relay name shown to clients (NIP-11)' },
  description: { type: 'string', desc: 'Relay description shown to clients (NIP-11)' },
  adminNpub:   { type: 'string', validate: vPubkey, desc: 'Admin npub or hex pubkey' },
  relaySecretKey: { type: 'string', validate: vSeckey, desc: 'Relay nsec or hex secret key' },
  harvest10050From: { type: 'enum', values: ['all', 'admin'], desc: 'Harvest relays from all WoT writers, or admin only' },
  dmRelaySweepDepth: { type: 'int', min: 1, max: 2, desc: '10050 DM-relay sweep depth (1 = direct follows, 2 = + follows-of-follows)' },
  wotDepth:    { type: 'int', min: 1, max: 2, desc: 'Web of trust depth (1 or 2)' },
  wotRefreshHours: { type: 'number', min: 0.1, desc: 'How often to rebuild the WoT (hours)' },
  maxWotSize:  { type: 'int', min: 1, desc: 'Cap on WoT size' },
  wotFetchConcurrency: { type: 'int', min: 1, desc: 'Concurrent WoT fetches' },
  outboundConnectConcurrency: { type: 'int', min: 1, desc: 'Max simultaneous outbound relay connections' },
  outboundConnectIntervalMs: { type: 'int', min: 0, desc: 'Minimum delay between outbound relay connection starts globally (ms)' },
  outboundConnectPerRelayIntervalMs: { type: 'int', min: 0, desc: 'Minimum delay between outbound connection starts to the same relay (ms)' },
  livenessIntervalHours: { type: 'number', min: 0.1, desc: 'Liveness probe interval (hours)' },
  logRetention: { type: 'duration', desc: 'Log lifetime before purge+wipe, e.g. 7d / 12h / 1w' },
  blastTimeoutMs: { type: 'int', min: 100, desc: 'Blast attempt timeout (ms)' },
  probeTimeoutMs: { type: 'int', min: 100, desc: 'Liveness probe timeout (ms)' },
  privateReads: { type: 'bool', desc: 'Require auth to read; only see your own DMs' },
  relaysFile:  { type: 'string', desc: 'Path to the manual-relays YAML file' },
  dataDir:     { type: 'string', desc: 'Data directory for the database' },
  discoveryRelays: { type: 'urlarray', desc: 'Relays queried to build WoT (use: config add discovery <url>)' },
};

const RELAY_ALIASES = new Set(['relay', 'relays', 'send-relay', 'send-relays']);
const DISCOVERY_ALIASES = new Set(['discovery', 'discovery-relay', 'discovery-relays']);

const TRUE = new Set(['true', 'yes', 'on', '1']);
const FALSE = new Set(['false', 'no', 'off', '0']);

function checkRange(n, schema) {
  if (typeof schema.min === 'number' && n < schema.min) throw new Error(`must be ≥ ${schema.min}`);
  if (typeof schema.max === 'number' && n > schema.max) throw new Error(`must be ≤ ${schema.max}`);
  return n;
}

function coerce(schema, rawValue) {
  switch (schema.type) {
    case 'string': return schema.validate ? schema.validate(rawValue) : rawValue;
    case 'enum':
      if (!schema.values.includes(rawValue)) throw new Error(`must be one of: ${schema.values.join(', ')}`);
      return rawValue;
    case 'duration': parseDuration(rawValue); return rawValue;
    case 'bool': {
      const l = rawValue.toLowerCase();
      if (TRUE.has(l)) return true;
      if (FALSE.has(l)) return false;
      throw new Error('must be true or false');
    }
    case 'int': {
      const n = Number(rawValue);
      if (!Number.isInteger(n)) throw new Error('must be a whole number');
      return checkRange(n, schema);
    }
    case 'number': {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) throw new Error('must be a number');
      return checkRange(n, schema);
    }
    case 'urlarray': {
      const urls = rawValue.split(',').map((s) => s.trim()).filter(Boolean).map(vUrl);
      return [...new Set(urls)];
    }
    default: throw new Error(`internal: unknown type ${schema.type}`);
  }
}

const keyList = () => Object.keys(SCHEMA).join(', ');

// ---- config: scalar/array settings in config.json ----

function configSet(key, args) {
  if (!key) die('usage: blastr config set <key> <value>');
  const schema = SCHEMA[key];
  if (!schema) die(`✗ unknown setting "${key}".\n  Valid settings: ${keyList()}\n  See: blastr config keys`);
  const rawValue = args.join(' ');
  if (rawValue === '') die(`usage: blastr config set ${key} <value>`);
  let value;
  try { value = coerce(schema, rawValue); } catch (e) { die(`✗ invalid value for ${key}: ${e.message}`); }
  const raw = readRawConfig();
  raw[key] = value;
  writeRawConfig(raw);
  ok(`${key} = ${JSON.stringify(value)}`);
  restartNote();
}

function discoveryArrayEdit(op, value) {
  if (!value) die(`usage: blastr config ${op} discovery <url>`);
  let url;
  try { url = vUrl(value); } catch (e) { die(`✗ ${e.message}`); }
  const raw = readRawConfig();
  const arr = Array.isArray(raw.discoveryRelays) ? raw.discoveryRelays.map(normalizeUrl) : [];
  if (op === 'add') {
    if (arr.includes(url)) return console.log(`• already present in discoveryRelays: ${url}`);
    arr.push(url);
  } else {
    if (!arr.includes(url)) return console.log(`• not found in discoveryRelays: ${url}`);
    arr.splice(arr.indexOf(url), 1);
  }
  raw.discoveryRelays = arr;
  writeRawConfig(raw);
  ok(`discoveryRelays now has ${arr.length} entr${arr.length === 1 ? 'y' : 'ies'}`);
  restartNote();
}

function configAdd(what, value) {
  if (!what) die('usage: blastr config add <relay|discovery> <url>');
  if (RELAY_ALIASES.has(what)) return relaysAdd(value);
  if (DISCOVERY_ALIASES.has(what)) return discoveryArrayEdit('add', value);
  die(`✗ can't add "${what}". Use: config add relay <url>  |  config add discovery <url>`);
}
function configRemove(what, value) {
  if (!what) die('usage: blastr config remove <relay|discovery> <url>');
  if (RELAY_ALIASES.has(what)) return relaysRemove(value);
  if (DISCOVERY_ALIASES.has(what)) return discoveryArrayEdit('remove', value);
  die(`✗ can't remove "${what}". Use: config remove relay <url>  |  config remove discovery <url>`);
}

function configGet(key) {
  if (!key) die('usage: blastr config get <key>');
  const raw = readRawConfig();
  if (!(key in raw)) die(`✗ "${key}" is not set. Valid settings: ${keyList()}`);
  const v = raw[key];
  if (Array.isArray(v)) v.forEach((x) => console.log(x));
  else console.log(typeof v === 'string' ? v : JSON.stringify(v));
}
function configList() {
  const raw = readRawConfig();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('//')) continue;
    const shown = k === 'relaySecretKey' && v ? '***hidden***' : JSON.stringify(v);
    console.log(`${k.padEnd(22)} ${shown}`);
  }
  console.log(`\n(file: ${configFilePath()})`);
}
function configKeys() {
  console.log('Editable config.json settings:\n');
  for (const [k, s] of Object.entries(SCHEMA)) {
    const t = s.type === 'urlarray' ? 'list of urls' : s.type === 'enum' ? `[${s.values.join('|')}]` : s.type;
    console.log(`  ${k.padEnd(22)} ${t.padEnd(14)} ${s.desc}`);
  }
  console.log('\nManual blast relays are managed separately:');
  console.log('  blastr relays add <url> | remove <url> | sync | list');
}
function configValidate() {
  try {
    const cfg = loadConfig();
    ok('config is valid');
    console.log(`  name            : ${cfg.name}`);
    console.log(`  admin           : ${npubHex(cfg.adminNpub, cfg.adminHex)}`);
    console.log(`  downstream key  : ${cfg.secretKey ? 'set' : 'NOT set'}`);
    console.log(`  blastr npub     : ${npubHex(cfg.relayNpub, cfg.relayPubkeyHex)}`);
    console.log(`  outbound limit  : ${cfg.outboundConnectConcurrency} concurrent, ${cfg.outboundConnectIntervalMs}ms global gap, ${cfg.outboundConnectPerRelayIntervalMs}ms per relay`);
    console.log(`  discovery relays: ${cfg.discoveryRelays.length}`);
    console.log(`  relays file     : ${cfg.relaysFile}`);
    console.log(`  log retention   : ${cfg.logRetentionLabel}`);
  } catch (e) {
    die(`✗ config is INVALID: ${e.message}`);
  }
}
function configSetRaw(key, json) {
  if (!key || json === undefined) die('usage: blastr config set-raw <key> <json>');
  let value;
  try { value = JSON.parse(json); } catch (e) { die(`✗ not valid JSON: ${e.message}`); }
  const raw = readRawConfig();
  raw[key] = value;
  writeRawConfig(raw);
  ok(`${key} = ${JSON.stringify(value)} (raw)`);
  restartNote();
}

// ---- relays: manual blast relays in the DB + relays.yml (live, no restart) ----

function relaysAdd(value) {
  if (!value) die('usage: blastr relays add <url>');
  withDb((cfg) => {
    let r;
    try { r = addManualRelay(cfg, value); } catch (e) { die(`✗ ${e.message}`); }
    if (!r.addedToYaml && !r.changed) return console.log(`• already a manual relay: ${r.url}`);
    ok(`added manual relay: ${r.url}`);
    console.log('  (DB + relays.yml updated; a running relay starts using it automatically)');
  });
}
function relaysRemove(value) {
  if (!value) die('usage: blastr relays remove <url>');
  withDb((cfg) => {
    const r = removeManualRelay(cfg, value);
    if (!r.inYaml && !r.wasManual) {
      if (r.isHarvested)
        return console.log(`• ${r.url} is an auto-learned (10050) relay, not manually managed; it may return automatically.`);
      return console.log(`• not found in the manual relay list: ${r.url}`);
    }
    ok(`removed manual relay: ${r.url}`);
    console.log('  (DB + relays.yml updated; a running relay stops using it automatically)');
  });
}
function relaysSync() {
  withDb((cfg) => {
    const r = reconcileManualRelays(cfg);
    ok(`synced from ${cfg.relaysFile}: +${r.added} -${r.removed} (= ${r.total} manual relays)`);
    console.log('  (a running relay applies this immediately — no restart needed)');
  });
}

// ---- relay / log views ----

const fmtRate = (r) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`);
const fmtTime = (s) => (s ? new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '—');
function humanizeMs(ms) {
  if (ms <= 0) return 'now (overdue)';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const p = [];
  if (d) p.push(`${d}d`);
  if (h) p.push(`${h}h`);
  if (m || (!d && !h)) p.push(`${m}m`);
  return p.join(' ');
}
const sourceLabel = (src) => (src === 'manual' ? 'manual (permanent)' : 'learned (10050)');
const npubHex = (npub, hex) => (npub && hex ? `${npub} (${hex})` : 'NOT set');

function relaysList() {
  withDb(() => {
    const relays = getSendRelays().sort((a, b) => a.source.localeCompare(b.source));
    if (!relays.length) return console.log('No relays known yet. Add one: blastr relays add <url>');
    console.table(relays.map((r) => ({ relay: r.url, source: sourceLabel(r.source) })));
  });
}
function relaysRecent(n) {
  withDb(() => {
    const limit = Number(n) || 10;
    const last = getLastOutcomes().sort((a, b) => b.lastTs - a.lastTs).slice(0, limit);
    if (!last.length) return console.log('No usage logged yet.');
    console.table(last.map((r) => ({
      relay: r.url, 'last used': fmtTime(r.lastTs),
      'last result': r.lastOk ? 'success' : `fail (${r.lastReason || '?'})`,
    })));
  });
}
function relaysRanked(order, n) {
  withDb(() => {
    const limit = Number(n) || 10;
    const stats = getRelayStats().filter((s) => s.attempts > 0);
    if (!stats.length) return console.log('No usage logged yet — nothing to rank.');
    stats.sort((a, b) =>
      order === 'best' ? b.rate - a.rate || b.attempts - a.attempts
                       : a.rate - b.rate || b.attempts - a.attempts);
    console.table(stats.slice(0, limit).map((s) => ({
      relay: s.url, 'success rate': fmtRate(s.rate),
      successes: s.successes, failures: s.failures, attempts: s.attempts,
    })));
  });
}
function relaysRate() {
  withDb(() => {
    const known = getSendRelays();
    const stats = new Map(getRelayStats().map((s) => [s.url, s]));
    const rows = known.map(({ url, source }) => {
      const s = stats.get(url);
      return {
        relay: url, source: source === 'manual' ? 'manual' : '10050',
        'success rate': s ? fmtRate(s.rate) : 'no data',
        successes: s ? s.successes : 0, failures: s ? s.failures : 0,
        attempts: s ? s.attempts : 0, 'last used': s ? fmtTime(s.lastTs) : '—',
      };
    });
    for (const s of stats.values()) {
      if (!known.find((k) => k.url === s.url)) {
        rows.push({
          relay: s.url, source: '(purged?)', 'success rate': fmtRate(s.rate),
          successes: s.successes, failures: s.failures, attempts: s.attempts,
          'last used': fmtTime(s.lastTs),
        });
      }
    }
    if (!rows.length) return console.log('No relays known yet.');
    console.table(rows);
  });
}
function showStatus() {
  withDb((cfg) => {
    const lastWipe = Number(getMeta('last_wipe_at') || 0);
    const started = lastWipe > 0;
    const next = nextWipeMs(cfg);
    const relays = getSendRelays();
    const manual = relays.filter((r) => r.source === 'manual').length;
    console.log('xannyblastr status');
    console.log('-------------------');
    console.log(`version           : ${VERSION}`);
    console.log(`relay name        : ${cfg.name}`);
    console.log(`admin             : ${npubHex(cfg.adminNpub, cfg.adminHex)}`);
    console.log(`blastr npub       : ${npubHex(cfg.relayNpub, cfg.relayPubkeyHex)}`);
    console.log(`outbound limit    : ${cfg.outboundConnectConcurrency} concurrent, ${cfg.outboundConnectIntervalMs}ms global gap, ${cfg.outboundConnectPerRelayIntervalMs}ms per relay`);
    console.log(`send relays       : ${relays.length} (${manual} manual, ${relays.length - manual} learned)`);
    console.log(`relays file       : ${cfg.relaysFile}`);
    console.log(`log retention     : ${cfg.logRetentionLabel}`);
    console.log(`last log wipe     : ${started ? fmtTime(lastWipe) : 'never (not started yet)'}`);
    console.log(`next log wipe     : ${started ? fmtTime(Math.floor(next / 1000)) : 'not scheduled (relay not started yet)'}`);
    console.log(`time until wipe   : ${started ? humanizeMs(next - Date.now()) : '—'}`);
  });
}
function showNextWipe() {
  withDb((cfg) => {
    const next = nextWipeMs(cfg);
    console.log(`Next log wipe in ${humanizeMs(next - Date.now())} (at ${fmtTime(Math.floor(next / 1000))}).`);
  });
}

function help() {
  console.log(`blastr — admin CLI

Manual blast relays (stored in the DB + relays.yml; changes apply live, no restart):
  blastr relays add <url>                  add a relay (updates DB and relays.yml)
  blastr relays remove <url>               remove a relay (updates DB and relays.yml)
  blastr relays sync                       apply bulk edits made to relays.yml
  blastr relays list                       all known relays (manual + learned)
  blastr relays recent [n]                 most recently used + last result
  blastr relays best  [n]                  highest success rate
  blastr relays worst [n]                  lowest success rate
  blastr relays rate                       success rate for every relay

Config (config.json settings; validated; restart relay to apply):
  blastr config set <key> <value>          e.g. config set logRetention 14d
                                                config set name My DM Relay
                                                config set privateReads false
  blastr config add discovery <url>        add a WoT discovery relay
  blastr config remove discovery <url>     remove a WoT discovery relay
  blastr config get <key>                  show one value
  blastr config list                       show all values (secret key masked)
  blastr config keys                       list editable settings + types
  blastr config validate                   check the whole config is valid
  blastr config set-raw <key> <json>       escape hatch for raw JSON

  (config add relay <url> also works and is an alias for "relays add")

Status:
  blastr status                            summary incl. next log wipe
  blastr next-wipe                         time until the log is wiped
`);
}

try {
  switch (group) {
    case 'config':
      switch (rest[0]) {
        case 'set': configSet(rest[1], rest.slice(2)); break;
        case 'add': configAdd(rest[1], rest[2]); break;
        case 'remove':
        case 'rm': configRemove(rest[1], rest[2]); break;
        case 'get': configGet(rest[1]); break;
        case 'list':
        case 'show': configList(); break;
        case 'keys': configKeys(); break;
        case 'validate': configValidate(); break;
        case 'set-raw': configSetRaw(rest[1], rest[2]); break;
        default: help();
      }
      break;
    case 'relays':
      switch (rest[0]) {
        case 'add': relaysAdd(rest[1]); break;
        case 'remove':
        case 'rm': relaysRemove(rest[1]); break;
        case 'sync': relaysSync(); break;
        case 'list': relaysList(); break;
        case 'recent': relaysRecent(rest[1]); break;
        case 'best': relaysRanked('best', rest[1]); break;
        case 'worst': relaysRanked('worst', rest[1]); break;
        case 'rate': relaysRate(); break;
        default: help();
      }
      break;
    case 'status': showStatus(); break;
    case 'next-wipe': showNextWipe(); break;
    default: help();
  }
} catch (e) {
  die(`error: ${e.message}`);
}
