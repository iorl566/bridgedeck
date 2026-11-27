// src/video/hash.ts —— 分片 SHA-256 / base64 编解码 / id 生成（纯函数，Node 单测可跑）。
//
// 为什么单独一层：分片日记（每片 bytes/sha256）是 video.verify 与 recover 对齐的唯一凭据，
// 必须只有一个实现，避免 SW / offscreen / 页面各写一份导致口径漂移。

/** 摘要实现可注入：浏览器/Node 都走 globalThis.crypto.subtle；单测可换确定性 stub。 */
export interface DigestLike {
  subtle: { digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> };
}

function resolveCrypto(scope: DigestLike | undefined): DigestLike | null {
  if (scope && scope.subtle && typeof scope.subtle.digest === 'function') return scope;
  const globalCrypto = (globalThis as unknown as { crypto?: DigestLike }).crypto;
  if (globalCrypto && globalCrypto.subtle && typeof globalCrypto.subtle.digest === 'function') return globalCrypto;
  return null;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}

/** Uint8Array → ArrayBuffer（不复制可直接用的视图；Blob/crypto 的类型边界需要 ArrayBuffer）。 */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer: ArrayBufferLike = data.buffer;
  if (data.byteOffset === 0 && data.byteLength === buffer.byteLength && Object.prototype.toString.call(buffer) === '[object ArrayBuffer]') {
    return buffer as ArrayBuffer;
  }
  return data.slice().buffer;
}

/** 一段字节的 SHA-256（64 位小写十六进制）；摘要不可用时返回空串（调用方按缺失处理，不伪造）。 */
export async function sha256Hex(data: ArrayBuffer | Uint8Array, cryptoImpl?: DigestLike): Promise<string> {
  const impl = resolveCrypto(cryptoImpl);
  if (!impl) return '';
  const source: BufferSource = data instanceof Uint8Array ? toArrayBuffer(data) : data;
  try {
    const digest = await impl.subtle.digest('SHA-256', source);
    return toHex(digest);
  } catch {
    return '';
  }
}

/** Blob 的 SHA-256（分片日记用；读失败返回空串）。 */
export async function sha256OfBlob(blob: Blob, cryptoImpl?: DigestLike): Promise<string> {
  try {
    return await sha256Hex(await blob.arrayBuffer(), cryptoImpl);
  } catch {
    return '';
  }
}

/** 字节 → base64（分块避免超长参数栈溢出；video.fetch 走这条）。 */
export function base64FromBytes(bytes: Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const scope = globalThis as unknown as { btoa?: (text: string) => string };
  if (typeof scope.btoa === 'function') {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < view.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + chunk)));
    }
    return scope.btoa(binary);
  }
  // Node 单测兜底（Buffer 在浏览器里不存在，走不到这里）。
  const bufferCtor = (globalThis as unknown as { Buffer?: { from(input: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  return bufferCtor ? bufferCtor.from(view).toString('base64') : '';
}

/** base64 → 字节（recover / 单测用）。 */
export function bytesFromBase64(text: string): Uint8Array {
  const scope = globalThis as unknown as { atob?: (input: string) => string };
  if (typeof scope.atob === 'function') {
    const binary = scope.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const bufferCtor = (globalThis as unknown as { Buffer?: { from(input: string, encoding: string): Uint8Array } }).Buffer;
  if (!bufferCtor) return new Uint8Array(0);
  return new Uint8Array(bufferCtor.from(text, 'base64'));
}

/** 随机 id：优先 crypto.randomUUID，退化到时间戳 + 随机串（同一毫秒也不撞）。 */
export function newRecordingId(scope?: { randomUUID?: () => string }): string {
  const api = scope ?? (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  try {
    if (api && typeof api.randomUUID === 'function') return api.randomUUID();
  } catch {
    // 落到下面的兜底
  }
  return 'rec-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 10);
}

/** 64 位小写十六进制 SHA-256 判定（分片日记契约）。 */
export function isSha256Hex(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
