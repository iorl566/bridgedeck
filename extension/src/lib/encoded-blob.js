// extension/src/lib/encoded-blob.js —— 编码分片读取/组装（从 offscreen 拆出）。
// manifest 感知：若录制期间维护了 v2 分片 manifest，则先按 manifest 规划可播放前缀
// （缺片/截断/校验和不匹配都产出证据），只组装保留下来的分片；无 manifest 时回退按 position 组装。
import { listEncodedParts, assembleEncodedParts, readSegmentManifest } from './opfs-encoded-store.js';
import { readChunks } from './offscreen-store.js';
import { planSegmentRecovery, summarizeManifest } from './video-manifest.js';
import { ENCODED_STORE_CODES } from './video-codes.js';

export async function readEncodedChunks(recordingId) {
  const id = String(recordingId || '');
  // indexedDB 不可用（node 单测/受限环境）时视为没有 IDB 分块，由调用方判定 none。
  const all = await readChunks().catch(() => []);
  return (all || [])
    .filter((item) => item && String(item.key || '').startsWith('enc:' + id + ':'))
    .sort((a, b) => Number(a.position) - Number(b.position) || Number(a.index) - Number(b.index));
}

/**
 * 组装编码录制，返回 { blob, plan, manifest, evidence, assembly }。
 * assembly：manifest（按 manifest 恢复）/ raw-fallback（manifest 不可恢复时全量拼）/
 *           raw（无 manifest）/ idb（IndexedDB 兜底）/ none。
 */
export async function assembleEncodedRecording(recordingId, options = {}) {
  const id = String(recordingId || '');
  const fsParts = await listEncodedParts(id).catch(() => []);
  const manifest = options.manifest || await readSegmentManifest(id).catch(() => null);
  if (Array.isArray(fsParts) && fsParts.length) {
    if (manifest && Array.isArray(manifest.segments) && manifest.segments.length) {
      const parts = fsParts.map((item) => ({
        index: Number(item.sequence),
        bytes: Number(item.blob && item.blob.size) || 0,
        position: Number(item.position) || 0,
      }));
      const plan = planSegmentRecovery(manifest, parts, { recordingId: id });
      if (plan.ok) {
        const kept = new Set(plan.keptSegments.map((segment) => segment.index));
        const keptParts = fsParts.filter((item) => kept.has(Number(item.sequence)));
        const full = await assembleEncodedParts(keptParts);
        const blob = full && plan.bytes > 0 && plan.bytes < full.size ? full.slice(0, plan.bytes) : full;
        return { ok: Boolean(blob), blob, plan, manifest, manifestSummary: summarizeManifest(manifest), evidence: plan.evidence, assembly: 'manifest' };
      }
      const fallback = await assembleEncodedParts(fsParts);
      return {
        ok: Boolean(fallback),
        blob: fallback,
        plan,
        manifest,
        manifestSummary: summarizeManifest(manifest),
        evidence: plan.evidence,
        assembly: 'raw-fallback',
      };
    }
    const blob = await assembleEncodedParts(fsParts);
    return {
      ok: Boolean(blob),
      blob,
      plan: null,
      manifest: manifest || null,
      manifestSummary: manifest ? summarizeManifest(manifest) : null,
      evidence: [{ code: ENCODED_STORE_CODES.MANIFEST_SEGMENTS_MISSING, severity: 'warning', message: 'manifest 没有分片描述，按 position 组装' }],
      assembly: 'raw',
    };
  }
  const chunks = await readEncodedChunks(id);
  if (!chunks.length) {
    return { ok: false, blob: null, plan: null, manifest: manifest || null, manifestSummary: null, evidence: [{ code: ENCODED_STORE_CODES.RECOVERY_NO_CHUNKS, severity: 'error', message: '没有编码分片' }], assembly: 'none' };
  }
  let total = 0;
  for (const item of chunks) total = Math.max(total, Number(item.position) + Number(item.blob.size));
  const buffer = new Uint8Array(total);
  for (const item of chunks) {
    const bytes = new Uint8Array(await item.blob.arrayBuffer());
    buffer.set(bytes, Number(item.position));
  }
  return {
    ok: true,
    blob: new Blob([buffer], { type: 'video/mp4' }),
    plan: null,
    manifest: manifest || null,
    manifestSummary: manifest ? summarizeManifest(manifest) : null,
    evidence: [{ code: ENCODED_STORE_CODES.RECOVERY_IDB_FALLBACK, severity: 'info', message: 'OPFS 不可用，使用 IndexedDB 编码分块组装' }],
    assembly: 'idb',
  };
}

export async function assembleEncodedBlob(recordingId, options = {}) {
  const result = await assembleEncodedRecording(recordingId, options);
  if (result.blob) {
    try {
      // 把组装来源/恢复计划附在 Blob 上（offscreen-recovery 忽略，SW 侧恢复审计可读）。
      result.blob.recovery = {
        assembly: result.assembly,
        plan: result.plan
          ? {
            recovered: result.plan.recovered === true,
            completeness: result.plan.completeness,
            bytes: result.plan.bytes,
            kept: Array.isArray(result.plan.keptSegments) ? result.plan.keptSegments.length : 0,
            dropped: Array.isArray(result.plan.droppedSegments) ? result.plan.droppedSegments.length : 0,
            truncated: Array.isArray(result.plan.truncatedSegments) ? result.plan.truncatedSegments.length : 0,
            reason: result.plan.reason,
          }
          : null,
        evidence: result.evidence,
      };
    } catch {
      // Blob 不可扩展时忽略（只影响证据，不影响恢复本身）
    }
  }
  return result.blob;
}
