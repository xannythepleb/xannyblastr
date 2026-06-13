import { probe } from './relay-client.js';
import {
  getSendRelays,
  logRelayAttempt,
  relayFailureStats,
  removeRelay,
  wipeRelayLog,
  setMeta,
} from './db.js';

/**
 * Active liveness check for harvested relays. We can't verify write permission
 * without actually writing, so a probe only RECORDS A FAILURE when a relay is
 * unreachable — that's what feeds the "cannot reach" half of the purge rule.
 * Reachable idle relays log nothing (we don't fabricate write-successes).
 */
export async function checkLiveness(cfg) {
  const harvested = getSendRelays().filter((r) => r.source === '10050');
  if (harvested.length === 0) return;
  console.log(`[health] probing ${harvested.length} harvested relay(s)…`);

  await Promise.all(
    harvested.map(async ({ url }) => {
      const { reachable, reason } = await probe(url, {
        timeoutMs: cfg.probeTimeoutMs,
        outboundConnectConcurrency: cfg.outboundConnectConcurrency,
        outboundConnectIntervalMs: cfg.outboundConnectIntervalMs,
        outboundConnectPerRelayIntervalMs: cfg.outboundConnectPerRelayIntervalMs,
      });
      if (!reachable) {
        logRelayAttempt(url, false, `unreachable: ${reason}`);
        console.log(`[health] ${url} unreachable (${reason})`);
      }
    })
  );
}

/**
 * Retention job. For each HARVESTED relay, compute its failure rate from the log.
 * Purge any that we cannot reach OR that reject our writes >= 50% of the time.
 * Admin-configured ('manual') relays are never auto-purged.
 * Afterwards, wipe the entire log so it never survives more than one retention
 * window (configurable via `logRetention`, default 7d), and record the wipe time.
 */
export function purgeAndWipe(cfg) {
  const harvested = new Set(getSendRelays().filter((r) => r.source === '10050').map((r) => r.url));
  const stats = relayFailureStats();
  let purged = 0;

  for (const { url, attempts, failures } of stats) {
    if (!harvested.has(url)) continue; // only purge learned relays
    if (attempts === 0) continue;
    const failureRate = failures / attempts;
    if (failureRate >= 0.5) {
      removeRelay(url);
      purged++;
      console.log(
        `[purge] removed ${url} — ${failures}/${attempts} attempts failed (${(failureRate * 100).toFixed(0)}%)`
      );
    }
  }

  wipeRelayLog();
  setMeta('last_wipe_at', Math.floor(Date.now() / 1000));
  console.log(`[purge] retention job complete: ${purged} relay(s) removed; health log wiped.`);
}
