import path from 'node:path';
import Database from 'better-sqlite3';
import { normalizeUrl } from './config.js';

let db;

export function initDb(cfg) {
  db = new Database(path.join(cfg.dataDir, 'blastr.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000'); // tolerate concurrent writes (relay + CLI)

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      pubkey      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      kind        INTEGER NOT NULL,
      content     TEXT NOT NULL,
      tags        TEXT NOT NULL,   -- JSON
      raw         TEXT NOT NULL    -- full JSON event
    );
    CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

    -- p-tag index so we can serve "DMs addressed to pubkey X" efficiently.
    CREATE TABLE IF NOT EXISTS event_ptags (
      event_id TEXT NOT NULL,
      pubkey   TEXT NOT NULL,
      PRIMARY KEY (event_id, pubkey)
    );
    CREATE INDEX IF NOT EXISTS idx_ptags_pubkey ON event_ptags(pubkey);

    -- Relays we blast to. source: 'config' (permanent) or '10050' (harvested, purgeable).
    CREATE TABLE IF NOT EXISTS relays (
      url       TEXT PRIMARY KEY,
      source    TEXT NOT NULL,
      added_at  INTEGER NOT NULL
    );

    -- Pubkeys the admin has DM'd first. They may write back even if outside the WoT.
    CREATE TABLE IF NOT EXISTS contacted (
      pubkey    TEXT PRIMARY KEY,
      added_at  INTEGER NOT NULL
    );

    -- Cached web of trust. degree 1 = admin follows, degree 2 = follows-of-follows.
    CREATE TABLE IF NOT EXISTS wot (
      pubkey     TEXT PRIMARY KEY,
      degree     INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Health log. Wiped weekly so it only ever holds ~1 week of data.
    -- ok = 1 means connected AND the relay accepted our write (OK,true).
    -- ok = 0 means could not reach OR write was rejected.
    CREATE TABLE IF NOT EXISTS relay_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      url    TEXT NOT NULL,
      ts     INTEGER NOT NULL,
      ok     INTEGER NOT NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_log_url ON relay_log(url);

    -- Small key/value store for relay state (e.g. last_wipe_at).
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return db;
}

export function getDb() {
  if (!db) throw new Error('db not initialised');
  return db;
}

// ---------- events ----------

export function storeEvent(event) {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, content, tags, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.id,
      event.pubkey,
      event.created_at,
      event.kind,
      event.content,
      JSON.stringify(event.tags),
      JSON.stringify(event)
    );
    const ins = db.prepare('INSERT OR IGNORE INTO event_ptags (event_id, pubkey) VALUES (?, ?)');
    for (const t of event.tags || []) {
      if (t[0] === 'p' && typeof t[1] === 'string') ins.run(event.id, t[1].toLowerCase());
    }
  });
  tx();
}

/**
 * Query events for a single NIP-01 REQ filter. If restrictToPubkey is set,
 * kind-1059 results are limited to those p-tagging that pubkey (private reads).
 */
export function queryEvents(filter, { restrictToPubkey = null, hardLimit = 1000 } = {}) {
  const where = [];
  const params = [];

  if (filter.ids?.length) {
    where.push(`e.id IN (${filter.ids.map(() => '?').join(',')})`);
    params.push(...filter.ids);
  }
  if (filter.authors?.length) {
    where.push(`e.pubkey IN (${filter.authors.map(() => '?').join(',')})`);
    params.push(...filter.authors);
  }
  if (filter.kinds?.length) {
    where.push(`e.kind IN (${filter.kinds.map(() => '?').join(',')})`);
    params.push(...filter.kinds);
  }
  if (typeof filter.since === 'number') {
    where.push('e.created_at >= ?');
    params.push(filter.since);
  }
  if (typeof filter.until === 'number') {
    where.push('e.created_at <= ?');
    params.push(filter.until);
  }

  // #p filter via the join table.
  let joinClause = '';
  if (filter['#p']?.length) {
    joinClause = 'JOIN event_ptags ep ON ep.event_id = e.id';
    where.push(`ep.pubkey IN (${filter['#p'].map(() => '?').join(',')})`);
    params.push(...filter['#p'].map((p) => p.toLowerCase()));
  }

  const limit = Math.min(filter.limit || hardLimit, hardLimit);
  const sql = `SELECT DISTINCT e.raw FROM events e ${joinClause}
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY e.created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit);
  let events = rows.map((r) => JSON.parse(r.raw));

  if (restrictToPubkey) {
    const allowed = new Set(
      db
        .prepare('SELECT event_id FROM event_ptags WHERE pubkey = ?')
        .all(restrictToPubkey)
        .map((r) => r.event_id)
    );
    events = events.filter((ev) => ev.kind !== 1059 || allowed.has(ev.id));
  }
  return events;
}

// ---------- relays (send list) ----------

export function addRelay(url, source) {
  const n = normalizeUrl(url);
  if (!n.startsWith('ws')) return false;
  const existing = db.prepare('SELECT url FROM relays WHERE url = ?').get(n);
  if (existing) return false;
  db.prepare('INSERT INTO relays (url, source, added_at) VALUES (?, ?, ?)').run(
    n,
    source,
    Math.floor(Date.now() / 1000)
  );
  return true;
}

export function getSendRelays() {
  return db.prepare('SELECT url, source FROM relays').all();
}

export function getRelaysBySource(source) {
  return db.prepare('SELECT url FROM relays WHERE source = ?').all(source).map((r) => r.url);
}

/**
 * Insert a relay, or update its source if it already exists.
 * Used for manual relays so an admin can promote a previously-harvested relay.
 * Returns { created, changed }.
 */
export function upsertRelay(url, source) {
  const n = normalizeUrl(url);
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT source FROM relays WHERE url = ?').get(n);
  if (!existing) {
    db.prepare('INSERT INTO relays (url, source, added_at) VALUES (?, ?, ?)').run(n, source, now);
    return { created: true, changed: true };
  }
  if (existing.source !== source) {
    db.prepare('UPDATE relays SET source = ? WHERE url = ?').run(source, n);
    return { created: false, changed: true };
  }
  return { created: false, changed: false };
}

export function removeRelay(url) {
  const n = normalizeUrl(url);
  db.prepare('DELETE FROM relays WHERE url = ?').run(n);
  // Also drop this relay's health log. Without a periodic wipe these rows would
  // otherwise accumulate forever, and a re-harvested relay would inherit stale
  // failures and be re-purged immediately.
  db.prepare('DELETE FROM relay_log WHERE url = ?').run(n);
}

// ---------- contacted ----------

export function addContacted(pubkey) {
  db.prepare('INSERT OR IGNORE INTO contacted (pubkey, added_at) VALUES (?, ?)').run(
    pubkey.toLowerCase(),
    Math.floor(Date.now() / 1000)
  );
}

export function isContacted(pubkey) {
  return !!db.prepare('SELECT 1 FROM contacted WHERE pubkey = ?').get(pubkey.toLowerCase());
}

// ---------- web of trust ----------

export function replaceWot(degree1, degree2) {
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM wot').run();
    const ins = db.prepare('INSERT OR IGNORE INTO wot (pubkey, degree, updated_at) VALUES (?, ?, ?)');
    for (const pk of degree1) ins.run(pk, 1, now);
    for (const pk of degree2) ins.run(pk, 2, now);
  });
  tx();
}

export function isInWot(pubkey) {
  return !!db.prepare('SELECT 1 FROM wot WHERE pubkey = ?').get(pubkey.toLowerCase());
}

export function wotSize() {
  return db.prepare('SELECT COUNT(*) c FROM wot').get().c;
}

// ---------- relay health log ----------

export function logRelayAttempt(url, ok, reason) {
  db.prepare('INSERT INTO relay_log (url, ts, ok, reason) VALUES (?, ?, ?, ?)').run(
    normalizeUrl(url),
    Math.floor(Date.now() / 1000),
    ok ? 1 : 0,
    reason || null
  );
}

/** Per-relay failure stats over everything currently in the log. */
export function relayFailureStats() {
  return db
    .prepare(
      `SELECT url,
              COUNT(*)                       AS attempts,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
       FROM relay_log GROUP BY url`
    )
    .all();
}

export function wipeRelayLog() {
  db.prepare('DELETE FROM relay_log').run();
}

// ---------- meta key/value ----------

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// ---------- stats for the CLI (all derived from relay_log) ----------

/**
 * Per-relay stats over everything currently in the log:
 * { url, attempts, successes, failures, rate (0..1 or null), lastTs }
 */
export function getRelayStats() {
  const rows = db
    .prepare(
      `SELECT url,
              COUNT(*)                                  AS attempts,
              SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END)   AS successes,
              MAX(ts)                                   AS lastTs
       FROM relay_log GROUP BY url`
    )
    .all();
  return rows.map((r) => ({
    url: r.url,
    attempts: r.attempts,
    successes: r.successes,
    failures: r.attempts - r.successes,
    rate: r.attempts > 0 ? r.successes / r.attempts : null,
    lastTs: r.lastTs,
  }));
}

/** Most recent log entry per relay (for "recently used" with last outcome). */
export function getLastOutcomes() {
  return db
    .prepare(
      `SELECT rl.url, rl.ts AS lastTs, rl.ok AS lastOk, rl.reason AS lastReason
       FROM relay_log rl
       JOIN (SELECT url, MAX(ts) AS m FROM relay_log GROUP BY url) x
         ON x.url = rl.url AND x.m = rl.ts
       GROUP BY rl.url`
    )
    .all();
}