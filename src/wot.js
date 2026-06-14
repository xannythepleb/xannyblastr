import { fetchEvents } from './relay-client.js';
import { replaceWot, wotSize, addRelay } from './db.js';
import { relayTagsFrom10050, isValidEvent } from './nostr.js';
import { isExcludedRelayUrl } from './config.js';

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

// How many authors to put in a single kind-10050 REQ filter. Kept modest so we
// stay under common relay per-filter author caps; the WoT is fetched in chunks.
const TENK_AUTHOR_BATCH = 200;

/**
 * Fetch the newest kind-10050 DM relay lists for a set of authors from the
 * discovery relays. Authors are chunked so each discovery relay gets a small
 * number of REQs instead of one-per-pubkey. Returns the raw events collected.
 */
async function fetch10050ForAuthors(authors, cfg) {
  const out = [];
  for (let i = 0; i < authors.length; i += TENK_AUTHOR_BATCH) {
    const batch = authors.slice(i, i + TENK_AUTHOR_BATCH);
    const filter = { authors: batch, kinds: [10050], limit: batch.length };
    const perRelay = await Promise.all(
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
    for (const list of perRelay) for (const ev of list) out.push(ev);
  }
  return out;
}

/**
 * Proactively discover downstream DM relays. Pull kind-10050 DM relay lists for
 * the admin (always) and — unless harvest10050From is 'admin' — WoT members up to
 * dmRelaySweepDepth (1 = direct follows only, 2 = + follows-of-follows), then
 * harvest the relays they advertise. Runs on each WoT refresh.
 *
 * Fetched 10050s are signature-checked AND must be authored by a pubkey we asked
 * for, so a misbehaving discovery relay can't inject arbitrary blast targets.
 * Newly added relays get source '10050' (purgeable), exactly like reactively
 * harvested ones.
 */
export async function harvestDmRelaysFromWot(cfg, degree1, degree2) {
  if (cfg.discoveryRelays.length === 0) {
    console.warn('[wot] no discovery relays configured; skipping 10050 relay sweep.');
    return;
  }

  const authorsSet = new Set([cfg.adminHex]);
  if (cfg.harvest10050From !== 'admin') {
    for (const pk of degree1) authorsSet.add(pk);
    if (cfg.dmRelaySweepDepth >= 2) {
      for (const pk of degree2) authorsSet.add(pk);
    }
  }
  const authors = [...authorsSet];
  const scope = cfg.harvest10050From === 'admin' ? 'admin-only' : `depth ${cfg.dmRelaySweepDepth}`;
  console.log(`[wot] sweeping kind-10050 DM relay lists for ${authors.length} pubkey(s) (${scope})…`);

  const events = await fetch10050ForAuthors(authors, cfg);

  // Keep the newest valid 10050 per author we actually asked for.
  const newest = new Map();
  for (const ev of events) {
    if (!ev || ev.kind !== 10050 || typeof ev.pubkey !== 'string') continue;
    if (!authorsSet.has(ev.pubkey)) continue; // relay returned an unrequested author
    if (!isValidEvent(ev)) continue; // forged / corrupt
    const prev = newest.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) newest.set(ev.pubkey, ev);
  }

  const added = [];
  for (const ev of newest.values()) {
    for (const url of relayTagsFrom10050(ev)) {
      if (isExcludedRelayUrl(url, { allowOnion: cfg.allowOnionRelays })) continue;
      if (addRelay(url, '10050')) {
        added.push(url);
        console.log(`[harvest] discovered new blast relay (10050): ${url}`);
      }
    }
  }
  console.log(
    `[wot] 10050 sweep complete: ${newest.size} DM relay list(s) found, ${added.length} new relay(s) added`
  );
}


/**
 * Rebuild the cached web of trust:
 *   degree 1 = admin's follows
 *   degree 2 = follows of each degree-1 pubkey
 * Then proactively sweep kind-10050 DM relay lists and harvest their relays.
 */
export async function refreshWot(cfg) {
  const started = Date.now();
  console.log('[wot] refreshing web of trust…');

  const adminList = await fetchLatestContactList(cfg.adminHex, cfg);
  const degree1 = new Set(followsFrom(adminList));
  degree1.delete(cfg.adminHex);

  const degree2 = new Set();
  if (degree1.size === 0) {
    console.warn('[wot] admin follow list is empty or not found on discovery relays.');
    replaceWot([], []);
  } else {
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

  // Proactively pull DM relay lists (kind 10050) and harvest the relays they
  // advertise. Isolated so a sweep failure never aborts the WoT refresh itself.
  try {
    await harvestDmRelaysFromWot(cfg, degree1, degree2);
  } catch (e) {
    console.error('[wot] 10050 relay sweep failed', e);
  }
}