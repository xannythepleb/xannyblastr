// A tiny process-wide limiter for outbound relay WebSocket connection attempts.
// It intentionally has no external dependencies and is shared by blasting,
// WoT discovery, and liveness probing.
let queue = [];
let active = 0;
let nextGlobalStartAt = 0;
const nextRelayStartAt = new Map();
let timer = null;

function intFrom(value, fallback, { min = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function relayKey(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url).trim().toLowerCase().replace(/\/$/, '');
  }
}

export function outboundLimitSettings(cfg = {}) {
  return {
    concurrency: intFrom(cfg.outboundConnectConcurrency, 4, { min: 1 }),
    intervalMs: intFrom(cfg.outboundConnectIntervalMs, 250, { min: 0 }),
    perRelayIntervalMs: intFrom(cfg.outboundConnectPerRelayIntervalMs, 1000, { min: 0 }),
  };
}

export function describeOutboundLimit(cfg = {}) {
  const { concurrency, intervalMs, perRelayIntervalMs } = outboundLimitSettings(cfg);
  const global = intervalMs > 0 ? `${intervalMs}ms global start gap` : 'no global start gap';
  const perRelay = perRelayIntervalMs > 0
    ? `${perRelayIntervalMs}ms per-relay start gap`
    : 'no per-relay start gap';
  return `max ${concurrency} concurrent, ${global}, ${perRelay}`;
}

/**
 * Queue an outbound relay operation so connection starts are rate-limited.
 * The operation itself owns its WebSocket timeout; queue wait time is separate.
 */
export function withOutboundConnectLimit(url, cfg, fn) {
  return new Promise((resolve, reject) => {
    queue.push({ url, cfg, fn, resolve, reject });
    drain();
  });
}

function drain() {
  if (timer) return;

  while (queue.length) {
    const job = queue[0];
    const { concurrency, intervalMs, perRelayIntervalMs } = outboundLimitSettings(job.cfg);

    if (active >= concurrency) return;

    const now = Date.now();
    const key = relayKey(job.url);
    const waitMs = Math.max(
      0,
      nextGlobalStartAt - now,
      (nextRelayStartAt.get(key) || 0) - now
    );
    if (waitMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        drain();
      }, waitMs);
      timer.unref?.();
      return;
    }

    queue.shift();
    active++;
    const startAt = Date.now();
    nextGlobalStartAt = Math.max(startAt, nextGlobalStartAt) + intervalMs;
    nextRelayStartAt.set(key, Math.max(startAt, nextRelayStartAt.get(key) || 0) + perRelayIntervalMs);

    Promise.resolve()
      .then(() => job.fn())
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        drain();
      });
  }
}
