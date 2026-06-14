import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { initDb } from './db.js';
import { reconcileManualRelays } from './relays-store.js';
import { startRelayServer } from './relay-server.js';
import { startSchedulers } from './scheduler.js';
import { describeOutboundLimit } from './outbound-limiter.js';

// Read the package version. Guarded so a missing/garbled package.json only affects the version display.
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}
const VERSION = readVersion();

function main() {
  const cfg = loadConfig();
  initDb(cfg);

  // The YAML file is the source of truth for MANUAL relays. Sync the DB to it:
  // relays added to the file appear in the DB; relays removed from it are dropped.
  // Harvested (10050) relays are left untouched.
  const { added, removed, total } = reconcileManualRelays(cfg);

  console.log('========================================');
  console.log(` xannyblastr v${VERSION}`);
  console.log(` admin: ${cfg.adminNpub} (${cfg.adminHex})`);
  console.log(` blastr npub: ${cfg.relayNpub ? `${cfg.relayNpub} (${cfg.relayPubkeyHex})` : 'NONE (relaySecretKey not configured)'}`);
  console.log(` accepts kinds: ${cfg.allowedKinds.join(', ')}`);
  console.log(` WoT depth: ${cfg.wotDepth}  refresh: every ${cfg.wotRefreshHours}h  (10050 sweep depth: ${cfg.harvest10050From === 'admin' ? 'admin-only' : cfg.dmRelaySweepDepth})`);
  console.log(` downstream auth key: ${cfg.secretKey ? 'configured' : 'NONE (auth-required relays will fail)'}`);
  console.log(` outbound relay limit: ${describeOutboundLimit(cfg)}`);
  console.log(
    ` manual relays (${path.basename(cfg.relaysFile)}): ${total} total  (+${added} -${removed} on boot)`
  );
  console.log('========================================');

  startRelayServer(cfg);
  startSchedulers(cfg);
}

main();