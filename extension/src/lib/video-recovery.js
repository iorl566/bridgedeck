// extension/src/lib/video-recovery.js —— 崩溃恢复审计与证据。
//
// 崩溃后现役恢复链路（offscreen-recovery）负责把分片/编码块拼回一个 Blob 并落库；
// 本模块在 Service Worker 侧补两层“可证明性”：
//   1) scanRecoveryCandidates：不依赖 offscreen，先扫描 OPFS manifest + 分片，
//      用 manifest seal/连续性给出结构化恢复计划（可播放前缀/缺失/截断/校验和不匹配）；
//   2) auditRecoveredRecording：对已落库的 recovered 记录再做逐片哈希 + 容器 + 帧级 + 可 seek 审计，
//      产出 problem/evidence，供 video.recover 返回与记录持久化（recording_state='recovered'）。
import { planSegmentRecovery, summarizeManifest } from './video-manifest.js';
import { verifyRecording } from './video-verify.js';
import { RECOVERY_CODES } from './video-codes.js';

export { RECOVERY_CODES };

function problem(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function dedupe(problems) {
  const seen = new Set();
  const out = [];
  for (const item of problems) {
    if (!item || typeof item !== 'object') continue;
    const key = [item.code, item.severity, item.index == null ? '' : item.index, item.scope || ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizePart(part) {
  if (!part || typeof part !== 'object') return null;
  const index = Number(part.index != null ? part.index : part.sequence);
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const sizeSource = part.bytes != null ? part.bytes : (part.blob && part.blob.size != null ? part.blob.size : part.size);
  const bytes = Number(sizeSource);
  return {
    index,
    bytes: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0,
    position: Number.isFinite(Number(part.position)) ? Number(part.position) : null,
    checksum: part.checksum || part.sha256 || '',
  };
}

/**
 * 扫描 OPFS 中的未 seal manifest 与分片，输出崩溃恢复候选与计划。
 * 依赖注入便于单测：{ listManifests, listParts, readManifest }
 */
export async function scanRecoveryCandidates(deps = {}) {
  const evidence = [];
  if (typeof deps.listManifests !== 'function') {
    evidence.push(problem(RECOVERY_CODES.SCAN_UNAVAILABLE, 'warning', '当前环境无法扫描持久化 manifest（OPFS 不可用）'));
    return { ok: false, skipped: true, count: 0, candidates: [], evidence, unsealed: 0, recoverable: 0 };
  }
  let manifests = [];
  try {
    manifests = await deps.listManifests();
  } catch (error) {
    evidence.push(problem(RECOVERY_CODES.SCAN_FAILED, 'warning', '扫描 manifest 失败', { error: String((error && error.message) || error) }));
    return { ok: false, skipped: false, count: 0, candidates: [], evidence, unsealed: 0, recoverable: 0 };
  }
  const list = Array.isArray(manifests) ? manifests.filter((item) => item && item.recordingId) : [];
  const candidates = [];
  for (const summary of list) {
    const recordingId = String(summary.recordingId || '');
    let manifest = summary;
    if (typeof deps.readManifest === 'function' && !Array.isArray(summary.segments)) {
      manifest = (await deps.readManifest(recordingId).catch(() => null)) || summary;
    }
    let parts = [];
    if (typeof deps.listParts === 'function') {
      try {
        parts = await deps.listParts(recordingId);
      } catch {
        parts = [];
      }
    }
    const availableParts = (Array.isArray(parts) ? parts : []).map(normalizePart).filter(Boolean);
    const plan = planSegmentRecovery(manifest, availableParts, { recordingId });
    const summaryOfManifest = summarizeManifest(manifest);
    const candidate = {
      recordingId,
      sealed: manifest && manifest.sealed === true,
      parts: availableParts.length,
      manifest: summaryOfManifest,
      plan,
    };
    candidates.push(candidate);
    evidence.push({
      code: plan.recovered ? RECOVERY_CODES.CANDIDATE : RECOVERY_CODES.FAILED,
      severity: plan.recovered ? 'info' : 'warning',
      recordingId,
      bytes: plan.bytes,
      segments: plan.segments || 0,
      dropped: Array.isArray(plan.droppedSegments) ? plan.droppedSegments.length : 0,
      truncated: Array.isArray(plan.truncatedSegments) ? plan.truncatedSegments.length : 0,
      reason: plan.reason,
    });
    for (const item of plan.evidence) {
      if (!item || typeof item !== 'object') continue;
      evidence.push({ ...item, scope: 'manifest', recordingId });
    }
  }
  return {
    ok: true,
    skipped: false,
    count: candidates.length,
    candidates,
    evidence: dedupe(evidence),
    unsealed: candidates.filter((item) => !item.sealed).length,
    recoverable: candidates.filter((item) => item.plan && item.plan.recovered).length,
  };
}

function manifestPartForOptions(options) {
  return Array.isArray(options.availableParts)
    ? options.availableParts.map(normalizePart).filter(Boolean)
    : [];
}

/**
 * 对已恢复记录做二次审计：逐片哈希（verifyFragments）、MP4 容器/分片日记/帧级完整性、
 * manifest 恢复计划。审计只读，结果用于 video.recover 的返回与记录持久化。
 */
export async function auditRecoveredRecording(record, options = {}) {
  const recordingId = String((record && (record.id || record.recordingId)) || options.recordingId || '');
  const evidence = [];
  let report = null;
  try {
    report = await verifyRecording(record, {
      maxAnalyzeBytes: options.maxAnalyzeBytes,
      toleranceMs: options.toleranceMs,
      strictFrames: options.strictFrames === true,
      requireComplete: false,
      cryptoImpl: options.cryptoImpl,
    });
  } catch (error) {
    evidence.push(problem(RECOVERY_CODES.AUDIT_FAILED, 'error', '恢复记录审计失败', { error: String((error && error.message) || error) }));
  }
  if (report) {
    for (const item of report.problems) evidence.push({ ...item, scope: item.scope || 'recording' });
    if (!(report.bytes > 0)) evidence.push(problem(RECOVERY_CODES.EMPTY_RECORDING, 'error', '恢复出的录制为空'));
    const container = report.container;
    const recognizable = Boolean(container && (
      container.format === 'webm'
      || container.hasFtyp === true
      || container.hasMoov === true
    ));
    if (!recognizable) {
      evidence.push(problem(RECOVERY_CODES.CONTAINER_UNKNOWN, 'error', '恢复文件不是可识别视频容器', {
        format: container ? container.format : null,
        hasFtyp: Boolean(container && container.hasFtyp),
        hasMoov: Boolean(container && container.hasMoov),
      }));
    }
  }
  let plan = null;
  const manifest = options.manifest && typeof options.manifest === 'object'
    ? options.manifest
    : (record && record.manifest && typeof record.manifest === 'object' ? record.manifest : null);
  if (manifest) {
    plan = planSegmentRecovery(manifest, manifestPartForOptions(options), { recordingId });
    for (const item of plan.evidence) evidence.push({ ...item, scope: 'manifest' });
  } else {
    evidence.push(problem(RECOVERY_CODES.MANIFEST_MISSING, 'warning', '恢复记录没有 manifest 证据（走的是 IDB/分片兜底路径）'));
  }
  const problems = dedupe(evidence);
  // 致命项：分片哈希/容器/空记录/审计异常，或 manifest 计划本身不可恢复。
  // 截断/缺片只要还能重建可播放前缀，就按 recovered/partial 落库并保留警告证据。
  const fatal = problems.filter((item) => item.severity === 'error' && (
    item.scope === 'fragments'
    || item.code === RECOVERY_CODES.EMPTY_RECORDING
    || item.code === RECOVERY_CODES.CONTAINER_UNKNOWN
    || item.code === RECOVERY_CODES.AUDIT_FAILED
  ));
  const planUnrecoverable = Boolean(plan && plan.recovered !== true);
  const ok = fatal.length === 0 && Boolean(report && report.bytes > 0) && !planUnrecoverable;
  if (ok) {
    problems.push(problem(RECOVERY_CODES.RECOVERED, 'info', '恢复文件通过完整性审计', { bytes: report ? report.bytes : 0 }));
  } else {
    problems.push(problem(RECOVERY_CODES.FAILED, 'warning', '恢复文件未通过完整性审计，按 recovered/partial 落库并保留证据', {
      errors: fatal.map((item) => item.code),
      plan_unrecoverable: planUnrecoverable,
    }));
  }
  const completeness = ok ? (plan && plan.completeness === 'complete' ? 'complete' : 'partial') : 'partial';
  return {
    ok,
    recovered: ok,
    state: ok ? 'recovered' : 'failed',
    recordingId,
    bytes: report ? report.bytes : Number(record && record.bytes) || 0,
    completeness,
    checks: {
      fragment_hashes: report ? report.verified : null,
      fragments: report ? report.chunks : 0,
      container: report ? (report.container && report.container.format) || null : null,
      journal: report ? report.journal_integrity : null,
      frames: report ? report.frames : null,
      seek: report ? report.seek : null,
      manifest: plan ? { recovered: plan.recovered, completeness: plan.completeness, segments: plan.segments || 0, bytes: plan.bytes || 0 } : null,
    },
    problems,
    evidence: problems.map((item) => ({ code: item.code, severity: item.severity, message: item.message, ...(item.index != null ? { index: item.index } : {}), ...(item.scope ? { scope: item.scope } : {}) })),
    manifestSummary: manifest ? summarizeManifest(manifest) : null,
    plan,
  };
}

/** 记录补丁：标注 recovered 状态与证据（不携带 blob，避免 RPC 响应膨胀）。 */
export function recoveryRecordPatch(audit, record = {}) {
  const source = audit && typeof audit === 'object' ? audit : {};
  const evidence = Array.isArray(source.evidence) ? source.evidence.slice(-12) : [];
  return {
    recording_state: source.state === 'failed' ? 'recovered' : (source.state || 'recovered'),
    recovered: true,
    stop_reason: 'recovered',
    completeness: 'partial',
    recovery: {
      ok: source.ok === true,
      bytes: Number(source.bytes) || Number(record.bytes) || 0,
      completeness: source.completeness || 'partial',
      checks: source.checks || null,
      plan: source.plan
        ? {
          recovered: source.plan.recovered === true,
          completeness: source.plan.completeness,
          segments: Array.isArray(source.plan.keptSegments) ? source.plan.keptSegments.length : 0,
          dropped: Array.isArray(source.plan.droppedSegments) ? source.plan.droppedSegments.length : 0,
          truncated: Array.isArray(source.plan.truncatedSegments) ? source.plan.truncatedSegments.length : 0,
          bytes: Number(source.plan.bytes) || 0,
          reason: source.plan.reason || null,
        }
        : null,
      evidence: evidence.slice(0, 8),
    },
    recording_state_evidence: evidence.slice(-8),
    ...(source.manifestSummary ? { segment_manifest: source.manifestSummary } : {}),
  };
}

/** 对外紧凑摘要（video.recover/list 用；不含 plan 明细）。 */
export function summarizeRecovery(source) {
  if (!source || typeof source !== 'object') return null;
  const plan = source.plan && typeof source.plan === 'object' ? source.plan : null;
  return {
    ok: source.ok === true,
    state: source.state || null,
    bytes: Number(source.bytes) || 0,
    completeness: source.completeness || null,
    issues: Array.isArray(source.evidence)
      ? source.evidence.length
      : (Array.isArray(source.problems) ? source.problems.length : 0),
    ...(plan
      ? {
        plan: {
          recovered: plan.recovered === true,
          completeness: plan.completeness || null,
          segments: Array.isArray(plan.keptSegments) ? plan.keptSegments.length : 0,
          dropped: Array.isArray(plan.droppedSegments) ? plan.droppedSegments.length : 0,
          truncated: Array.isArray(plan.truncatedSegments) ? plan.truncatedSegments.length : 0,
        },
      }
      : {}),
  };
}

/** 扫描结果摘要（video.recover 返回用）。 */
export function summarizeScan(scan) {
  if (!scan || typeof scan !== 'object') return null;
  return {
    ok: scan.ok === true,
    skipped: scan.skipped === true,
    candidates: scan.count || 0,
    unsealed: scan.unsealed || 0,
    recoverable: scan.recoverable || 0,
    ...(scan.restore && typeof scan.restore === 'object'
      ? {
        restore: {
          reassemble: Number(scan.restore.reassemble) || 0,
          refetch: Number(scan.restore.refetch) || 0,
          sealed: Number(scan.restore.sealed) || 0,
          impossible: Number(scan.restore.impossible) || 0,
        },
      }
      : {}),
    recordings: (Array.isArray(scan.candidates) ? scan.candidates : []).slice(0, 8).map((item) => ({
      recordingId: item.recordingId,
      sealed: item.sealed === true,
      parts: item.parts,
      manifest: item.manifest
        ? { segments: item.manifest.segments, bytes: item.manifest.bytes, sealed: item.manifest.sealed }
        : null,
      plan: item.plan
        ? { recovered: item.plan.recovered === true, completeness: item.plan.completeness, bytes: item.plan.bytes, reason: item.plan.reason }
        : null,
      ...(item.restore && typeof item.restore === 'object'
        ? {
          restore: {
            strategy: item.restore.strategy,
            nextAction: item.restore.nextAction,
            segments: item.restore.segments,
            assembledBytes: item.restore.assembledBytes,
            refetch: item.restore.refetch,
            denied: item.restore.denied,
          },
        }
        : {}),
    })),
  };
}
