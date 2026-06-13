import path from 'node:path';
import { loadConfig } from './config.js';
import { initDb } from './db.js';
import { reconcileManualRelays } from './relays-store.js';
import { startRelayServer } from './relay-server.js';
import { startSchedulers } from './scheduler.js';
import { describeOutboundLimit } from './outbound-limiter.js';

function main() {
  const cfg = loadConfig();
  initDb(cfg);

  // The YAML file is the source of truth for MANUAL relays. Sync the DB to it:
  // relays added to the file appear in the DB; relays removed from it are dropped.
  // Harvested (10050) relays are left untouched.
  const { added, removed, total } = reconcileManualRelays(cfg);

  console.log('========================================');
  console.log(' xannyblastr');
  console.log(` admin: ${cfg.adminHex}`);
  console.log(` blastr npub: ${cfg.relayNpub || 'NONE (relaySecretKey not configured)'}`);
  console.log(` accepts kinds: ${cfg.allowedKinds.join(', ')}`);
  console.log(` WoT depth: ${cfg.wotDepth}  refresh: every ${cfg.wotRefreshHours}h`);
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
