import fs from 'node:fs';
import yaml from 'js-yaml';
import { normalizeUrl } from './config.js';
import { upsertRelay, removeRelay, getRelaysBySource } from './db.js';

const HEADER =
  '# Manually managed blast relays for xannyblastr.\n' +
  '# Edit this list freely (one wss:// or ws:// URL per line), then either:\n' +
  '#   - run `blastr relays sync`  (applies immediately, no restart), or\n' +
  '#   - restart the relay         (reconciled automatically on boot).\n' +
  '# Harvested (NIP-10050) relays are managed automatically and do NOT appear here.\n';

function isRelayUrl(s) {
  return /^wss?:\/\/.+/.test(s);
}

/** Read and normalise the manual relay list from the YAML file (missing file = []). */
export function loadRelaysYaml(cfg) {
  if (!fs.existsSync(cfg.relaysFile)) return [];
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(cfg.relaysFile, 'utf8')) || {};
  } catch (e) {
    throw new Error(`could not parse ${cfg.relaysFile}: ${e.message}`);
  }
  const list = Array.isArray(doc) ? doc : Array.isArray(doc.relays) ? doc.relays : [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const n = normalizeUrl(item);
    if (isRelayUrl(n)) out.push(n);
    else console.warn(`[relays] ignoring invalid entry in ${cfg.relaysFile}: ${item}`);
  }
  return [...new Set(out)];
}

/** Write the manual relay list back to the YAML file (with a friendly header). */
export function saveRelaysYaml(cfg, urls) {
  const list = [...new Set(urls.map(normalizeUrl).filter(isRelayUrl))];
  fs.writeFileSync(cfg.relaysFile, HEADER + yaml.dump({ relays: list }));
  return list;
}

/** Create an empty relays file if one doesn't exist yet. */
export function ensureRelaysFile(cfg) {
  if (!fs.existsSync(cfg.relaysFile)) saveRelaysYaml(cfg, []);
}

/**
 * Make the DB's MANUAL relays match the YAML file:
 *   - URLs in YAML but not in DB  -> added (source 'manual')
 *   - URLs in DB but not in YAML  -> removed
 * Harvested ('10050') relays are never touched.
 * Returns { added, removed, total }.
 */
export function reconcileManualRelays(cfg) {
  ensureRelaysFile(cfg);
  const yamlUrls = new Set(loadRelaysYaml(cfg));
  const dbManual = new Set(getRelaysBySource('manual'));

  let added = 0;
  let removed = 0;
  for (const url of yamlUrls) {
    if (!dbManual.has(url)) {
      upsertRelay(url, 'manual');
      added++;
    }
  }
  for (const url of dbManual) {
    if (!yamlUrls.has(url)) {
      removeRelay(url);
      removed++;
    }
  }
  return { added, removed, total: yamlUrls.size };
}

/** Add a manual relay to BOTH the DB and the YAML file. */
export function addManualRelay(cfg, rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!isRelayUrl(url)) {
    throw new Error(`"${rawUrl}" is not a relay URL — must start with wss:// or ws://`);
  }
  const list = loadRelaysYaml(cfg);
  const addedToYaml = !list.includes(url);
  if (addedToYaml) {
    list.push(url);
    saveRelaysYaml(cfg, list);
  }
  const { changed } = upsertRelay(url, 'manual');
  return { url, addedToYaml, changed };
}

/** Remove a manual relay from BOTH the DB and the YAML file. */
export function removeManualRelay(cfg, rawUrl) {
  const url = normalizeUrl(rawUrl);
  const list = loadRelaysYaml(cfg);
  const inYaml = list.includes(url);
  if (inYaml) saveRelaysYaml(cfg, list.filter((u) => u !== url));

  const wasManual = getRelaysBySource('manual').includes(url);
  if (wasManual) removeRelay(url);

  const isHarvested = getRelaysBySource('10050').includes(url);
  return { url, inYaml, wasManual, isHarvested };
}
