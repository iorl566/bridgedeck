// lib/local-proof.mjs —— 本机配对的双向证明（daemon 侧；扩展侧用等价实现）。
//
// 客户端证明：HMAC(token, "bridgedeck-auth-v1\n" + challenge)
// 服务端证明：HMAC(token, "bridgedeck-server-v1\n" + challenge)
// 同一 token 双向签名，扩展据此确认连的是掌握凭据的 daemon。
import crypto from 'node:crypto';

export const CLIENT_PROOF_DOMAIN = 'bridgedeck-auth-v1';
export const SERVER_PROOF_DOMAIN = 'bridgedeck-server-v1';

export function clientProof(token, challenge) {
  return crypto.createHmac('sha256', String(token || ''))
    .update(CLIENT_PROOF_DOMAIN + '\n' + String(challenge || ''))
    .digest('hex');
}

export function serverProof(token, challenge) {
  return crypto.createHmac('sha256', String(token || ''))
    .update(SERVER_PROOF_DOMAIN + '\n' + String(challenge || ''))
    .digest('hex');
}

/** 常量时间比较（长度不同直接 false）。 */
export function proofMatches(expected, actual) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(actual || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
