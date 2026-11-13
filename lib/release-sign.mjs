// lib/release-sign.mjs —— 发布清单签名（零依赖）。
//
// 两种模式：
//   hmac-sha256  对称密钥，适合发布机/运维自校验；不要把密钥分发到客户端。
//   ed25519      非对称签名，CI 用私钥签、客户端内置公钥验，适合公开分发。
//
// 只解决“清单和 artifact 是否被改动”，不解决密钥分发/信任根。
import crypto from 'node:crypto';

export const SIGNATURE_ALG = 'hmac-sha256';
export const SIGNATURE_ALG_ED25519 = 'ed25519';

export function canonicalRelease(manifest) {
  const artifacts = (Array.isArray(manifest && manifest.artifacts) ? manifest.artifacts : [])
    .map((item) => ({
      name: String(item.name || ''),
      file: String(item.file || ''),
      bytes: Number(item.bytes) || 0,
      sha256: String(item.sha256 || '').toLowerCase(),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

/** Ed25519 公钥指纹：SHA-256(SPKI DER) 前 16 位 hex。 */
export function publicKeyId(key) {
  const object = typeof key === 'string' || Buffer.isBuffer(key)
    ? crypto.createPublicKey(key)
    : key;
  const der = object.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function ed25519PublicKeyFromPrivate(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
}

export function signReleaseEd25519(manifest, privateKey) {
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey)
    ? crypto.createPrivateKey(privateKey)
    : privateKey;
  const value = crypto.sign(null, Buffer.from(canonicalRelease(manifest)), key).toString('base64');
  return {
    alg: SIGNATURE_ALG_ED25519,
    value,
    keyId: publicKeyId(crypto.createPublicKey(key)),
  };
}

function verifyHmac(manifest, signature, key) {
  const expected = crypto.createHmac('sha256', String(key)).update(canonicalRelease(manifest)).digest('hex');
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(String(signature.value || ''), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyEd25519(manifest, signature, publicKey) {
  try {
    const key = typeof publicKey === 'string' || Buffer.isBuffer(publicKey)
      ? crypto.createPublicKey(publicKey)
      : publicKey;
    if (signature.keyId && signature.keyId !== publicKeyId(key)) return false;
    return crypto.verify(
      null,
      Buffer.from(canonicalRelease(manifest)),
      key,
      Buffer.from(String(signature.value || ''), 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * 按清单里的 signature.alg 自动选择校验方式。
 * key 可以是 HMAC secret，也可以是 Ed25519 公钥（PEM 或 KeyObject）。
 */
export function verifyReleaseSignature(manifest, key) {
  const signature = manifest && manifest.signature;
  if (!signature || typeof signature.value !== 'string') return false;
  if (signature.alg === SIGNATURE_ALG) {
    const secret = String(key || '');
    if (!secret) return false;
    return verifyHmac(manifest, signature, secret);
  }
  if (signature.alg === SIGNATURE_ALG_ED25519) {
    if (!key) return false;
    return verifyEd25519(manifest, signature, key);
  }
  return false;
}
