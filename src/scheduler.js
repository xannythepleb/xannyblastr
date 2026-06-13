import { refreshWot } from './wot.js';
import { checkLiveness, purgeAndWipe } from './relay-health.js';
import { getMeta, setMeta } from './db.js';

// setTimeout can't safely hold delays beyond ~24.8 days, and we want to tolerate
// clock changes, so we re-evaluate the retention timer in chunks.
const MAX_CHUNK_MS = 6 * 3600 * 1000;

export function nextWipeMs(cfg) {
  const last = Number(getMeta('last_wipe_at') || 0);
  return last * 1000 + cfg.logRetentionMs;
}

export function startSchedulers(cfg) {
  // Web of trust: refresh now, then on an interval.
  refreshWot(cfg).catch((e) => console.error('[wot] initial refresh failed', e));
  setInterval(() => {
    refreshWot(cfg).catch((e) => console.error('[wot] refresh failed', e));
  }, cfg.wotRefreshHours * 3600 * 1000);

  // Liveness probes for harvested relays.
  setInterval(() => {
    checkLiveness(cfg).catch((e) => console.error('[health] liveness failed', e));
  }, cfg.livenessIntervalHours * 3600 * 1000);

  // Retention: ensure we have a baseline wipe time, then schedule.
  if (!getMeta('last_wipe_at')) setMeta('last_wipe_at', Math.floor(Date.now() / 1000));
  scheduleRetention(cfg);
  console.log(
    `[sched] log retention: ${cfg.logRetentionLabel} ` +
      `(next wipe ~ ${new Date(nextWipeMs(cfg)).toISOString()})`
  );
}

function scheduleRetention(cfg) {
  const delay = nextWipeMs(cfg) - Date.now();
  if (delay <= 0) {
    try {
      purgeAndWipe(cfg); // updates last_wipe_at
    } catch (e) {
      console.error('[purge] failed', e);
      setMeta('last_wipe_at', Math.floor(Date.now() / 1000)); // avoid a tight loop on error
    }
    return scheduleRetention(cfg);
  }
  setTimeout(() => scheduleRetention(cfg), Math.min(delay, MAX_CHUNK_MS)).unref?.();
}
