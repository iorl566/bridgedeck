// lib/pair-proof.mjs —— 配对证明：把 token 绑定到 endpoint + 双端 nonce + scope。
import crypto from 'node:crypto';

export function normalizeEndpoint(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function randomNonce(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function pairProof(key, { endpoint, role = 'control', clientNonce = '', serverNonce = '' } = {}) {
  const endpointKey = normalizeEndpoint(endpoint);
  if (!key || !endpointKey || !clientNonce || !serverNonce) return '';
  return crypto.createHmac('sha256', String(key))
    .update([endpointKey, String(role || 'control'), String(clientNonce), String(serverNonce)].join('\n'))
    .digest('hex');
}

export function verifyPairProof(key, proof, context = {}) {
  const expected = pairProof(key, context);
  if (!expected || !proof || String(proof).length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ String(proof).charCodeAt(index);
  return diff === 0;
}
