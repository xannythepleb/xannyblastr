import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nip19 } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function configFilePath() {
  return process.env.BLASTR_CONFIG || path.join(ROOT, 'config.json');
}

function toHexPubkey(value) {
  if (!value) throw new Error('adminNpub is required in config');
  if (value.startsWith('npub')) {
    const { type, data } = nip19.decode(value);
    if (type !== 'npub') throw new Error('adminNpub is not a valid npub');
    return data;
  }
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  throw new Error('adminNpub must be an npub or 64-char hex pubkey');
}

function toSecretKeyBytes(value) {
  if (!value) return null;
  if (value.startsWith('nsec')) {
    const { type, data } = nip19.decode(value);
    if (type !== 'nsec') throw new Error('relaySecretKey is not a valid nsec');
    return data; // Uint8Array
  }
  if (/^[0-9a-f]{64}$/i.test(value)) return Uint8Array.from(Buffer.from(value, 'hex'));
  throw new Error('relaySecretKey must be an nsec or 64-char hex secret key');
}

/**
 * Parse a log-retention duration into milliseconds.
 * Accepts a number (interpreted as DAYS) or a string like "7d", "12h", "30m", "1w", "3600s".
 */
export function parseDuration(value, fallbackMs) {
  if (value == null) return fallbackMs;
  if (typeof value === 'number') return value * 86400 * 1000; // bare number = days
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/i);
  if (!m) throw new Error(`invalid duration: "${value}" (use e.g. "7d", "12h", "1w")`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'd').toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  return n * mult;
}

/** Read the config file as raw JSON (comment keys preserved). Does NOT validate. */
export function readRawConfig() {
  const p = configFilePath();
  if (!fs.existsSync(p)) {
    throw new Error(`Config not found at ${p}. Copy config.example.json to config.json and edit it.`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Write raw config back to disk, preserving 2-space formatting. */
export function writeRawConfig(obj) {
  fs.writeFileSync(configFilePath(), JSON.stringify(obj, null, 2) + '\n');
}

export function loadConfig() {
  const raw = readRawConfig();

  // Strip comment keys (anything starting with "//").
  const clean = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('//')) clean[k] = v;
  }

  const adminHex = toHexPubkey(clean.adminNpub);
  const adminNpub = nip19.npubEncode(adminHex);
  const secretKey = toSecretKeyBytes(clean.relaySecretKey);
  const relayPubkeyHex = secretKey ? getPublicKey(secretKey) : null;
  const relayNpub = relayPubkeyHex ? nip19.npubEncode(relayPubkeyHex) : null;

  const dataDir = path.isAbsolute(clean.dataDir || './data')
    ? clean.dataDir
    : path.join(ROOT, clean.dataDir || './data');
  fs.mkdirSync(dataDir, { recursive: true });

  const relaysFileRaw = clean.relaysFile || './relays.yml';
  const relaysFile = path.isAbsolute(relaysFileRaw) ? relaysFileRaw : path.join(ROOT, relaysFileRaw);

  // Periodic log wiping is OFF by default so relay success-rate history is kept
  // indefinitely. Set logRetention (e.g. '30d') to re-enable it. 'off'/'never'/0
  // (and the default) disable it -> logRetentionMs === 0.
  const rawRetention = clean.logRetention ?? 'off';
  const wipeOff =
    rawRetention === 'off' || rawRetention === 'never' || rawRetention === 0 || rawRetention === '0';
  const logRetentionLabel = wipeOff ? 'off' : String(rawRetention);
  const logRetentionMs = wipeOff ? 0 : parseDuration(rawRetention, 7 * 86400 * 1000);

  return {
    host: clean.host || '0.0.0.0',
    port: clean.port || 7447,
    relayUrl: clean.relayUrl || 'wss://localhost',
    name: clean.name || 'xannyblastr',
    description: clean.description || '',
    adminHex,
    adminNpub,
    secretKey,
    relayPubkeyHex,
    relayNpub,
    allowedKinds: clean.allowedKinds || [1059, 10050],
    discoveryRelays: dedupeUrls(clean.discoveryRelays || []),
    wotDepth: clean.wotDepth ?? 2,
    wotRefreshHours: clean.wotRefreshHours ?? 24,
    maxWotSize: clean.maxWotSize ?? 250000,
    wotFetchConcurrency: clean.wotFetchConcurrency ?? 8,
    outboundConnectConcurrency: clean.outboundConnectConcurrency ?? 4,
    outboundConnectIntervalMs: clean.outboundConnectIntervalMs ?? 250,
    outboundConnectPerRelayIntervalMs: clean.outboundConnectPerRelayIntervalMs ?? 1000,
    harvest10050From: clean.harvest10050From || 'all',
    dmRelaySweepDepth: clean.dmRelaySweepDepth ?? 1,
    allowOnionRelays: clean.allowOnionRelays ?? false,
    livenessIntervalHours: clean.livenessIntervalHours ?? 6,
    logRetentionMs,
    logRetentionLabel: String(logRetentionLabel),
    blastTimeoutMs: clean.blastTimeoutMs ?? 8000,
    probeTimeoutMs: clean.probeTimeoutMs ?? 6000,
    privateReads: clean.privateReads ?? true,
    dataDir,
    relaysFile,
  };
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let s = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '');
    return s.toLowerCase();
  } catch {
    return String(url).trim().toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Should this relay URL be excluded as un-routable from this server?
 *   - .onion        -> excluded unless allowOnion (e.g. running behind Tor)
 *   - .local / mDNS, localhost, loopback, link-local -> always excluded
 *   - unparseable   -> excluded
 * Private LAN ranges (10/172.16/192.168) are intentionally NOT excluded — a
 * self-hoster may legitimately blast to a relay on the same network.
 */
export function isExcludedRelayUrl(url, { allowOnion = false } = {}) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // strip IPv6 brackets

  if (host.endsWith('.onion')) return !allowOnion;
  if (host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '::1' || /^127\./.test(host)) return true; // loopback
  if (/^169\.254\./.test(host) || host.startsWith('fe80:')) return true; // link-local
  return false;
}

function dedupeUrls(arr) {
  return [...new Set(arr.map(normalizeUrl))];
}