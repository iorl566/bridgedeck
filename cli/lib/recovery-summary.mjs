// cli/lib/recovery-summary.mjs —— 崩溃恢复结果的 CLI 摘要（视频录制 / 长截图）。
//
// 扩展侧已经把恢复过程算成了结构化证据：
//   - 视频：`video.recover` 返回 `recording_state` / `recovery`（审计摘要）/
//     `recovery_scan`（OPFS 分片扫描摘要）/ `segment_manifest`；
//   - 长截图：`longshot.recover` 返回 `recovered` / `sealed` / `manifest` /
//     `recovery`（present/missing/duplicates/invalid/checked/hashVerified/refetch）。
//
// 但「可恢复」「部分恢复」「校验不通过」这些**结论**需要 CLI 侧统一分类，否则文本只有
// 一行“已恢复”、JSON 里全是调用方要自己拼的原始字段。本模块是纯函数：
//   classify*     → { code, label, severity }（稳定词表，文本/JSON/测试共用）
//   warnings      → 人不该忽略的事实（丢片/截断/hash 未校验/重复片…）
//   nextSteps     → 可直接复制执行的命令
//   summarize*    → 紧凑、稳定的 JSON 摘要
//   format*Lines  → 人类可读的多行摘要
//
// 稳定词表（severity）：
//   ok       全部成功，无需动作
//   notice   成功但有不影响使用的事实（例如已 sealed、旧版结果无 recovery 明细）
//   warn     可用但降级（部分分片/校验未通过/需要补片）
//   error    不可用（没有产物 / 审计失败 / 输入不是恢复结果）

import { formatBytes } from './format.mjs';

const SEVERITY = Object.freeze({
  OK: 'ok',
  NOTICE: 'notice',
  WARN: 'warn',
  ERROR: 'error',
});

const VIDEO_CLASSES = Object.freeze({
  RECOVERED_COMPLETE: 'recovered-complete',
  RECOVERED_PARTIAL: 'recovered-partial',
  RECOVERED_UNVERIFIED: 'recovered-unverified',
  AUDIT_FAILED: 'audit-failed',
  PLAN_REJECTED: 'plan-rejected',
  NOTHING_TO_RECOVER: 'nothing-to-recover',
  NO_RECORDING: 'no-recording',
  FAILED: 'failed',
});

const VIDEO_CLASS_LABELS = Object.freeze({
  'recovered-complete': '已完整恢复',
  'recovered-partial': '部分恢复（有分片缺失/截断）',
  'recovered-unverified': '已恢复但未完成独立审计',
  'audit-failed': '恢复产物审计未通过',
  'plan-rejected': '存在录制但恢复计划判定不可恢复',
  'nothing-to-recover': '扫描后没有可恢复的录制',
  'no-recording': '没有恢复结果',
  'failed': '恢复失败',
});

const LONG_CLASSES = Object.freeze({
  SEALED: 'sealed',
  COMPLETE: 'complete',
  COMPLETE_LEGACY: 'complete-legacy',
  HASH_MISMATCH: 'hash-mismatch',
  PARTIAL: 'partial',
  GAPS: 'gaps',
  NO_IMAGE: 'no-image',
  FAILED: 'failed',
});

const LONG_CLASS_LABELS = Object.freeze({
  sealed: '已封存（无需重建）',
  complete: '已完整重建（分片 hash 校验通过）',
  'complete-legacy': '已完整重建（旧版结果，无 hash 校验）',
  'hash-mismatch': '分片与 manifest 不一致（需要补片）',
  partial: '部分重建（缺片/需 refetch）',
  gaps: '重建完成但有 gaps（渲染空洞）',
  'no-image': '恢复结果没有图像数据',
  failed: '恢复失败',
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function stringsOf(value) {
  return Array.isArray(value) ? value.filter((item) => item != null && item !== '').map(String) : [];
}

/** 视频恢复记录 id（不同恢复链路可能给 id / recordingId 两种形状）。 */
export function videoRecordingId(result = {}) {
  const source = isObject(result) ? result : {};
  const record = isObject(source.record) ? source.record : {};
  return String(source.recordingId || source.recording_id || source.id || record.id || record.recordingId || '');
}

/** 视频恢复审计摘要（扩展 summarizeRecovery 的形状；缺失时返回 null）。 */
export function videoAuditSummary(result = {}) {
  const source = isObject(result) ? result : {};
  const recovery = isObject(source.recovery) ? source.recovery : null;
  if (!recovery) return null;
  const plan = isObject(recovery.plan) ? recovery.plan : null;
  return {
    ok: recovery.ok === true,
    state: recovery.state == null ? null : String(recovery.state),
    bytes: count(recovery.bytes),
    completeness: recovery.completeness == null ? null : String(recovery.completeness),
    issues: count(recovery.issues),
    plan: plan
      ? {
        recovered: plan.recovered === true,
        completeness: plan.completeness == null ? null : String(plan.completeness),
        segments: count(plan.segments),
        dropped: count(plan.dropped),
        truncated: count(plan.truncated),
      }
      : null,
  };
}

/** 视频恢复扫描摘要（扩展 summarizeScan 的形状；缺失时返回 null）。 */
export function videoScanSummary(result = {}) {
  const source = isObject(result) ? result : {};
  const scan = isObject(source.recovery_scan) ? source.recovery_scan : null;
  if (!scan) return null;
  const recordings = (Array.isArray(scan.recordings) ? scan.recordings : []).slice(0, 8).map((item) => {
    const entry = isObject(item) ? item : {};
    const manifest = isObject(entry.manifest) ? entry.manifest : null;
    const plan = isObject(entry.plan) ? entry.plan : null;
    return {
      recordingId: String(entry.recordingId || entry.id || ''),
      sealed: entry.sealed === true,
      parts: count(entry.parts),
      segments: manifest ? count(manifest.segments) : 0,
      bytes: manifest ? count(manifest.bytes) : 0,
      planRecovered: plan ? plan.recovered === true : null,
      planCompleteness: plan && plan.completeness != null ? String(plan.completeness) : null,
      planReason: plan && plan.reason != null ? String(plan.reason) : null,
    };
  });
  return {
    ok: scan.ok === true,
    skipped: scan.skipped === true,
    candidates: count(scan.candidates),
    unsealed: count(scan.unsealed),
    recoverable: count(scan.recoverable),
    recordings,
  };
}

/**
 * 视频恢复结论分类。
 * 判定顺序：失败输入 → 无可恢复 → 无产物 → 审计失败 → 计划拒绝 → 部分 → 未审计 → 完整。
 */
export function classifyVideoRecovery(result = {}) {
  const source = isObject(result) ? result : {};
  if (source.ok === false) {
    const code = String((source.error && source.error.code) || '');
    return {
      code: VIDEO_CLASSES.FAILED,
      label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.FAILED],
      severity: SEVERITY.ERROR,
      detail: code ? '错误码 ' + code : 'ok=false',
    };
  }
  const scan = videoScanSummary(source);
  const audit = videoAuditSummary(source);
  const recordingId = videoRecordingId(source);
  const rawCompleteness = source.completeness == null ? null : String(source.completeness);
  const auditCompleteness = audit && audit.completeness ? audit.completeness : null;
  const completeness = auditCompleteness || rawCompleteness;
  // 记录级完整度与审计完整度任一说 partial/failed 都算降级（两个来源都要尊重）。
  const degraded = [rawCompleteness, auditCompleteness].some((value) => value === 'partial' || value === 'failed');
  const state = String(source.recording_state || (audit && audit.state) || '');

  // 扫描结论优先：确实没有候选时，不要制造“恢复成功”的假象。
  if (scan && scan.candidates === 0) {
    return {
      code: VIDEO_CLASSES.NOTHING_TO_RECOVER,
      label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.NOTHING_TO_RECOVER],
      severity: SEVERITY.NOTICE,
      detail: scan.skipped ? '扫描被跳过' : '扫描到 0 个录制',
    };
  }
  if (!recordingId && !audit && !scan) {
    return {
      code: VIDEO_CLASSES.NO_RECORDING,
      label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.NO_RECORDING],
      severity: SEVERITY.ERROR,
      detail: '结果里没有 recordingId/recovery/recovery_scan',
    };
  }
  if (audit && audit.ok !== true) {
    return {
      code: VIDEO_CLASSES.AUDIT_FAILED,
      label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.AUDIT_FAILED],
      severity: SEVERITY.WARN,
      detail: '审计 ok=false' + (audit.issues ? '，问题 ' + audit.issues + ' 条' : ''),
    };
  }
  if (audit && audit.plan && audit.plan.recovered === false) {
    return {
      code: VIDEO_CLASSES.PLAN_REJECTED,
      label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.PLAN_REJECTED],
      severity: SEVERITY.WARN,
      detail: '恢复计划 recovered=false'
        + (audit.plan.completeness ? '（' + audit.plan.completeness + '）' : ''),
    };
  }
  const droppedByPlan = audit && audit.plan ? audit.plan.dropped : 0;
  const truncatedByPlan = audit && audit.plan ? audit.plan.truncated : 0;
  if (degraded || droppedByPlan > 0 || truncatedByPlan > 0) {
    return {
      code: VIDEO_CLASSES.RECOVERED_PARTIAL,
      label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.RECOVERED_PARTIAL],
      severity: SEVERITY.WARN,
      detail: '完整度 ' + (completeness || 'partial')
        + (droppedByPlan ? '，丢弃 ' + droppedByPlan + ' 片' : '')
        + (truncatedByPlan ? '，截断 ' + truncatedByPlan + ' 片' : ''),
    };
  }
  if (!audit) {
    return {
      code: VIDEO_CLASSES.RECOVERED_UNVERIFIED,
      label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.RECOVERED_UNVERIFIED],
      severity: SEVERITY.NOTICE,
      detail: '扩展没有返回 recovery 审计摘要',
    };
  }
  return {
    code: VIDEO_CLASSES.RECOVERED_COMPLETE,
    label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.RECOVERED_COMPLETE],
    severity: SEVERITY.OK,
    detail: state ? '状态 ' + state : '审计通过',
  };
}

/** 视频恢复里值得提醒的事实（去重、有界）。 */
export function videoRecoveryWarnings(result = {}, classification = null) {
  const source = isObject(result) ? result : {};
  const cls = classification || classifyVideoRecovery(source);
  const audit = videoAuditSummary(source);
  const scan = videoScanSummary(source);
  const warnings = [];
  if (cls.severity === SEVERITY.ERROR) warnings.push(cls.label + '：' + cls.detail);
  if (audit && audit.issues > 0) warnings.push('恢复审计记录 ' + audit.issues + ' 条问题（--json 见 result.recovery）');
  if (audit && audit.plan && audit.plan.dropped > 0) warnings.push('丢弃 ' + audit.plan.dropped + ' 个分片（缺失或损坏）');
  if (audit && audit.plan && audit.plan.truncated > 0) warnings.push('截断 ' + audit.plan.truncated + ' 个分片（尾部不完整）');
  if (audit && audit.completeness === 'failed') warnings.push('审计完整度=failed：产物可能不可播放');
  if (scan && scan.unsealed > 0 && scan.unsealed >= scan.candidates && scan.candidates > 0) {
    warnings.push('扫描到 ' + scan.unsealed + ' 个未封存录制（崩溃前未正常 stop）');
  }
  const evidence = Array.isArray(source.recording_state_evidence) ? source.recording_state_evidence : [];
  if (evidence.some((item) => item && (item.ok === false || item.error))) {
    warnings.push('状态机证据里有失败记录（--json 见 recording_state_evidence）');
  }
  // 只有在“确实有产物/候选”时才提示缺审计摘要，避免无可恢复场景误报。
  const hasProduct = Boolean(audit) || Boolean(videoRecordingId(source)) || (scan && scan.candidates > 0);
  if (!audit && hasProduct) warnings.push('没有 recovery 审计摘要：无法确认分片完整性');
  return [...new Set(warnings)];
}

/** 视频恢复后的下一步命令（按结论给，最多 4 条）。 */
export function videoRecoveryNextSteps(result = {}, classification = null) {
  const source = isObject(result) ? result : {};
  const cls = classification || classifyVideoRecovery(source);
  const id = videoRecordingId(source) || '<recordingId>';
  const steps = [];
  if (cls.code === VIDEO_CLASSES.NOTHING_TO_RECOVER) {
    return ['bridge video list：确认是否已有录制（可能已正常 stop）', 'bridge video start：重新录制'];
  }
  if (cls.severity === SEVERITY.ERROR) {
    return ['bridge video list：确认有哪些录制', 'bridge video status <recordingId>：查看录制状态', 'bridge video recover：重试恢复'];
  }
  steps.push('bridge video save ' + id + ' --out <file.mp4>：导出恢复的录制');
  if (cls.severity === SEVERITY.WARN) {
    steps.push('bridge video verify ' + id + '：逐片核对完整性');
    steps.push('bridge video recover --json：查看 recovery.plan 的丢弃/截断明细');
  } else {
    steps.push('bridge video verify ' + id + '：确认分片校验通过');
  }
  const scan = videoScanSummary(source);
  const others = scan
    ? scan.recordings.filter((item) => item.recordingId && item.recordingId !== id && item.planRecovered !== false)
    : [];
  if (others.length) steps.push('bridge video recover --json：还有 ' + others.length + ' 个候选录制可检查');
  return steps.slice(0, 4);
}

/**
 * 视频恢复的紧凑 JSON 摘要（`bridge video recover --json` 的 result.summary）。
 * 只做归一与结论，不复制扩展大字段（evidence/plan 明细仍在 result 里）。
 */
export function summarizeVideoRecovery(result = {}) {
  const source = isObject(result) ? result : {};
  const classification = classifyVideoRecovery(source);
  const audit = videoAuditSummary(source);
  const scan = videoScanSummary(source);
  return {
    kind: 'video-recovery',
    recordingId: videoRecordingId(source),
    state: String(source.recording_state || (audit && audit.state) || ''),
    completeness: (audit && audit.completeness) || (source.completeness == null ? null : String(source.completeness)),
    bytes: count(source.bytes) || (audit ? audit.bytes : 0),
    recovered: source.recovered === true || Boolean(audit),
    audit,
    scan,
    classification,
    warnings: videoRecoveryWarnings(source, classification),
    nextSteps: videoRecoveryNextSteps(source, classification),
  };
}

/** 人类可读的视频恢复摘要行（含结论/关键数据/警告/下一步）。 */
export function formatVideoRecoveryLines(result = {}) {
  const summary = summarizeVideoRecovery(result);
  const lines = ['恢复摘要：' + summary.classification.code + '（' + summary.classification.label + '）'];
  const facts = [];
  if (summary.recordingId) facts.push('录制 ' + summary.recordingId);
  if (summary.bytes > 0) facts.push(formatBytes(summary.bytes));
  if (summary.state) facts.push('状态 ' + summary.state);
  if (summary.completeness) facts.push('完整度 ' + summary.completeness);
  if (facts.length) lines.push('  ' + facts.join(' · '));
  if (summary.audit && summary.audit.plan) {
    const plan = summary.audit.plan;
    lines.push('  分片计划：保留 ' + plan.segments + ' / 丢弃 ' + plan.dropped + ' / 截断 ' + plan.truncated
      + (plan.recovered ? '（recovered=true）' : '（recovered=false）'));
  }
  if (summary.scan) {
    lines.push('  扫描：候选 ' + summary.scan.candidates + '，未封存 ' + summary.scan.unsealed
      + '，可恢复 ' + summary.scan.recoverable);
    const others = summary.scan.recordings.filter((item) => item.recordingId && item.recordingId !== summary.recordingId);
    if (others.length) {
      lines.push('  其它候选：' + others.slice(0, 4).map((item) => item.recordingId
        + (item.sealed ? '(sealed)' : '(unsealed)')
        + (item.planCompleteness && item.planCompleteness !== 'sealed' ? ' ' + item.planCompleteness : '')).join('、'));
    }
  }
  if (summary.warnings.length) {
    lines.push('  警告：');
    for (const warning of summary.warnings.slice(0, 6)) lines.push('    - ' + warning);
  }
  if (summary.nextSteps.length) {
    lines.push('  下一步：');
    for (const step of summary.nextSteps) lines.push('    - ' + step);
  }
  return lines;
}

/** 长截图恢复的分类（按 hash 校验/缺片/refetch/封存顺序判定）。 */
export function classifyLongshotRecovery(result = {}) {
  const source = isObject(result) ? result : {};
  if (source.ok === false) {
    const code = String((source.error && source.error.code) || '');
    return {
      code: LONG_CLASSES.FAILED,
      label: LONG_CLASS_LABELS[LONG_CLASSES.FAILED],
      severity: SEVERITY.ERROR,
      detail: code ? '错误码 ' + code : 'ok=false',
    };
  }
  const recovery = isObject(source.recovery) ? source.recovery : null;
  const missing = recovery ? stringsOf(recovery.missing) : [];
  const present = recovery ? stringsOf(recovery.present) : [];
  const duplicates = recovery ? stringsOf(recovery.duplicates) : [];
  const invalid = recovery ? stringsOf(recovery.invalid) : [];
  const refetch = recovery && Array.isArray(recovery.refetch) ? recovery.refetch : [];
  const checked = recovery ? count(recovery.checked) : 0;
  const hashVerified = recovery ? recovery.hashVerified : null;
  const gaps = stringsOf(source.gaps);
  const complete = source.complete === true;
  const sealed = source.sealed === true;
  const hasImage = typeof source.dataUrl === 'string' && source.dataUrl.length > 0;

  if (!hasImage) {
    return {
      code: LONG_CLASSES.NO_IMAGE,
      label: LONG_CLASS_LABELS[LONG_CLASSES.NO_IMAGE],
      severity: SEVERITY.ERROR,
      detail: 'dataUrl 为空（可能全部 tile 丢失）',
    };
  }
  if (sealed || (recovery && recovery.action === 'already-sealed')) {
    return {
      code: LONG_CLASSES.SEALED,
      label: LONG_CLASS_LABELS[LONG_CLASSES.SEALED],
      severity: SEVERITY.NOTICE,
      detail: 'action=already-sealed',
    };
  }
  if (!recovery) {
    // 旧版结果（0.3.0 形状）：只有 complete/gaps，没有分片校验。
    if (gaps.length) {
      return {
        code: LONG_CLASSES.GAPS,
        label: LONG_CLASS_LABELS[LONG_CLASSES.GAPS],
        severity: SEVERITY.WARN,
        detail: 'gaps=' + gaps.length,
      };
    }
    return {
      code: complete ? LONG_CLASSES.COMPLETE_LEGACY : LONG_CLASSES.PARTIAL,
      label: LONG_CLASS_LABELS[complete ? LONG_CLASSES.COMPLETE_LEGACY : LONG_CLASSES.PARTIAL],
      severity: complete ? SEVERITY.NOTICE : SEVERITY.WARN,
      detail: complete ? '旧版结果无 recovery 明细' : 'complete=false',
    };
  }
  if (hashVerified === false || refetch.length > 0) {
    return {
      code: LONG_CLASSES.HASH_MISMATCH,
      label: LONG_CLASS_LABELS[LONG_CLASSES.HASH_MISMATCH],
      severity: SEVERITY.WARN,
      detail: 'refetch=' + refetch.length + (missing.length ? '，missing=' + missing.length : ''),
    };
  }
  if (!complete || missing.length > 0) {
    return {
      code: LONG_CLASSES.PARTIAL,
      label: LONG_CLASS_LABELS[LONG_CLASSES.PARTIAL],
      severity: SEVERITY.WARN,
      detail: 'complete=' + complete + (missing.length ? '，missing=' + missing.length : ''),
    };
  }
  if (gaps.length) {
    return {
      code: LONG_CLASSES.GAPS,
      label: LONG_CLASS_LABELS[LONG_CLASSES.GAPS],
      severity: SEVERITY.WARN,
      detail: 'gaps=' + gaps.length,
    };
  }
  if (checked === 0 || hashVerified == null) {
    return {
      code: LONG_CLASSES.COMPLETE_LEGACY,
      label: LONG_CLASS_LABELS[LONG_CLASSES.COMPLETE_LEGACY],
      severity: SEVERITY.NOTICE,
      detail: checked ? 'hashVerified 未给出' : '未执行 hash 校验',
    };
  }
  return {
    code: LONG_CLASSES.COMPLETE,
    label: LONG_CLASS_LABELS[LONG_CLASSES.COMPLETE],
    severity: SEVERITY.OK,
    detail: 'checked=' + checked + '，hashVerified=true',
  };
}

/** 长截图恢复的紧凑 JSON 摘要（`bridge longshot recover --json` 的 result.summary）。 */
export function summarizeLongshotRecovery(result = {}) {
  const source = isObject(result) ? result : {};
  const classification = classifyLongshotRecovery(source);
  const recovery = isObject(source.recovery) ? source.recovery : null;
  const missing = recovery ? stringsOf(recovery.missing) : [];
  const duplicates = recovery ? stringsOf(recovery.duplicates) : [];
  const invalid = recovery ? stringsOf(recovery.invalid) : [];
  const refetch = recovery && Array.isArray(recovery.refetch) ? recovery.refetch : [];
  const manifest = isObject(source.manifest) ? source.manifest : null;
  return {
    kind: 'longshot-recovery',
    captureId: String(source.longshotId || source.captureId || ''),
    width: count(source.width),
    height: count(source.height),
    tiles: count(source.tiles),
    bytes: count(source.bytes),
    complete: source.complete === true,
    recovered: source.recovered === true,
    sealed: source.sealed === true,
    gaps: stringsOf(source.gaps),
    verification: recovery
      ? {
        action: recovery.action == null ? null : String(recovery.action),
        checked: count(recovery.checked),
        hashVerified: recovery.hashVerified === true ? true : (recovery.hashVerified === false ? false : null),
        present: stringsOf(recovery.present).length,
        missing,
        duplicates,
        invalid,
        refetch: refetch.length,
        nextIndex: recovery.nextIndex == null ? null : Number(recovery.nextIndex),
      }
      : null,
    manifest: manifest
      ? {
        segments: count(manifest.segments),
        bytes: count(manifest.bytes),
        dpr: manifest.dpr == null ? null : Number(manifest.dpr),
      }
      : null,
    classification,
    warnings: longshotRecoveryWarnings(source, classification),
    nextSteps: longshotRecoveryNextSteps(source, classification),
  };
}

/** 长截图恢复里值得提醒的事实。 */
export function longshotRecoveryWarnings(result = {}, classification = null) {
  const source = isObject(result) ? result : {};
  const cls = classification || classifyLongshotRecovery(source);
  const recovery = isObject(source.recovery) ? source.recovery : null;
  const warnings = [];
  if (cls.severity === SEVERITY.ERROR) warnings.push(cls.label + '：' + cls.detail);
  if (recovery) {
    const missing = stringsOf(recovery.missing);
    if (missing.length) warnings.push('缺 ' + missing.length + ' 个分片：index ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' …' : ''));
    const duplicates = stringsOf(recovery.duplicates);
    if (duplicates.length) warnings.push('重复分片 ' + duplicates.length + ' 个（已按 index 归一）');
    const invalid = stringsOf(recovery.invalid);
    if (invalid.length) warnings.push('无效分片 ' + invalid.length + ' 个（尺寸/hash 不合格）');
    const refetch = Array.isArray(recovery.refetch) ? recovery.refetch : [];
    if (refetch.length) {
      const reasons = [...new Set(refetch.map((item) => String((item && item.reason) || 'unknown')))];
      warnings.push('需 refetch ' + refetch.length + ' 片（' + reasons.slice(0, 4).join('/') + '）');
    }
    if (recovery.hashVerified === false) warnings.push('hash 校验未通过：恢复图与 manifest 不一致');
    else if (recovery.hashVerified == null) warnings.push('未执行 hash 校验（manifest 可能缺失）');
  }
  if (source.complete !== true) warnings.push('complete=false：长截图可能缺少底部内容');
  if (stringsOf(source.gaps).length) warnings.push('存在 gaps：' + stringsOf(source.gaps).length + ' 处空洞');
  return [...new Set(warnings)];
}

/** 长截图恢复后的下一步命令。 */
export function longshotRecoveryNextSteps(result = {}, classification = null) {
  const source = isObject(result) ? result : {};
  const cls = classification || classifyLongshotRecovery(source);
  const id = String(source.longshotId || source.captureId || '<longshotId>');
  if (cls.code === LONG_CLASSES.FAILED) {
    return ['bridge longshot recover ' + id + ' --out <file.png>：重试恢复', 'bridge screenshot --mode auto：重新截取整页'];
  }
  if (cls.code === LONG_CLASSES.NO_IMAGE) {
    return ['bridge longshot recover ' + id + ' --out <file.png>：重试（可能分片已清理）', 'bridge screenshot --mode auto：重新截取整页'];
  }
  const steps = ['bridge longshot recover ' + id + ' --out <file.png>：重新导出（--json 查看 summary.verification）'];
  if (cls.severity === SEVERITY.WARN) {
    steps.push('补齐缺失分片后重跑恢复（missing/refetch 见 --json）');
    steps.push('bridge screenshot --mode auto：重新截取整页作为兜底');
  } else if (cls.code === LONG_CLASSES.SEALED) {
    steps.push('bridge longshot recover ' + id + ' --out <file.png>：直接从封存分片导出');
  }
  return steps.slice(0, 3);
}

/** 人类可读的长截图恢复摘要行。 */
export function formatLongshotRecoveryLines(result = {}) {
  const summary = summarizeLongshotRecovery(result);
  const lines = ['恢复摘要：' + summary.classification.code + '（' + summary.classification.label + '）'];
  const facts = [];
  if (summary.captureId) facts.push('长截图 ' + summary.captureId);
  if (summary.width && summary.height) facts.push(summary.width + 'x' + summary.height);
  if (summary.tiles) facts.push(summary.tiles + ' tiles');
  if (summary.bytes) facts.push(formatBytes(summary.bytes));
  if (facts.length) lines.push('  ' + facts.join(' · '));
  if (summary.verification) {
    const verification = summary.verification;
    lines.push('  分片校验：action=' + (verification.action || '-')
      + ' checked=' + verification.checked
      + ' hash=' + (verification.hashVerified === true ? 'ok' : (verification.hashVerified === false ? 'mismatch' : '未校验'))
      + ' missing=' + verification.missing.length
      + ' refetch=' + verification.refetch
      + (verification.nextIndex != null ? ' nextIndex=' + verification.nextIndex : ''));
  }
  if (summary.manifest) lines.push('  manifest：' + summary.manifest.segments + ' 段 / ' + formatBytes(summary.manifest.bytes));
  if (summary.warnings.length) {
    lines.push('  警告：');
    for (const warning of summary.warnings.slice(0, 6)) lines.push('    - ' + warning);
  }
  if (summary.nextSteps.length) {
    lines.push('  下一步：');
    for (const step of summary.nextSteps) lines.push('    - ' + step);
  }
  return lines;
}

/**
 * 失败时的下一步提示（CLI 捕获到 RPC 失败时用）。
 * 只看错误码/文本，不假装拿到了扩展证据（错误链上的 evidence 会在 daemon 侧被丢弃）。
 */
export function recoveryFailureHint(error = {}) {
  const source = isObject(error) ? error : {};
  const code = String(source.code || '');
  const message = String(source.message || '');
  if (/没有可恢复|没有可恢复的录制分片/.test(message)) {
    return {
      kind: 'video-recovery',
      classification: { code: VIDEO_CLASSES.NOTHING_TO_RECOVER, label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.NOTHING_TO_RECOVER], severity: SEVERITY.NOTICE },
      nextSteps: ['bridge video list：确认是否已有录制', 'bridge video status：查看当前录制状态', 'bridge video start：重新录制'],
    };
  }
  if (code === 'E_UNKNOWN_METHOD' || code === 'E_UNSUPPORTED') {
    return {
      kind: 'video-recovery',
      classification: { code: VIDEO_CLASSES.FAILED, label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.FAILED], severity: SEVERITY.ERROR },
      nextSteps: ['扩展版本过旧：更新扩展后重试（bridge doctor 查看扩展版本）'],
    };
  }
  return {
    kind: 'video-recovery',
    classification: { code: VIDEO_CLASSES.FAILED, label: VIDEO_CLASS_LABELS[VIDEO_CLASSES.FAILED], severity: SEVERITY.ERROR },
    nextSteps: ['bridge video list：确认录制是否存在', 'bridge video recover：重试恢复'],
  };
}

export const RECOVERY_SEVERITY = SEVERITY;
export const VIDEO_RECOVERY_CLASSES = VIDEO_CLASSES;
export const LONGSHOT_RECOVERY_CLASSES = LONG_CLASSES;
