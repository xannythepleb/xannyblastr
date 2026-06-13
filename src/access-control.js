import { isInWot, isContacted, addContacted } from './db.js';
import { pTags } from './nostr.js';

/**
 * Decide whether an AUTHENTICATED connection (authedPubkey) may publish `event`.
 *
 * IMPORTANT: authorization is keyed on the NIP-42 authenticated pubkey, NOT on
 * event.pubkey. Gift wraps (kind 1059) are signed by ephemeral keys, so the
 * event author tells us nothing about who is really sending.
 *
 * Rules:
 *   - admin                       -> allowed
 *   - in web of trust (deg 1/2)   -> allowed
 *   - previously DM'd by admin    -> allowed, but ONLY to send a 1059 back to admin
 *   - everyone else               -> denied
 */
export function authorizeWrite({ authedPubkey, event, adminHex }) {
  if (!authedPubkey) {
    return { allowed: false, reason: 'auth-required: authenticate (NIP-42) before publishing' };
  }
  const pk = authedPubkey.toLowerCase();

  if (pk === adminHex) return { allowed: true };

  if (isInWot(pk)) return { allowed: true };

  if (isContacted(pk)) {
    // Outside the WoT but the admin reached out first. They may only reply TO the admin.
    if (event.kind === 1059 && pTags(event).includes(adminHex)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: 'restricted: contacted users may only send gift wrapped replies to the admin',
    };
  }

  return { allowed: false, reason: 'restricted: not in admin web of trust' };
}

/**
 * When the admin publishes a 1059, record its recipients so they can reply later.
 * Called only after a successful, authorized admin write.
 */
export function recordAdminOutreach({ authedPubkey, event, adminHex }) {
  if (authedPubkey?.toLowerCase() !== adminHex) return;
  if (event.kind !== 1059) return;
  for (const recipient of pTags(event)) {
    if (recipient !== adminHex) addContacted(recipient);
  }
}
