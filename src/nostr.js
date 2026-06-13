import crypto from 'node:crypto';
import { verifyEvent, finalizeEvent } from 'nostr-tools/pure';
import { normalizeUrl } from './config.js';

export function makeChallenge() {
  return crypto.randomBytes(16).toString('hex');
}

export function isValidEvent(event) {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

/**
 * Validate a NIP-42 AUTH event (kind 22242) against our challenge and relay URL.
 * Returns the authenticated pubkey (hex) on success, or throws.
 */
export function validateAuthEvent(authEvent, expectedChallenge, ourRelayUrl) {
  if (!authEvent || authEvent.kind !== 22242) throw new Error('auth event must be kind 22242');
  if (!isValidEvent(authEvent)) throw new Error('auth event signature invalid');

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - authEvent.created_at) > 600) throw new Error('auth event timestamp out of range');

  const tags = authEvent.tags || [];
  const challengeTag = tags.find((t) => t[0] === 'challenge')?.[1];
  const relayTag = tags.find((t) => t[0] === 'relay')?.[1];

  if (challengeTag !== expectedChallenge) throw new Error('auth challenge mismatch');
  if (!relayTag || normalizeUrl(relayTag) !== normalizeUrl(ourRelayUrl)) {
    throw new Error('auth relay tag mismatch');
  }
  return authEvent.pubkey;
}

/**
 * Build a signed NIP-42 AUTH event so THIS relay can authenticate to a downstream
 * relay that demands it. Requires our configured secret key.
 */
export function buildAuthEvent(secretKey, relayUrl, challenge) {
  if (!secretKey) return null;
  const template = {
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relay', relayUrl],
      ['challenge', challenge],
    ],
    content: '',
  };
  return finalizeEvent(template, secretKey);
}

/** Extract the lowercase-hex pubkeys referenced by `p` tags. */
export function pTags(event) {
  return (event.tags || [])
    .filter((t) => t[0] === 'p' && typeof t[1] === 'string')
    .map((t) => t[1].toLowerCase());
}

/** Extract relay URLs advertised in a kind-10050 DM relay list. */
export function relayTagsFrom10050(event) {
  return (event.tags || [])
    .filter((t) => (t[0] === 'relay' || t[0] === 'r') && typeof t[1] === 'string')
    .map((t) => t[1]);
}
