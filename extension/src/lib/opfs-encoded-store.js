// OPFS 编码分块存储：录制期间把 MP4 写入分块直接落到扩展源私有文件系统。
// 文件名同时编码序号与文件偏移，恢复时按 position 组装；环境不支持时返回 null/空，由调用方回退 IndexedDB。
//
// 除分块外还维护 manifest（v2：分片描述 index/atMs/bytes/codec/lastFrameAt/checksum + budget + seal）：
// encoded-writer 逐段 appendEncodedSegment()，offscreen 收尾调 sealEncodedManifest()，
// video.recover 通过 scanEncodedRecordings() 在 SW 侧先扫出恢复候选与结构化证据。
import {
  VIDEO_SEGMENT_CODES,
  appendSegment as appendManifestSegment,
  createSegmentManifest,
  normalizeManifest,
  planSegmentRecovery,
  sealManifest,
  summarizeManifest,
} from './video-manifest.js';
import { patchRecord } from './video-store.js';

const DIR_NAME = 'bb-encoded-chunks';
const MANIFEST_NAME = 'manifest.json';

function pad(value, width) {
  return String(Math.max(0, Number(value) || 0)).padStart(width, '0');
}

export function encodedPartName(sequence, position) {
  return 'e-' + pad(sequence, 8) + '-' + pad(position, 12) + '.bin';
}

export function parseEncodedPartName(name) {
  const match = /^e-(\d{8})-(\d{12})\.bin$/.exec(String(name || ''));
  if (!match) return null;
  return { sequence: Number(match[1]), position: Number(match[2]) };
}

async function rootDir() {
  try {
    if (!navigator || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

async function recordingDir(recordingId, create) {
  const root = await rootDir();
  if (!root) return null;
  try {
    const base = await root.getDirectoryHandle(DIR_NAME, { create });
    return await base.getDirectoryHandle(String(recordingId), { create });
  } catch {
    return null;
  }
}

export async function writeEncodedPart(recordingId, sequence, position, data) {
  if (!recordingId || !data || !data.byteLength) return false;
  const dir = await recordingDir(recordingId, true);
  if (!dir) return false;
  try {
    const handle = await dir.getFileHandle(encodedPartName(sequence, position), { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    return true;
  } catch {
    return false;
  }
}

export async function listEncodedParts(recordingId) {
  const dir = await recordingDir(recordingId, false);
  if (!dir) return [];
  const parts = [];
  try {
    for await (const entry of dir.values()) {
      if (!entry || entry.kind !== 'file') continue;
      const meta = parseEncodedPartName(entry.name);
      if (!meta) continue;
      const file = await entry.getFile();
      parts.push({ ...meta, blob: file });
    }
  } catch {
    return [];
  }
  return parts.sort((a, b) => a.position - b.position || a.sequence - b.sequence);
}

export async function clearEncodedParts(recordingId) {
  const root = await rootDir();
  if (!root || !recordingId) return false;
  try {
    const base = await root.getDirectoryHandle(DIR_NAME, { create: false });
    await base.removeEntry(String(recordingId), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function writeJsonPart(dir, name, value) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(value));
  await writable.close();
}

async function readJsonPart(dir, name) {
  try {
    const handle = await dir.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

/** 录制开始时写 manifest；崩溃后靠它恢复元数据。 */
export async function writeEncodedManifest(recordingId, meta = {}) {
  if (!recordingId) return false;
  const dir = await recordingDir(recordingId, true);
  if (!dir) return false;
  try {
    await writeJsonPart(dir, MANIFEST_NAME, {
      version: 1,
      recordingId: String(recordingId),
      createdAt: Date.now(),
      ...meta,
    });
    return true;
  } catch {
    return false;
  }
}

export async function readEncodedManifest(recordingId) {
  const dir = await recordingDir(recordingId, false);
  if (!dir) return null;
  const manifest = await readJsonPart(dir, MANIFEST_NAME);
  // v1 = 只有录制元数据；v2 = 带分片描述/预算/seal。两者都要能读回（旧录制仍可恢复）。
  if (!manifest || (manifest.version !== 1 && manifest.version !== 2)) return null;
  return manifest;
}

/** 扫描所有残留录制目录（manifest + 至少一个分块）。 */
export async function listEncodedManifests() {
  const root = await rootDir();
  if (!root) return [];
  let base;
  try {
    base = await root.getDirectoryHandle(DIR_NAME, { create: false });
  } catch {
    return [];
  }
  const found = [];
  try {
    for await (const entry of base.values()) {
      if (!entry || entry.kind !== 'directory') continue;
      const dir = entry;
      const manifest = await readJsonPart(dir, MANIFEST_NAME);
      if (!manifest || (manifest.version !== 1 && manifest.version !== 2)) continue;
      let parts = 0;
      for await (const file of dir.values()) {
        if (file && file.kind === 'file' && parseEncodedPartName(file.name)) parts += 1;
      }
      if (parts > 0) found.push({ ...manifest, parts });
    }
  } catch {
    return found;
  }
  return found.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
}


/** 按 position 组装分块（纯函数，便于单测；缺省位置补零）。 */
export async function assembleEncodedParts(parts) {
  const list = (Array.isArray(parts) ? parts : []).filter((item) => item && item.blob && item.blob.size);
  if (!list.length) return null;
  let total = 0;
  for (const item of list) total = Math.max(total, Number(item.position) + Number(item.blob.size));
  const buffer = new Uint8Array(total);
  for (const item of list) buffer.set(new Uint8Array(await item.blob.arrayBuffer()), Number(item.position));
  return new Blob([buffer], { type: 'video/mp4' });
}

/** 校验已 close 的分块连续性/字节数（OPFS 的 durability 校验点）。 */
export async function verifyEncodedParts(recordingId) {
  const parts = await listEncodedParts(recordingId).catch(() => []);
  if (!parts.length) return { ok: false, reason: 'empty', parts: 0, bytes: 0 };
  let expected = 0;
  for (const item of parts) {
    const position = Number(item.position);
    const size = item.size != null ? Number(item.size) : Number(item.blob && item.blob.size);
    if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: 'empty_part', position, parts: parts.length, bytes: expected };
    if (position !== expected) return { ok: false, reason: 'gap', position, expected, parts: parts.length, bytes: expected };
    expected += size;
  }
  return { ok: true, parts: parts.length, bytes: expected };
}

// ---------------------------------------------------------------------------
// v2 分片 manifest：追加分片 / seal / 扫码恢复候选。
// 这些函数复用 video-manifest 的纯逻辑，只负责 OPFS 读写与 IDB 证据回写。
// ---------------------------------------------------------------------------

/** 读取并归一化 v2 manifest（v1 会被补成 v2 骨架但保留原字段）。 */
export async function readSegmentManifest(recordingId) {
  const manifest = await readEncodedManifest(recordingId);
  return manifest ? normalizeManifest(manifest) : null;
}

/** 写回 v2 manifest；目录不存在时返回 false（调用方回退 IndexedDB）。 */
export async function writeSegmentManifest(recordingId, manifest) {
  if (!recordingId || !manifest || typeof manifest !== 'object') return false;
  const dir = await recordingDir(recordingId, true);
  if (!dir) return false;
  try {
    await writeJsonPart(dir, MANIFEST_NAME, {
      ...manifest,
      version: Number(manifest.version) || 2,
      recordingId: String(recordingId),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 追加一个已落盘分片（encoded-writer 每写一块调用一次）。
 * 连续性错误返回 ok:false + 结构化问题；单段超预算只记 warning。
 */
export async function appendEncodedSegment(recordingId, segment, options = {}) {
  const id = String(recordingId || '');
  if (!id) {
    return {
      ok: false,
      code: VIDEO_SEGMENT_CODES.MANIFEST_MISSING,
      problems: [{ code: VIDEO_SEGMENT_CODES.MANIFEST_MISSING, severity: 'error', message: '缺少 recordingId' }],
      evidence: { code: VIDEO_SEGMENT_CODES.MANIFEST_MISSING },
      persisted: false,
    };
  }
  const manifest = (await readSegmentManifest(id)) || createSegmentManifest({
    recordingId: id,
    codec: options.codec,
    mime: options.mime,
    mode: options.mode,
    startedAt: options.startedAt,
    budget: options.budget,
    tabId: options.tabId,
    url: options.url,
    title: options.title,
    now: options.now,
  });
  const appended = appendManifestSegment(manifest, segment, options);
  if (!appended.ok) {
    return { ...appended, persisted: false };
  }
  const persisted = await writeSegmentManifest(id, appended.manifest);
  return { ...appended, persisted };
}

function sealPatch(sealedManifest) {
  if (!sealedManifest || typeof sealedManifest !== 'object') return null;
  const seal = sealedManifest.seal && typeof sealedManifest.seal === 'object' ? sealedManifest.seal : null;
  return {
    recording_state: 'sealed',
    sealed: true,
    ...(sealedManifest.sealedAt ? { sealedAt: sealedManifest.sealedAt } : {}),
    segment_manifest: summarizeManifest(sealedManifest),
    ...(seal
      ? {
        seal: {
          digest: String(seal.digest || ''),
          at: Number(seal.at) || 0,
          segments: Number(seal.segments) || 0,
          bytes: Number(seal.segmentsBytes) || 0,
          durability: String(seal.durability || 'unknown'),
        },
      }
      : {}),
  };
}

/**
 * seal manifest：连续性校验通过后落 sealed manifest，并把 seal 摘要回写 IDB 记录
 * （offscreen 随后会 clearEncodedParts，记录里的 seal 摘要是最后的 durability 证据）。
 */
export async function sealEncodedManifestDetailed(recordingId, meta = {}) {
  const id = String(recordingId || '');
  const manifest = await readSegmentManifest(id);
  if (!manifest) {
    return {
      ok: false,
      code: VIDEO_SEGMENT_CODES.MANIFEST_MISSING,
      evidence: { code: VIDEO_SEGMENT_CODES.MANIFEST_MISSING, recordingId: id },
      problems: [{ code: VIDEO_SEGMENT_CODES.MANIFEST_MISSING, severity: 'warning', message: '没有 manifest 可 seal' }],
      persisted: false,
    };
  }
  const sealResult = await sealManifest(manifest, {
    at: Number(meta.sealedAt) || Date.now(),
    meta: {
      ...(meta && typeof meta === 'object' ? meta : {}),
      ...(meta.endedAt ? { endedAt: Number(meta.endedAt) } : {}),
      ...(meta.bytes ? { bytes: Number(meta.bytes) } : {}),
      ...(meta.mode ? { mode: String(meta.mode) } : {}),
    },
  });
  if (!sealResult.ok) {
    return { ...sealResult, persisted: false, loaded: manifest };
  }
  const persisted = await writeSegmentManifest(id, sealResult.sealed);
  let patched = null;
  if (persisted) {
    const patch = sealPatch(sealResult.sealed);
    if (patch) patched = await patchRecord(id, patch).catch(() => null);
  }
  return {
    ok: true,
    sealed: true,
    manifest: sealResult.sealed,
    evidence: sealResult.evidence,
    problems: sealResult.problems,
    persisted,
    patched: patched != null,
  };
}

/** 描述一条 OPFS 录制：manifest + 分片实际大小 + 恢复计划（不组装 Blob）。 */
export async function describeEncodedRecording(recordingId) {
  const id = String(recordingId || '');
  const manifest = await readSegmentManifest(id);
  const listed = await listEncodedParts(id).catch(() => []);
  const parts = (Array.isArray(listed) ? listed : []).map((item) => ({
    index: Number(item.sequence),
    bytes: Number(item.blob && item.blob.size) || 0,
    position: Number(item.position) || 0,
  }));
  const plan = manifest ? planSegmentRecovery(manifest, parts, { recordingId: id }) : null;
  return {
    recordingId: id,
    manifest,
    summary: manifest ? summarizeManifest(manifest) : null,
    parts,
    plan,
    evidence: plan ? plan.evidence : [],
  };
}

/** 扫描当前所有残留录制目录（供 video.recover 在调用 offscreen 前产出证据）。 */
export async function scanEncodedRecordings() {
  const manifests = await listEncodedManifests().catch(() => []);
  const recordings = [];
  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    if (!manifest || !manifest.recordingId) continue;
    const described = await describeEncodedRecording(manifest.recordingId);
    if (described.manifest) recordings.push(described);
  }
  return recordings;
}

/** 成功后标记 manifest 已封存；恢复时跳过，避免重复恢复。 */
export async function sealEncodedManifest(recordingId, meta = {}) {
  const detailed = await sealEncodedManifestDetailed(recordingId, meta).catch(() => null);
  if (detailed && detailed.ok) return true;
  // 兼容旧行为：没有 manifest（或 seal 被拒绝）时仍标记 sealed 字段，避免重复恢复。
  const manifest = await readEncodedManifest(recordingId);
  if (!manifest) return false;
  return writeEncodedManifest(recordingId, { ...manifest, ...meta, sealed: true });
}
