import http from 'node:http';
import { WebSocketServer } from 'ws';
import { makeChallenge, validateAuthEvent, isValidEvent } from './nostr.js';
import { storeEvent, queryEvents } from './db.js';
import { authorizeWrite, recordAdminOutreach } from './access-control.js';
import { blast, harvestRelaysFrom10050 } from './blaster.js';
import { attachNip11 } from './nip11.js';

export function startRelayServer(cfg) {
  const server = http.createServer();
  attachNip11(server, cfg); // serves the NIP-11 doc on plain GET
  const wss = new WebSocketServer({ server }); // WebSocket upgrades on the same port
  const allowed = new Set(cfg.allowedKinds);

  wss.on('connection', (ws) => {
    const state = {
      authedPubkey: null,
      challenge: makeChallenge(),
      subs: new Map(), // subId -> { filters, restrictToPubkey }
    };
    ws._state = state; // exposed so broadcast() can reach this connection's subs

    // NIP-42: invite the client to authenticate immediately.
    ws.send(JSON.stringify(['AUTH', state.challenge]));

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return ws.send(JSON.stringify(['NOTICE', 'invalid: malformed JSON']));
      }
      if (!Array.isArray(msg)) return;

      switch (msg[0]) {
        case 'AUTH':
          return handleAuth(ws, state, msg[1], cfg);
        case 'EVENT':
          return handleEvent(ws, state, msg[1], cfg, allowed, wss);
        case 'REQ':
          return handleReq(ws, state, msg, cfg);
        case 'CLOSE':
          state.subs.delete(msg[1]);
          return;
        default:
          return;
      }
    });

    ws.on('error', () => {});
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`[relay] listening on ws://${cfg.host}:${cfg.port}  (advertised as ${cfg.relayUrl})`);
    console.log(`[relay] NIP-11 info served over HTTP on the same port`);
  });
  return wss;
}

function handleAuth(ws, state, authEvent, cfg) {
  try {
    const pubkey = validateAuthEvent(authEvent, state.challenge, cfg.relayUrl);
    state.authedPubkey = pubkey.toLowerCase();
    ws.send(JSON.stringify(['OK', authEvent.id, true, '']));
  } catch (e) {
    ws.send(JSON.stringify(['OK', authEvent?.id || '', false, `auth-failed: ${e.message}`]));
  }
}

function handleEvent(ws, state, event, cfg, allowed, wss) {
  if (!event || typeof event.id !== 'string') return;

  // 1. Cryptographic validity.
  if (!isValidEvent(event)) {
    return ws.send(JSON.stringify(['OK', event.id, false, 'invalid: bad signature or structure']));
  }

  // 2. Kind whitelist — this is a DM-only relay.
  if (!allowed.has(event.kind)) {
    return ws.send(
      JSON.stringify([
        'OK',
        event.id,
        false,
        'blocked: this relay only accepts kind 1059 (gift-wrapped DMs) and 10050 (DM relay lists)',
      ])
    );
  }

  // 3. Access control — keyed on the NIP-42 authenticated pubkey.
  const decision = authorizeWrite({
    authedPubkey: state.authedPubkey,
    event,
    adminHex: cfg.adminHex,
  });
  if (!decision.allowed) {
    return ws.send(JSON.stringify(['OK', event.id, false, decision.reason]));
  }

  // 4. Store, then react by kind.
  storeEvent(event);
  ws.send(JSON.stringify(['OK', event.id, true, '']));

  if (event.kind === 1059) {
    recordAdminOutreach({ authedPubkey: state.authedPubkey, event, adminHex: cfg.adminHex });
    blast(event, cfg).catch((e) => console.error('[blast] error', e));
  } else if (event.kind === 10050) {
    harvestRelaysFrom10050(event, cfg, { fromAdmin: state.authedPubkey === cfg.adminHex });
  }

  // 5. Fan out to live subscribers.
  broadcast(wss, event);
}

function handleReq(ws, state, msg, cfg) {
  const subId = msg[1];
  const filters = msg.slice(2);
  if (typeof subId !== 'string') return;

  // Private reads: must be authed; you only get 1059s addressed to you.
  let restrictToPubkey = null;
  if (cfg.privateReads) {
    if (!state.authedPubkey) {
      ws.send(JSON.stringify(['CLOSED', subId, 'auth-required: authenticate to read DMs']));
      return;
    }
    if (state.authedPubkey !== cfg.adminHex) restrictToPubkey = state.authedPubkey;
  }

  state.subs.set(subId, { filters, restrictToPubkey });

  const seen = new Set();
  for (const filter of filters) {
    for (const ev of queryEvents(filter, { restrictToPubkey })) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      ws.send(JSON.stringify(['EVENT', subId, ev]));
    }
  }
  ws.send(JSON.stringify(['EOSE', subId]));
}

/** Push a newly accepted event to any matching open subscription. */
function broadcast(wss, event) {
  for (const client of wss.clients) {
    const state = client._state;
    if (!state) continue;
    for (const [subId, sub] of state.subs) {
      if (sub.restrictToPubkey && event.kind === 1059) {
        const addressed = (event.tags || []).some(
          (t) => t[0] === 'p' && typeof t[1] === 'string' && t[1].toLowerCase() === sub.restrictToPubkey
        );
        if (!addressed) continue;
      }
      if (sub.filters.some((f) => matchesFilter(event, f))) {
        try {
          client.send(JSON.stringify(['EVENT', subId, event]));
        } catch {}
      }
    }
  }
}

function matchesFilter(event, f) {
  if (f.ids && !f.ids.includes(event.id)) return false;
  if (f.authors && !f.authors.includes(event.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(event.kind)) return false;
  if (typeof f.since === 'number' && event.created_at < f.since) return false;
  if (typeof f.until === 'number' && event.created_at > f.until) return false;
  if (f['#p']) {
    const ps = (event.tags || [])
      .filter((t) => t[0] === 'p' && typeof t[1] === 'string')
      .map((t) => t[1].toLowerCase());
    if (!f['#p'].some((p) => ps.includes(p.toLowerCase()))) return false;
  }
  return true;
}
