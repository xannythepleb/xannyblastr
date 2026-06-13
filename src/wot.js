import { fetchEvents } from './relay-client.js';
import { replaceWot, wotSize } from './db.js';

/** Pull the newest kind-3 contact list for `pubkey` across discovery relays. */
async function fetchLatestContactList(pubkey, cfg) {
  const filter = { authors: [pubkey], kinds: [3], limit: 1 };
  const results = await Promise.all(
    cfg.discoveryRelays.map((url) =>
      fetchEvents(url, [filter], {
        secretKey: cfg.secretKey,
        timeoutMs: cfg.blastTimeoutMs,
        outboundConnectConcurrency: cfg.outboundConnectConcurrency,
        outboundConnectIntervalMs: cfg.outboundConnectIntervalMs,
        outboundConnectPerRelayIntervalMs: cfg.outboundConnectPerRelayIntervalMs,
      })
    )
  );
  let newest = null;
  for (const events of results) {
    for (const ev of events) {
      if (ev.kind === 3 && (!newest || ev.created_at > newest.created_at)) newest = ev;
    }
  }
  return newest;
}

function followsFrom(contactList) {
  if (!contactList) return [];
  return (contactList.tags || [])
    .filter((t) => t[0] === 'p' && typeof t[1] === 'string')
    .map((t) => t[1].toLowerCase());
}

/** Run async tasks with bounded concurrency. */
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Rebuild the cached web of trust:
 *   degree 1 = admin's follows
 *   degree 2 = follows of each degree-1 pubkey
 */
export async function refreshWot(cfg) {
  const started = Date.now();
  console.log('[wot] refreshing web of trust…');

  const adminList = await fetchLatestContactList(cfg.adminHex, cfg);
  const degree1 = new Set(followsFrom(adminList));
  degree1.delete(cfg.adminHex);

  if (degree1.size === 0) {
    console.warn('[wot] admin follow list is empty or not found on discovery relays.');
    replaceWot([], []);
    return;
  }

  const degree2 = new Set();
  if (cfg.wotDepth >= 2) {
    const d1arr = [...degree1];
    await mapLimit(d1arr, cfg.wotFetchConcurrency, async (pk) => {
      if (degree2.size >= cfg.maxWotSize) return;
      const list = await fetchLatestContactList(pk, cfg);
      for (const f of followsFrom(list)) {
        if (degree2.size >= cfg.maxWotSize) break;
        if (f !== cfg.adminHex && !degree1.has(f)) degree2.add(f);
      }
    });
  }

  replaceWot([...degree1], [...degree2]);
  console.log(
    `[wot] done: ${degree1.size} direct follows, ${degree2.size} second-degree ` +
      `(total ${wotSize()}) in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}
