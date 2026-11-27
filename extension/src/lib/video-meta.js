// extension/src/lib/video-meta.js —— 录制元数据/哈希/分片摘要（从 offscreen 拆出）。

export async function sha256Hex(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}
export function base64OfBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
export function journalSummary(journal) {
  if (!journal) return null;
  return {
    fragmented: journal.fragmented === true,
    init_bytes: journal.initBytes,
    fragments: Array.isArray(journal.fragments) ? journal.fragments.length : 0,
    complete_bytes: journal.completeBytes,
    trailing_bytes: journal.trailingBytes,
    complete_frames: journal.completeFrames === true,
    open_fragment: journal.openFragment === true,
  };
}
export function chunksHavePosition(items) {
  return (Array.isArray(items) ? items : []).some((item) => item && Number.isFinite(Number(item.position)));
}