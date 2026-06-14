import { probe } from './relay-client.js';
import {
  getSendRelays,
  logRelayAttempt,
  relayFailureStats,
  removeRelay,
  wipeRelayLog,
  setMeta,
} from './db.js';
import { isExcludedRelayUrl } from './config.js';

// A harvested relay must have at least this many recorded attempts before it's
// eligible for purge, so a tiny sample (e.g. one transient timeout) can't evict
// an otherwise-good relay on a 100% failure rate.
const MIN_ATTEMPTS_BEFORE_PURGE = 3;

/**
 * Remove HARVESTED relays that are un-routable from this server (.onion when not
 * allowed, .local, localhost/loopback, link-local). Manual ('manual') relays are
 * left alone — an admin's explicit choice is respected. Run once at startup so
 * pre-existing junk is cleared immediately on deploy.
 */
export function pruneUnroutableRelays(cfg) {
  const allowOnion = cfg.allowOnionRelays;
  let removed = 0;
  for (const { url } of getSendRelays().filter((r) => r.source === '10050')) {
    if (isExcludedRelayUrl(url, { allowOnion })) {
      removeRelay(url);
      removed++;
    }
  }
  if (removed) {
    console.log(`[health] pruned ${removed} un-routable harvested relay(s) (.onion/.local/loopback)`);
  }
}

/**
 * Active liveness check for harvested relays. A probe records reachability both
 * ways: reachable -> success, unreachable -> failure. This feeds the "cannot
 * reach" half of the purge rule and gives `blastr relays best/rate` real data.
 * (Reachability is not the same as write-acceptance, but it's the strongest
 * signal we have without actually publishing; genuine write rejections still get
 * logged as failures during real blasts.)
 */
export async function checkLiveness(cfg) {
  const allowOnion = cfg.allowOnionRelays;
  const harvested = getSendRelays().filter(
    (r) => r.source === '10050' && !isExcludedRelayUrl(r.url, { allowOnion })
  );
  if (harvested.length === 0) return;
  console.log(`[health] probing ${harvested.length} harvested relay(s)…`);

  let reachableCount = 0;
  await Promise.all(
    harvested.map(async ({ url }) => {
      const { reachable, reason } = await probe(url, {
        timeoutMs: cfg.probeTimeoutMs,
        outboundConnectConcurrency: cfg.outboundConnectConcurrency,
        outboundConnectIntervalMs: cfg.outboundConnectIntervalMs,
        outboundConnectPerRelayIntervalMs: cfg.outboundConnectPerRelayIntervalMs,
      });
      if (reachable) {
        reachableCount++;
        logRelayAttempt(url, true, 'probe: reachable');
      } else {
        logRelayAttempt(url, false, `unreachable: ${reason}`);
        console.log(`[health] ${url} unreachable (${reason})`);
      }
    })
  );
  console.log(
    `[health] probe complete: ${reachableCount} reachable, ` +
      `${harvested.length - reachableCount} unreachable (of ${harvested.length})`
  );
}

/**
 * Remove harvested relays we consistently can't reach or deliver to, based on
 * recorded probe + blast outcomes. Manual ('manual') relays are never auto-purged.
 * This is core dynamic relay management — it runs on the liveness cadence and is
 * independent of any log-wipe schedule. Returns the number removed.
 */
export function purgeUnhealthyRelays() {
  const harvested = new Set(getSendRelays().filter((r) => r.source === '10050').map((r) => r.url));
  const stats = relayFailureStats();
  let purged = 0;

  for (const { url, attempts, failures } of stats) {
    if (!harvested.has(url)) continue; // only purge learned relays
    if (attempts < MIN_ATTEMPTS_BEFORE_PURGE) continue; // not enough signal yet
    const failureRate = failures / attempts;
    if (failureRate >= 0.5) {
      removeRelay(url); // also clears this relay's health log
      purged++;
      console.log(
        `[purge] removed ${url} — ${failures}/${attempts} attempts failed (${(failureRate * 100).toFixed(0)}%)`
      );
    }
  }

  if (purged) console.log(`[purge] removed ${purged} unhealthy harvested relay(s).`);
  return purged;
}

/**
 * OPTIONAL periodic maintenance: purge unhealthy relays, then wipe the whole
 * health log to bound its size. Only scheduled when logRetention is set; it is
 * OFF by default (see config), so logs are retained indefinitely.
 */
export function purgeAndWipe() {
  const purged = purgeUnhealthyRelays();
  wipeRelayLog();
  setMeta('last_wipe_at', Math.floor(Date.now() / 1000));
  console.log(`[purge] log-wipe complete: ${purged} relay(s) removed; health log cleared.`);
}