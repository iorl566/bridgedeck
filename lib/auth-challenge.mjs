// lib/auth-challenge.mjs —— 本地/远程握手的 challenge-response 原语。
//
// 客户端不再发送明文 token：发送 keyId=sha256(token) 的前 32 hex，
// 服务端用 keyId 找到密钥后下发 nonce；客户端返回
// HMAC-SHA256(token, "bridgedeck-auth-v1\n" + nonce)。

import crypto from 'node:crypto';

export const AUTH_CONTEXT = 'bridgedeck-auth-v1';

export function authKeyId(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 32);
}

export function authProof(token, challenge) {
  return crypto.createHmac('sha256', String(token || ''))
    .update(AUTH_CONTEXT + '\n' + String(challenge || ''))
    .digest('hex');
}

export function verifyAuthProof(token, challenge, proof) {
  const expected = authProof(token, challenge);
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(String(proof || ''), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
