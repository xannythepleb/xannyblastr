import WebSocket from 'ws';
import fs from 'node:fs';
import { buildAuthEvent } from './nostr.js';
import { withOutboundConnectLimit } from './outbound-limiter.js';

// Identifies this client to downstream relays in the WebSocket handshake, e.g.
// "xannyblastr/1.0.1-beta". (The 'ws' client sends no User-Agent by default.)
// Guarded so a missing/garbled package.json degrades to a bare name rather than
// breaking outbound connections.
function buildUserAgent() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version ? `xannyblastr/${pkg.version}` : 'xannyblastr';
  } catch {
    return 'xannyblastr';
  }
}
const USER_AGENT = buildUserAgent();

/**
 * Publish an event to a downstream relay.
 * Handles NIP-42: if the relay challenges us, we AUTH with our relay key (if set)
 * and resend the event once.
 *
 * Returns { ok, reason }.
 *   ok = true  -> connected AND relay accepted the write (OK, true). This is "success".
 *   ok = false -> could not connect, timed out, or write was rejected.
 */
export function publishEvent(url, event, opts = {}) {
  return withOutboundConnectLimit(url, opts, () => publishEventNow(url, event, opts));
}

function publishEventNow(url, event, { secretKey, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let resent = false;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ ok, reason });
    };

    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);

    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs, headers: { 'User-Agent': USER_AGENT } });
    } catch (e) {
      return finish(false, `connect-error: ${e.message}`);
    }

    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const [type] = msg;

      if (type === 'OK' && msg[1] === event.id) {
        const accepted = msg[2] === true;
        finish(accepted, accepted ? 'accepted' : `rejected: ${msg[3] || 'no reason'}`);
      } else if (type === 'AUTH') {
        const challenge = msg[1];
        const authEv = buildAuthEvent(secretKey, url, challenge);
        if (!authEv) {
          finish(false, 'auth-required: no relay key configured');
          return;
        }
        ws.send(JSON.stringify(['AUTH', authEv]));
        if (!resent) {
          resent = true;
          ws.send(JSON.stringify(['EVENT', event])); // resend after auth
        }
      } else if (type === 'NOTICE') {
        // informational only
      }
    });

    ws.on('error', (e) => finish(false, `connect-error: ${e.message}`));
    ws.on('close', () => finish(false, 'closed-before-ok'));
  });
}

/**
 * Fetch events matching filters from a downstream relay (used for WoT building).
 * Resolves with the collected events on EOSE or timeout.
 */
export function fetchEvents(url, filters, opts = {}) {
  return withOutboundConnectLimit(url, opts, () => fetchEventsNow(url, filters, opts));
}

function fetchEventsNow(url, filters, { secretKey, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const subId = 'wot' + Math.random().toString(36).slice(2, 8);
    const collected = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(collected);
    };
    const timer = setTimeout(finish, timeoutMs);

    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs, headers: { 'User-Agent': USER_AGENT } });
    } catch {
      return finish();
    }

    ws.on('open', () => ws.send(JSON.stringify(['REQ', subId, ...filters])));

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const [type] = msg;
      if (type === 'EVENT' && msg[1] === subId) {
        collected.push(msg[2]);
      } else if (type === 'EOSE' && msg[1] === subId) {
        finish();
      } else if (type === 'AUTH' && secretKey) {
        const authEv = buildAuthEvent(secretKey, url, msg[1]);
        if (authEv) ws.send(JSON.stringify(['AUTH', authEv]));
      }
    });

    ws.on('error', finish);
    ws.on('close', finish);
  });
}

/** Lightweight reachability probe. Resolves { reachable, reason }. */
export function probe(url, opts = {}) {
  return withOutboundConnectLimit(url, opts, () => probeNow(url, opts));
}

function probeNow(url, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reachable, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ reachable, reason });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);

    let ws;
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs, headers: { 'User-Agent': USER_AGENT } });
    } catch (e) {
      return finish(false, `connect-error: ${e.message}`);
    }
    ws.on('open', () => finish(true, 'reachable'));
    ws.on('error', (e) => finish(false, `connect-error: ${e.message}`));
  });
}