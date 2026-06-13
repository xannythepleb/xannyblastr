import { publishEvent } from './relay-client.js';
import { getSendRelays, logRelayAttempt, addRelay } from './db.js';
import { relayTagsFrom10050 } from './nostr.js';

/**
 * Blast a kind-1059 gift wrap to every relay in the send list.
 * Each attempt is logged: ok=1 only if connected AND the relay accepted the write.
 */
export async function blast(event, cfg) {
  const relays = getSendRelays();
  if (relays.length === 0) {
    console.warn('[blast] no send relays configured; dropping event', event.id);
    return;
  }

  await Promise.all(
    relays.map(async ({ url }) => {
      const { ok, reason } = await publishEvent(url, event, {
        secretKey: cfg.secretKey,
        timeoutMs: cfg.blastTimeoutMs,
        outboundConnectConcurrency: cfg.outboundConnectConcurrency,
        outboundConnectIntervalMs: cfg.outboundConnectIntervalMs,
        outboundConnectPerRelayIntervalMs: cfg.outboundConnectPerRelayIntervalMs,
      });
      logRelayAttempt(url, ok, reason);
      if (!ok) console.log(`[blast] ${url} -> FAIL (${reason})`);
    })
  );
}

/**
 * Learn additional send relays from a kind-10050 DM relay list.
 * Harvested relays get source='10050' and are subject to the weekly purge.
 */
export function harvestRelaysFrom10050(event, cfg, { fromAdmin }) {
  if (cfg.harvest10050From === 'admin' && !fromAdmin) return [];
  const added = [];
  for (const url of relayTagsFrom10050(event)) {
    if (addRelay(url, '10050')) added.push(url);
  }
  if (added.length) console.log(`[harvest] learned ${added.length} relay(s) from 10050:`, added);
  return added;
}
