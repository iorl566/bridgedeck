// tests/unit/cli-recovery-summary.test.mjs —— `bridge video recover` / `bridge longshot recover`
// 的 CLI 摘要分类（cli/lib/recovery-summary.mjs）。纯函数：夹具直接按扩展 RPC 返回的形状构造。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LONGSHOT_RECOVERY_CLASSES,
  RECOVERY_SEVERITY,
  VIDEO_RECOVERY_CLASSES,
  classifyLongshotRecovery,
  classifyVideoRecovery,
  formatLongshotRecoveryLines,
  formatVideoRecoveryLines,
  longshotRecoveryNextSteps,
  longshotRecoveryWarnings,
  recoveryFailureHint,
  summarizeLongshotRecovery,
  summarizeVideoRecovery,
  videoAuditSummary,
  videoRecoveryNextSteps,
  videoRecoveryWarnings,
  videoRecordingId,
  videoScanSummary,
} from '../../cli/lib/recovery-summary.mjs';

function videoResult(overrides = {}) {
  return {
    ok: true,
    id: 'rec-abc',
    bytes: 2048,
    mime: 'video/webm',
    completeness: 'complete',
    recording_state: 'recovered',
    recording_state_evidence: [{ from: 'recording', to: 'recovered', at: 1 }],
    recovery: {
      ok: true,
      state: 'recovered',
      bytes: 2048,
      completeness: 'complete',
      issues: 0,
      plan: { recovered: true, completeness: 'complete', segments: 10, dropped: 0, truncated: 0 },
    },
    recovery_scan: {
      ok: true,
      skipped: false,
      candidates: 2,
      unsealed: 1,
      recoverable: 1,
      recordings: [
        {
          recordingId: 'rec-abc',
          sealed: false,
          parts: 10,
          manifest: { segments: 10, bytes: 2048, sealed: false },
          plan: { recovered: true, completeness: 'complete', bytes: 2048, reason: null },
        },
        {
          recordingId: 'rec-old',
          sealed: true,
          parts: 4,
          manifest: { segments: 4, bytes: 1000, sealed: true },
          plan: { recovered: false, completeness: 'sealed', bytes: 1000, reason: 'already-sealed' },
        },
      ],
    },
    ...overrides,
  };
}

function longshotResult(overrides = {}) {
  return {
    ok: true,
    longshotId: 'ls-1',
    width: 800,
    height: 3000,
    tiles: 11,
    complete: true,
    recovered: true,
    sealed: false,
    manifest: { segments: 11, bytes: 9000, dpr: 2 },
    recovery: {
      action: 'rebuild',
      present: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
      missing: [],
      duplicates: [],
      invalid: [],
      checked: 11,
      hashVerified: true,
      refetch: [],
      nextIndex: 11,
    },
    gaps: [],
    bytes: 9000,
    dataUrl: 'data:image/png;base64,AAAA',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 视频：id / audit / scan 归一
// ---------------------------------------------------------------------------

test('videoRecordingId 兼容 id/recordingId/record.id 三种形状', () => {
  assert.equal(videoRecordingId({ id: 'a' }), 'a');
  assert.equal(videoRecordingId({ recordingId: 'b' }), 'b');
  assert.equal(videoRecordingId({ record: { id: 'c' } }), 'c');
  assert.equal(videoRecordingId({ recording_id: 'd' }), 'd');
  assert.equal(videoRecordingId(null), '');
});

test('videoAuditSummary：把 summarizeRecovery 形状归一成 plan 计数', () => {
  const audit = videoAuditSummary(videoResult());
  assert.equal(audit.ok, true);
  assert.equal(audit.state, 'recovered');
  assert.equal(audit.bytes, 2048);
  assert.equal(audit.completeness, 'complete');
  assert.deepEqual(audit.plan, { recovered: true, completeness: 'complete', segments: 10, dropped: 0, truncated: 0 });
  assert.equal(videoAuditSummary({}), null);
  assert.equal(videoAuditSummary({ recovery: { ok: true } }).plan, null);
});

test('videoScanSummary：有界保留候选（最多 8 条）并归一 manifest/plan', () => {
  const many = videoResult({
    recovery_scan: {
      ok: true,
      skipped: false,
      candidates: 12,
      unsealed: 3,
      recoverable: 9,
      recordings: Array.from({ length: 12 }, (_, index) => ({ recordingId: 'r' + index, sealed: index % 2 === 0, parts: index })),
    },
  });
  const scan = videoScanSummary(many);
  assert.equal(scan.candidates, 12);
  assert.equal(scan.recordings.length, 8);
  assert.equal(scan.recordings[1].recordingId, 'r1');
  assert.equal(scan.recordings[1].sealed, false);
  assert.equal(videoScanSummary({}), null);
});

// ---------------------------------------------------------------------------
// 视频：分类 / 警告 / 下一步
// ---------------------------------------------------------------------------

test('classifyVideoRecovery：完整恢复是 ok，且 detail 带状态', () => {
  const classification = classifyVideoRecovery(videoResult());
  assert.equal(classification.code, VIDEO_RECOVERY_CLASSES.RECOVERED_COMPLETE);
  assert.equal(classification.severity, RECOVERY_SEVERITY.OK);
  assert.match(classification.detail, /recovered/);
});

test('classifyVideoRecovery：completeness=partial 或丢片/截断 → warn 部分恢复', () => {
  for (const overrides of [
    { completeness: 'partial', recovery: { ok: true, state: 'recovered', bytes: 1, completeness: 'partial', issues: 0, plan: { recovered: true, completeness: 'partial', segments: 3, dropped: 0, truncated: 0 } } },
    { recovery: { ok: true, state: 'recovered', bytes: 1, completeness: 'complete', issues: 0, plan: { recovered: true, completeness: 'complete', segments: 3, dropped: 2, truncated: 0 } } },
    { recovery: { ok: true, state: 'recovered', bytes: 1, completeness: 'complete', issues: 0, plan: { recovered: true, completeness: 'complete', segments: 3, dropped: 0, truncated: 1 } } },
  ]) {
    const classification = classifyVideoRecovery(videoResult(overrides));
    assert.equal(classification.code, VIDEO_RECOVERY_CLASSES.RECOVERED_PARTIAL, JSON.stringify(overrides));
    assert.equal(classification.severity, RECOVERY_SEVERITY.WARN);
  }
});

test('classifyVideoRecovery：审计失败 / 计划拒绝 / 无可恢复 / 失败输入', () => {
  const auditFailed = classifyVideoRecovery(videoResult({ recovery: { ok: false, state: 'recovered', bytes: 10, completeness: 'partial', issues: 3, plan: null } }));
  assert.equal(auditFailed.code, VIDEO_RECOVERY_CLASSES.AUDIT_FAILED);
  assert.equal(auditFailed.severity, RECOVERY_SEVERITY.WARN);
  assert.match(auditFailed.detail, /问题 3 条/);

  const planRejected = classifyVideoRecovery(videoResult({
    recovery: { ok: true, state: 'recovered', bytes: 10, completeness: 'partial', issues: 0, plan: { recovered: false, completeness: 'failed', segments: 0, dropped: 0, truncated: 0 } },
  }));
  assert.equal(planRejected.code, VIDEO_RECOVERY_CLASSES.PLAN_REJECTED);

  const emptyScan = classifyVideoRecovery({ ok: true, recovery_scan: { ok: true, skipped: true, candidates: 0, unsealed: 0, recoverable: 0, recordings: [] } });
  assert.equal(emptyScan.code, VIDEO_RECOVERY_CLASSES.NOTHING_TO_RECOVER);
  assert.equal(emptyScan.severity, RECOVERY_SEVERITY.NOTICE);

  const failed = classifyVideoRecovery({ ok: false, error: { code: 'E_TIMEOUT', message: 'x' } });
  assert.equal(failed.code, VIDEO_RECOVERY_CLASSES.FAILED);
  assert.equal(failed.severity, RECOVERY_SEVERITY.ERROR);
  assert.match(failed.detail, /E_TIMEOUT/);

  const noResult = classifyVideoRecovery({});
  assert.equal(noResult.code, VIDEO_RECOVERY_CLASSES.NO_RECORDING);
});

test('videoRecoveryWarnings：去重且不重复分类 detail', () => {
  const partial = videoResult({
    completeness: 'partial',
    recovery: { ok: true, state: 'recovered', bytes: 1, completeness: 'partial', issues: 4, plan: { recovered: true, completeness: 'partial', segments: 5, dropped: 2, truncated: 1 } },
  });
  const warnings = videoRecoveryWarnings(partial);
  assert.ok(warnings.length >= 3);
  assert.equal(new Set(warnings).size, warnings.length);
  assert.ok(warnings.some((line) => line.includes('丢弃 2 个分片')));
  assert.ok(warnings.some((line) => line.includes('截断 1 个分片')));
  // 同一函数用已算好的分类不重复计算也能得到同样结果。
  assert.deepEqual(videoRecoveryWarnings(partial, classifyVideoRecovery(partial)), warnings);
});

test('videoRecoveryNextSteps：给出可直接执行的 save/verify 命令', () => {
  const steps = videoRecoveryNextSteps(videoResult());
  assert.ok(steps.some((step) => step.includes('bridge video save rec-abc --out')));
  assert.ok(steps.some((step) => step.includes('bridge video verify rec-abc')));
  assert.ok(steps.length <= 4);

  const partialSteps = videoRecoveryNextSteps(videoResult({ completeness: 'partial' }));
  assert.ok(partialSteps.some((step) => step.includes('bridge video recover --json')));

  const missingId = videoRecoveryNextSteps({ ok: true, recovery: { ok: true } });
  assert.ok(missingId.some((step) => step.includes('<recordingId>')));

  const nothing = videoRecoveryNextSteps({ ok: true, recovery_scan: { candidates: 0, skipped: false, recordings: [] } });
  assert.ok(nothing.some((step) => step.includes('bridge video list')));
});

// ---------------------------------------------------------------------------
// 视频：JSON 摘要与文本
// ---------------------------------------------------------------------------

test('summarizeVideoRecovery：稳定 JSON 形状且不复制大字段', () => {
  const summary = summarizeVideoRecovery(videoResult());
  assert.equal(summary.kind, 'video-recovery');
  assert.equal(summary.recordingId, 'rec-abc');
  assert.equal(summary.state, 'recovered');
  assert.equal(summary.completeness, 'complete');
  assert.equal(summary.bytes, 2048);
  assert.equal(summary.recovered, true);
  assert.equal(summary.scan.candidates, 2);
  assert.deepEqual(Object.keys(summary.classification).sort(), ['code', 'detail', 'label', 'severity']);
  assert.ok(summary.nextSteps.length > 0);
  // 不允许把扩展的 evidence/plan 明细整段抄进摘要（避免 --json 体积膨胀）。
  assert.equal(Object.hasOwn(summary, 'recording_state_evidence'), false);
  assert.equal(Object.hasOwn(summary, 'recovery'), false);
});

test('summarizeVideoRecovery 幂等：同一输入两次调用深相等', () => {
  const input = videoResult();
  assert.deepEqual(summarizeVideoRecovery(input), summarizeVideoRecovery(input));
});

test('formatVideoRecoveryLines：结论/分片计划/扫描/警告/下一步齐全', () => {
  const partial = videoResult({
    completeness: 'partial',
    recovery: { ok: true, state: 'recovered', bytes: 2048, completeness: 'partial', issues: 2, plan: { recovered: true, completeness: 'partial', segments: 10, dropped: 2, truncated: 1 } },
  });
  const text = formatVideoRecoveryLines(partial).join('\n');
  assert.match(text, /恢复摘要：recovered-partial（/);
  assert.match(text, /录制 rec-abc/);
  assert.match(text, /完整度 partial/);
  assert.match(text, /分片计划：保留 10 \/ 丢弃 2 \/ 截断 1/);
  assert.match(text, /扫描：候选 2，未封存 1，可恢复 1/);
  assert.match(text, /其它候选：rec-old\(sealed\)/);
  assert.match(text, /下一步：/);
  assert.match(text, /bridge video save rec-abc/);
});

test('formatVideoRecoveryLines：无可恢复时不伪造成功文案', () => {
  const text = formatVideoRecoveryLines({ ok: true, recovery_scan: { ok: true, skipped: false, candidates: 0, unsealed: 0, recoverable: 0, recordings: [] } }).join('\n');
  assert.match(text, /nothing-to-recover/);
  assert.match(text, /bridge video list/);
  assert.doesNotMatch(text, /已完整恢复/);
});

test('视频摘要容忍非对象/空输入', () => {
  assert.equal(summarizeVideoRecovery(null).kind, 'video-recovery');
  assert.equal(summarizeVideoRecovery(undefined).recordingId, '');
  assert.deepEqual(summarizeVideoRecovery('x').warnings.length > 0, true);
  assert.equal(formatVideoRecoveryLines(null).length > 1, true);
});

// ---------------------------------------------------------------------------
// 长截图：分类
// ---------------------------------------------------------------------------

test('classifyLongshotRecovery：已封存/完整/旧版三种通过态', () => {
  const sealed = classifyLongshotRecovery(longshotResult({ sealed: true, recovery: { action: 'already-sealed', present: [], missing: [], duplicates: [], invalid: [], checked: 0, hashVerified: null, refetch: [] } }));
  assert.equal(sealed.code, LONGSHOT_RECOVERY_CLASSES.SEALED);
  assert.equal(sealed.severity, RECOVERY_SEVERITY.NOTICE);

  const complete = classifyLongshotRecovery(longshotResult());
  assert.equal(complete.code, LONGSHOT_RECOVERY_CLASSES.COMPLETE);
  assert.equal(complete.severity, RECOVERY_SEVERITY.OK);

  const legacy = classifyLongshotRecovery({ ok: true, complete: true, tiles: 3, dataUrl: 'data:image/png;base64,AA' });
  assert.equal(legacy.code, LONGSHOT_RECOVERY_CLASSES.COMPLETE_LEGACY);
  assert.equal(legacy.severity, RECOVERY_SEVERITY.NOTICE);
});

test('classifyLongshotRecovery：hash 不一致优先于 complete', () => {
  const mismatch = classifyLongshotRecovery(longshotResult({
    complete: false,
    recovery: { action: 'rebuild-partial', present: ['0'], missing: ['3', '7'], duplicates: [], invalid: [], checked: 1, hashVerified: false, refetch: [{ index: 3, reason: 'mismatch' }, { index: 7, reason: 'missing' }] },
  }));
  assert.equal(mismatch.code, LONGSHOT_RECOVERY_CLASSES.HASH_MISMATCH);
  assert.equal(mismatch.severity, RECOVERY_SEVERITY.WARN);
  assert.match(mismatch.detail, /refetch=2/);
});

test('classifyLongshotRecovery：缺片 → partial（即使 complete 标记为 true）', () => {
  const partial = classifyLongshotRecovery(longshotResult({
    complete: true,
    recovery: { action: 'rebuild', present: ['0'], missing: ['1'], duplicates: [], invalid: [], checked: 1, hashVerified: null, refetch: [] },
  }));
  assert.equal(partial.code, LONGSHOT_RECOVERY_CLASSES.PARTIAL);
});

test('classifyLongshotRecovery：空图/失败/有 gaps', () => {
  assert.equal(classifyLongshotRecovery({ ok: true, complete: true, dataUrl: '' }).code, LONGSHOT_RECOVERY_CLASSES.NO_IMAGE);
  assert.equal(classifyLongshotRecovery({ ok: false, error: { code: 'E_NOT_FOUND' } }).code, LONGSHOT_RECOVERY_CLASSES.FAILED);
  const gaps = classifyLongshotRecovery({ ok: true, complete: true, dataUrl: 'data:image/png;base64,AA', gaps: ['y=10'] });
  assert.equal(gaps.code, LONGSHOT_RECOVERY_CLASSES.GAPS);
  assert.equal(gaps.severity, RECOVERY_SEVERITY.WARN);
});

test('longshotRecoveryWarnings：缺片/refetch/hash 三类事实都报到', () => {
  const warnings = longshotRecoveryWarnings(longshotResult({
    complete: false,
    gaps: ['y=100'],
    recovery: { action: 'rebuild-partial', present: ['0'], missing: ['1', '2'], duplicates: ['0'], invalid: ['9'], checked: 1, hashVerified: null, refetch: [{ index: 1, reason: 'missing' }] },
  }));
  assert.ok(warnings.some((line) => line.includes('缺 2 个分片')));
  assert.ok(warnings.some((line) => line.includes('重复分片 1 个')));
  assert.ok(warnings.some((line) => line.includes('无效分片 1 个')));
  assert.ok(warnings.some((line) => line.includes('需 refetch 1 片')));
  assert.ok(warnings.some((line) => line.includes('未执行 hash 校验')));
  assert.ok(warnings.some((line) => line.includes('complete=false')));
  assert.ok(warnings.some((line) => line.includes('gaps')));
});

test('longshotRecoveryNextSteps：部分恢复给出补片与重新截取兜底', () => {
  const steps = longshotRecoveryNextSteps(longshotResult({
    complete: false,
    recovery: { action: 'rebuild-partial', present: [], missing: ['1'], duplicates: [], invalid: [], checked: 0, hashVerified: false, refetch: [{ index: 1, reason: 'missing' }] },
  }));
  assert.ok(steps[0].includes('bridge longshot recover ls-1 --out'));
  assert.ok(steps.some((step) => step.includes('补齐缺失分片')));
  assert.ok(steps.some((step) => step.includes('bridge screenshot --mode auto')));
});

// ---------------------------------------------------------------------------
// 长截图：JSON 摘要与文本
// ---------------------------------------------------------------------------

test('summarizeLongshotRecovery：verification/manifest 归一，不含 dataUrl', () => {
  const partial = longshotResult({
    complete: false,
    recovery: { action: 'rebuild-partial', present: ['0'], missing: ['3'], duplicates: ['1'], invalid: [], checked: 1, hashVerified: false, refetch: [{ index: 3, reason: 'mismatch' }], nextIndex: 12 },
  });
  const summary = summarizeLongshotRecovery(partial);
  assert.equal(summary.kind, 'longshot-recovery');
  assert.equal(summary.captureId, 'ls-1');
  assert.equal(summary.verification.missing[0], '3');
  assert.equal(summary.verification.hashVerified, false);
  assert.equal(summary.verification.refetch, 1);
  assert.equal(summary.verification.nextIndex, 12);
  assert.deepEqual(summary.manifest, { segments: 11, bytes: 9000, dpr: 2 });
  assert.equal(Object.hasOwn(summary, 'dataUrl'), false);
});

test('formatLongshotRecoveryLines：校验/警告/下一步可读', () => {
  const text = formatLongshotRecoveryLines(longshotResult({
    complete: false,
    recovery: { action: 'rebuild-partial', present: ['0'], missing: ['3'], duplicates: [], invalid: [], checked: 1, hashVerified: false, refetch: [{ index: 3, reason: 'mismatch' }] },
  })).join('\n');
  assert.match(text, /恢复摘要：hash-mismatch（/);
  assert.match(text, /长截图 ls-1 · 800x3000 · 11 tiles/);
  assert.match(text, /hash=mismatch/);
  assert.match(text, /manifest：11 段/);
  assert.match(text, /补齐缺失分片/);
});

// ---------------------------------------------------------------------------
// 失败提示
// ---------------------------------------------------------------------------

test('recoveryFailureHint：没有可恢复分片 → 提示 list/status/start 而非重试轰炸', () => {
  const hint = recoveryFailureHint({ code: 'E_INTERNAL', message: '没有可恢复的录制分片' });
  assert.equal(hint.classification.code, VIDEO_RECOVERY_CLASSES.NOTHING_TO_RECOVER);
  assert.ok(hint.nextSteps.some((step) => step.includes('bridge video list')));
  assert.equal(recoveryFailureHint({ code: 'E_UNKNOWN_METHOD', message: 'unknown method' }).nextSteps[0].includes('更新扩展'), true);
  const fallback = recoveryFailureHint({});
  assert.equal(fallback.classification.severity, RECOVERY_SEVERITY.ERROR);
  assert.ok(fallback.nextSteps.some((step) => step.includes('bridge video recover')));
});
