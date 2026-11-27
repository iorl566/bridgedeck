// src/video/manifest.ts —— 录制清单（manifest）：分片清单 + 收尾封条（seal）的唯一格式。
//
// 与 extension/src/lib/video-manifest.js 的用途一致：完整性/恢复靠清单对齐「声明值」与「实测值」，
// 这里只保留 video.* 服务与 recover 需要的子集（版本、分片清单、字节、faststart、存储后端）。

import { isSha256Hex } from './hash.ts';
import type { Completeness, FragmentEntry, StorageBackend, StopReason } from './types.ts';

export const VIDEO_MANIFEST_VERSION = 1;

export interface VideoManifest {
  version: number;
  recordingId: string;
  mime: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
  completeness: Completeness;
  stopReason: StopReason;
  finishVia: string;
  faststart: boolean;
  fragmentCount: number;
  fragments: FragmentEntry[];
  completeBytes: number;
  storageBackend: StorageBackend;
  sealedAt: number;
}

export interface ManifestInput {
  recordingId: string;
  mime: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
  completeness: Completeness;
  stopReason: StopReason;
  finishVia: string;
  faststart: boolean;
  fragments: FragmentEntry[];
  completeBytes: number;
  storageBackend: StorageBackend;
}

/** 构建清单（fragmentCount / sealedAt 由这里派生，避免调用方各算一份）。 */
export function buildManifest(input: ManifestInput): VideoManifest {
  return {
    version: VIDEO_MANIFEST_VERSION,
    recordingId: String(input.recordingId),
    mime: String(input.mime),
    startedAt: Number(input.startedAt) || 0,
    endedAt: Number(input.endedAt) || 0,
    bytes: Number(input.bytes) || 0,
    completeness: input.completeness === 'complete' ? 'complete' : 'partial',
    stopReason: input.stopReason,
    finishVia: String(input.finishVia || 'main'),
    faststart: input.faststart === true,
    fragmentCount: Array.isArray(input.fragments) ? input.fragments.length : 0,
    fragments: Array.isArray(input.fragments) ? input.fragments.map((item) => ({ ...item })) : [],
    completeBytes: Number(input.completeBytes) || 0,
    storageBackend: input.storageBackend === 'indexeddb' ? 'indexeddb' : 'memory',
    sealedAt: Number(input.endedAt) || 0,
  };
}

export interface ManifestProblem {
  code: string;
  message: string;
  [key: string]: unknown;
}

/** 校验清单：只判定结构/对齐，不重读 blob；问题列表由调用方决定是否致命。 */
export function validateManifest(raw: unknown): { ok: boolean; problems: ManifestProblem[] } {
  const problems: ManifestProblem[] = [];
  const bag = raw && typeof raw === 'object' ? raw as Partial<VideoManifest> : null;
  if (!bag) return { ok: false, problems: [{ code: 'MANIFEST_MISSING', message: '缺少清单' }] };
  if (bag.version !== VIDEO_MANIFEST_VERSION) problems.push({ code: 'MANIFEST_VERSION', message: '清单版本不匹配', version: bag.version });
  if (typeof bag.recordingId !== 'string' || !bag.recordingId) problems.push({ code: 'MANIFEST_ID', message: '清单缺少 recordingId' });
  const fragments = Array.isArray(bag.fragments) ? bag.fragments : [];
  const sum = fragments.reduce((total, item) => total + (Number(item?.bytes) || 0), 0);
  if (sum !== Number(bag.bytes)) problems.push({ code: 'MANIFEST_BYTES', message: '清单字节与分片之和不一致', declared: Number(bag.bytes), measured: sum });
  if (Number(bag.fragmentCount) !== fragments.length) problems.push({ code: 'MANIFEST_COUNT', message: '清单分片数与清单列表不一致', fragmentCount: bag.fragmentCount, actual: fragments.length });
  for (const fragment of fragments) {
    if (!isSha256Hex(fragment?.sha256)) {
      problems.push({ code: 'MANIFEST_FRAGMENT_HASH', message: '清单分片缺少 SHA-256', index: fragment?.index });
      break;
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 清单摘要（verify/status 用；不返回分片全量时用这个）。 */
export function summarizeManifest(manifest: VideoManifest | null | undefined): Record<string, unknown> | null {
  if (!manifest) return null;
  return {
    version: manifest.version,
    recordingId: manifest.recordingId,
    bytes: manifest.bytes,
    fragmentCount: manifest.fragmentCount,
    completeBytes: manifest.completeBytes,
    faststart: manifest.faststart,
    completeness: manifest.completeness,
    stopReason: manifest.stopReason,
    finishVia: manifest.finishVia,
    storageBackend: manifest.storageBackend,
    sealedAt: manifest.sealedAt,
  };
}
