// lib/release-sign.mjs —— 发布清单 HMAC 签名（零依赖）。
//
// 只解决“清单和 artifact 是否被改动”，不解决密钥分发/信任根；
// 密钥由调用方通过 --sign-key / --key 本地提供。

import crypto from 'node:crypto';

export const SIGNATURE_ALG = 'hmac-sha256';

export function canonicalRelease(manifest) {
  const artifacts = (Array.isArray(manifest && manifest.artifacts) ? manifest.artifacts : [])
    .map((item) => ({
      name: String(item.name || ''),
      file: String(item.file || ''),
      bytes: Number(item.bytes) || 0,
      sha256: String(item.sha256 || '').toLowerCase(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({
    version: String((manifest && manifest.version) || ''),
    artifacts,
  });
}

export function signRelease(manifest, key) {
  const secret = String(key || '');
  if (!secret) throw new Error('签名为空');
  const value = crypto.createHmac('sha256', secret).update(canonicalRelease(manifest)).digest('hex');
  return { alg: SIGNATURE_ALG, value };
}

export function verifyReleaseSignature(manifest, key) {
  const signature = manifest && manifest.signature;
  if (!signature || signature.alg !== SIGNATURE_ALG || typeof signature.value !== 'string') return false;
  const secret = String(key || '');
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(canonicalRelease(manifest)).digest('hex');
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(signature.value, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
