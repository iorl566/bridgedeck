import { decodeBytes, uint32 } from './local-auth-crypto.js';

export const MAX_AUTH_MESSAGE_BYTES = 4096;
export const MAX_AUTH_CREDENTIALS = 16;

function invalid() {
  throw new Error('Invalid local authentication message');
}

/** Schema checks and proof verification consume the same parsed value. */
export function parseAuthJson(text) {
  if (new TextEncoder().encode(text).length > MAX_AUTH_MESSAGE_BYTES) invalid();
  try {
    return JSON.parse(text);
  } catch {
    return invalid();
  }
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
  return value;
}
function bytes(value, length) {
  if (typeof value !== 'string') invalid();
  decodeBytes(value, length);
}
function generation(value) {
  if (typeof value !== 'number') invalid();
  uint32(value);
}
function rotation(value, commit = false) {
  const record = object(value, commit ? ['txn', 'gen', 'proof'] : ['txn', 'gen']);
  bytes(record.txn, 16);
  generation(record.gen);
  if (commit) bytes(record.proof, 32);
}
export function parseChallenge(value) {
  if (!value || typeof value !== 'object') invalid();
  switch (value.type) {
    case 'challenge': {
      const record = object(value, ['type', 'daemon_id', 'device_id', 'gen', 'server_nonce', 'server_proof']);
      bytes(record.daemon_id, 16);
      bytes(record.device_id, 16);
      generation(record.gen);
      bytes(record.server_nonce, 32);
      bytes(record.server_proof, 32);
      break;
    }
    case 'pairing_required': {
      const record = object(value, ['type', 'daemon_id', 'legacy_accepted']);
      bytes(record.daemon_id, 16);
      if (typeof record.legacy_accepted !== 'boolean') invalid();
      break;
    }
    case 'busy':
      generation(object(value, ['type', 'retry_after_ms']).retry_after_ms);
      break;
    default:
      invalid();
  }
  return value;
}
export function parseAuthMessage(text) {
  const value = parseAuthJson(text);
  if (!value || typeof value !== 'object') invalid();
  if (value.v !== 1) invalid();
  switch (value.type) {
    case 'local.auth.prove':
      bytes(object(value, ['type', 'v', 'client_proof']).client_proof, 32);
      break;
    case 'local.auth.ready': {
      const record = object(value, ['type', 'v', 'commit', 'rotation']);
      if (record.commit !== null && record.rotation !== null) invalid();
      if (record.commit !== null) rotation(record.commit, true);
      if (record.rotation !== null) rotation(record.rotation);
      break;
    }
    case 'local.auth.rejected': {
      const record = object(value, ['type', 'v', 'reason', 'browser_id']);
      if (!['already_paired', 'replace_mismatch'].includes(String(record.reason)) || typeof record.browser_id !== 'string' || !/^[\da-fA-F]{8}$/.test(record.browser_id)) invalid();
      break;
    }
    case 'local.auth.rotate_confirm': {
      const record = object(value, ['type', 'v', 'txn', 'proof']);
      bytes(record.txn, 16);
      bytes(record.proof, 32);
      break;
    }
    case 'local.auth.committed': {
      const record = object(value, ['type', 'v', 'gen', 'proof']);
      generation(record.gen);
      bytes(record.proof, 32);
      break;
    }
    default:
      invalid();
  }
  return value;
}
