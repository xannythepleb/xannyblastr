import { refreshWot } from './wot.js';
import { checkLiveness, purgeAndWipe, pruneUnroutableRelays, purgeUnhealthyRelays } from './relay-health.js';
import { getMeta, setMeta } from './db.js';

// setTimeout can't safely hold delays beyond ~24.8 days, and we want to tolerate
// clock changes, so we re-evaluate the retention timer in chunks.
const MAX_CHUNK_MS = 6 * 3600 * 1000;

export function nextWipeMs(cfg) {
  const last = Number(getMeta('last_wipe_at') || 0);
  return last * 1000 + cfg.logRetentionMs;
}

export function startSchedulers(cfg) {
  // One-time cleanup: drop any previously-harvested un-routable relays so they
  // stop being blasted to / probed (new ones are filtered at harvest time).
  try {
    pruneUnroutableRelays(cfg);
  } catch (e) {
    console.error('[health] startup prune failed', e);
  }

  // Web of trust: refresh now, then on an interval.
  refreshWot(cfg).catch((e) => console.error('[wot] initial refresh failed', e));
  setInterval(() => {
    refreshWot(cfg).catch((e) => console.error('[wot] refresh failed', e));
  }, cfg.wotRefreshHours * 3600 * 1000);

  // Liveness probes, then purge unhealthy harvested relays. This is dynamic
  // relay management — always on, independent of any log-wipe schedule.
  setInterval(() => {
    checkLiveness(cfg)
      .then(() => {
        try {
          purgeUnhealthyRelays();
        } catch (e) {
          console.error('[purge] failed', e);
        }
      })
      .catch((e) => console.error('[health] liveness failed', e));
  }, cfg.livenessIntervalHours * 3600 * 1000);

  // Log wipe is OPTIONAL and OFF by default: logs (and relay success-rate history)
  // are retained indefinitely. Set `logRetention` (e.g. 30d) to enable bounding.
  if (cfg.logRetentionMs > 0) {
    if (!getMeta('last_wipe_at')) setMeta('last_wipe_at', Math.floor(Date.now() / 1000));
    scheduleWipe(cfg);
    console.log(
      `[sched] log wipe: every ${cfg.logRetentionLabel} (next ~ ${new Date(nextWipeMs(cfg)).toISOString()})`
    );
  } else {
    console.log('[sched] log wipe: disabled (logs retained indefinitely; set logRetention to enable)');
  }
}

function scheduleWipe(cfg) {
  const delay = nextWipeMs(cfg) - Date.now();
  if (delay <= 0) {
    try {
      purgeAndWipe(); // updates last_wipe_at
    } catch (e) {
      console.error('[purge] failed', e);
      setMeta('last_wipe_at', Math.floor(Date.now() / 1000)); // avoid a tight loop on error
    }
    return scheduleWipe(cfg);
  }
  setTimeout(() => scheduleWipe(cfg), Math.min(delay, MAX_CHUNK_MS)).unref?.();
}