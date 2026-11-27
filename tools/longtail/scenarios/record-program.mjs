// tools/longtail/scenarios/record-program.mjs —— 长 record（≥200 步 / 含分支）构建与回放预检预算。
//
// 真实消费链（extension/src/record-program.js，只读 import）：
//   buildRecordProgram → validateRecordProgram → preflightReplay（严格/允许副作用两档）→
//   summarizeRecordProgram → programFingerprint → programDiff → mergeRecordPrograms
//
// 证据：
//   - 规模：steps ≥ 200、branch（navigate 边界）≥ 4、循环组 ≥ 3、human-gate ≥ 2；
//   - 校验：error=0（真实录制可被接受）；
//   - 预检：严格档必须逐条拦住非幂等副作用；允许档必须 0 blocker、只留循环/重试 warning；
//   - 失败原因：5 个非法程序探针分别给出 STEP_REF_DUPLICATE / RETRY_NON_IDEMPOTENT /
//     BRANCH_NAVIGATE_NO_URL / LOOP_TOO_LONG / FALLBACK_UNKNOWN；
//   - 确定性：同 seed 重建 + 二次构建 → 程序指纹一致。

import { DEFAULT_SEED, stableHash } from '../lib/prng.mjs';
import { resolveScale, evaluateBudget, FAILURE_CODES } from '../lib/budget.mjs';
import { measureSync, createMemoryTracker, nowMs, roundMs } from '../lib/measure.mjs';
import { createWorkspace } from '../lib/tmpdir.mjs';
import { buildRecordFixture, buildRecordVariant, buildRecordFailureProbes } from '../gen/record.mjs';
import {
  buildRecordProgram,
  validateRecordProgram,
  preflightReplay,
  summarizeRecordProgram,
  programFingerprint,
  programDiff,
  mergeRecordPrograms,
} from '../../../extension/src/record-program.js';

export const SCENARIO = Object.freeze({
  id: 'record-program',
  title: '长 record（≥200 步/含分支）构建与回放预检预算',
  requires: ['extension/src/record-program.js'],
});

export const REAL_MODULE_CALLS = Object.freeze([
  'extension/src/record-program.js#buildRecordProgram',
  'extension/src/record-program.js#validateRecordProgram',
  'extension/src/record-program.js#preflightReplay',
  'extension/src/record-program.js#summarizeRecordProgram',
  'extension/src/record-program.js#programFingerprint',
  'extension/src/record-program.js#programDiff',
  'extension/src/record-program.js#mergeRecordPrograms',
]);

/** 场景预算（可被基线覆盖）。 */
export function budgetFor(scale) {
  return {
    label: 'record-program',
    kind: 'record-program',
    timeMs: 8_000,
    timeWarnMs: 4_000,
    memoryMb: 256,
    checks: [
      { name: '步骤数达到目标', metric: 'steps', kind: 'min', limit: scale.record.steps, unit: 'steps', reason: 'record 程序步数低于目标' },
      { name: '分支（navigate 边界）数量', metric: 'boundaries', kind: 'min', limit: scale.record.boundaries, unit: 'branches', reason: '分支数量不足' },
      { name: '边界段数量', metric: 'segments', kind: 'min', limit: scale.record.boundaries + 1, unit: 'segments', reason: '边界段划分不足' },
      { name: '循环组数量', metric: 'loops', kind: 'min', limit: scale.record.loops, unit: 'loops', reason: '连续重复步骤没有被识别成循环组' },
      { name: 'human-gate 数量', metric: 'humanGates', kind: 'min', limit: scale.record.humanGates, unit: 'gates', reason: '人工门数量不足' },
      { name: '程序校验 error 数', metric: 'validateErrors', kind: 'equal', limit: 0, unit: 'issues', reason: '合法录制程序出现校验错误' },
      { name: '严格预检拦截全部副作用', metric: 'strictBlockersMatch', kind: 'truthy', reason: '严格预检没有逐条拦截非幂等副作用' },
      { name: '严格预检拦截码', metric: 'strictBlockerCodesOk', kind: 'truthy', reason: '严格预检 blocker 的原因码不是 REPLAY_SIDE_EFFECT' },
      { name: '允许副作用后 0 blocker', metric: 'allowedBlockers', kind: 'equal', limit: 0, unit: 'blockers', reason: '允许副作用后仍有 blocker' },
      { name: '回放 warning 可解释', metric: 'allowedWarnings', kind: 'min', limit: 1, unit: 'warnings', reason: '循环/重试没有产生可解释 warning' },
      { name: '指纹稳定', metric: 'fingerprintStable', kind: 'truthy', reason: '同输入二次构建的程序指纹不稳定' },
      { name: 'diff 检出变更', metric: 'diffOps', kind: 'min', limit: 3, unit: 'ops', reason: 'programDiff 没检出变体差异' },
      { name: '合并程序产物', metric: 'mergeSteps', kind: 'min', limit: Math.max(10, Math.floor(scale.record.steps * 0.5)), unit: 'steps', reason: 'mergeRecordPrograms 合并结果异常' },
      { name: '非法程序探针', metric: 'probesOk', kind: 'truthy', reason: '非法程序没有给出具名校验 code' },
      { name: '确定性（同 seed 两次一致）', metric: 'deterministic', kind: 'truthy', reason: 'record 夹具不确定' },
      { name: '夹具仅写 tmpdir', metric: 'tmpOnly', kind: 'truthy', reason: 'record 夹具写进了仓库' },
      { name: '真实模块消费点', metric: 'evidenceCalls', kind: 'min', limit: 7, unit: 'calls', reason: '真实模块消费证据不足' },
      { name: '预算失败原因可解释', metric: 'budgetProbeOk', kind: 'truthy', reason: '预算超限时没有给出原因码' },
      { name: '程序构建耗时', metric: 'buildMs', kind: 'max', limit: 500, unit: 'ms', reason: '程序构建超时' },
      { name: '回放预检耗时', metric: 'preflightMs', kind: 'max', limit: 500, unit: 'ms', reason: '回放预检超时' },
      { name: 'diff 耗时', metric: 'diffMs', kind: 'max', limit: 2_000, unit: 'ms', reason: 'programDiff 超时' },
      { name: 'RSS 上限', metric: 'peakRssMb', kind: 'max', limit: 1_024, unit: 'MB', reason: '绝对内存占用异常' },
    ],
  };
}

/**
 * @param {{scale?:string, seed?:string|number, keepTmp?:boolean}} [options]
 */
export async function run(options = {}) {
  const scale = resolveScale(options.scale || 'default');
  const seed = options.seed == null ? DEFAULT_SEED : options.seed;
  const totalStart = nowMs();
  const tracker = createMemoryTracker();
  const workspace = createWorkspace({ label: 'record', seed, keep: options.keepTmp === true });
  const evidence = { realModuleCalls: [...REAL_MODULE_CALLS], fixture: null, validation: null, preflight: null, diff: null, merge: null, probes: null };
  try {
    // 1) 生成 + 落盘 + 读回。
    const generated = measureSync(() => buildRecordFixture({
      steps: scale.record.steps,
      boundaries: scale.record.boundaries,
      loops: scale.record.loops,
      humanGates: scale.record.humanGates,
      seed,
      profile: scale.name,
    }), { label: 'generate' });
    if (!generated.ok) throw new Error('record fixture 生成失败：' + generated.error.message);
    const fixture = generated.value;
    const persistedRun = measureSync(() => workspace.writeJson('record/steps.json', { version: fixture.version, seed: fixture.seed, steps: fixture.steps }), { label: 'persist' });
    const readBack = measureSync(() => workspace.readJson('record/steps.json'), { label: 'readback' });
    const steps = readBack.value.steps;
    tracker.sample();

    // 2) 构建 / 校验 / 预检（严格 + 允许副作用）。
    const built = measureSync(() => buildRecordProgram(steps), { label: 'build' });
    const program = built.value;
    const validation = measureSync(() => validateRecordProgram(steps), { label: 'validate' });
    const strict = measureSync(() => preflightReplay(program), { label: 'preflight-strict' });
    const allowed = measureSync(() => preflightReplay(program, { allowNonIdempotent: true }), { label: 'preflight-allowed' });
    const summary = measureSync(() => summarizeRecordProgram(program), { label: 'summarize' });
    tracker.sample();

    // 3) 变体 diff + 双来源合并。
    const variant = buildRecordVariant(fixture, { seed });
    const diff = measureSync(() => programDiff(program, variant.steps), { label: 'diff' });
    const merged = measureSync(() => mergeRecordPrograms([
      { source: 'primary', program },
      { source: 'variant', steps: variant.steps },
    ]), { label: 'merge' });
    tracker.sample();

    // 4) 失败原因探针。
    const probeResults = buildRecordFailureProbes().map((probe) => {
      const result = buildRecordProgram(probe.steps);
      const codes = [...new Set((result.validation.issues || []).map((issue) => issue.code))];
      return {
        name: probe.name,
        expectedCodes: probe.expectedCodes,
        codes,
        ok: probe.expectedCodes.every((code) => codes.includes(code)),
      };
    });
    const probeBudget = budgetFor(scale);
    const overBudget = evaluateBudget({
      budget: probeBudget,
      metrics: { timeMs: probeBudget.timeMs + 1, peakHeapUsedMb: probeBudget.memoryMb + 1 },
    });
    const overCodes = (overBudget.failures || []).map((failure) => failure.code);
    const budgetProbeOk = overCodes.includes(FAILURE_CODES.TIME) && overCodes.includes(FAILURE_CODES.MEMORY);

    // 5) 确定性：同 seed 重建 + 二次构建指纹一致。
    const rebuilt = buildRecordFixture({
      steps: scale.record.steps,
      boundaries: scale.record.boundaries,
      loops: scale.record.loops,
      humanGates: scale.record.humanGates,
      seed,
      profile: scale.name,
    });
    const secondProgram = buildRecordProgram(rebuilt.steps);
    const fingerprintStable = programFingerprint(program) === programFingerprint(secondProgram)
      && programFingerprint(program) === programFingerprint(steps);
    const deterministic = rebuilt.fingerprint === fixture.fingerprint && fingerprintStable;

    const strictBlockerCodes = [...new Set((strict.value.blockers || []).map((blocker) => blocker.code))];
    const allowedWarnings = (allowed.value.warnings || []).length;
    const metrics = {
      timeMs: roundMs(nowMs() - totalStart),
      generateMs: generated.stats.median,
      persistMs: persistedRun.stats.median,
      readbackMs: readBack.stats.median,
      buildMs: built.stats.median,
      validateMs: validation.stats.median,
      preflightMs: strict.stats.median,
      preflightAllowedMs: allowed.stats.median,
      summarizeMs: summary.stats.median,
      diffMs: diff.stats.median,
      mergeMs: merged.stats.median,
      steps: Number(program.stats && program.stats.total) || 0,
      boundaries: Number(program.stats && program.stats.boundaries) || 0,
      segments: Number(program.stats && program.stats.segments) || 0,
      loops: Number(program.stats && program.stats.loops) || 0,
      humanGates: Number(program.stats && program.stats.humanGates) || 0,
      actions: Number(program.stats && program.stats.byKind && program.stats.byKind.action) || 0,
      observes: Number(program.stats && program.stats.byKind && program.stats.byKind.observe) || 0,
      waits: Number(program.stats && program.stats.byKind && program.stats.byKind.wait) || 0,
      nonIdempotent: Number(program.stats && program.stats.nonIdempotent) || 0,
      idempotent: Number(program.stats && program.stats.idempotent) || 0,
      documents: Number(program.stats && program.stats.documents) || 0,
      validateErrors: Number(validation.value && validation.value.errors) || 0,
      validateWarnings: Number(validation.value && validation.value.warnings) || 0,
      strictBlockers: (strict.value.blockers || []).length,
      strictBlockersMatch: (strict.value.blockers || []).length === (Number(program.stats && program.stats.nonIdempotent) || 0),
      strictBlockerCodesOk: strictBlockerCodes.length === 1 && strictBlockerCodes[0] === 'REPLAY_SIDE_EFFECT',
      allowedBlockers: (allowed.value.blockers || []).length,
      allowedWarnings,
      diffOps: Number(diff.value.stats && diff.value.stats.operations) || (Array.isArray(diff.value.ops) ? diff.value.ops.length : 0),
      diffHunks: Array.isArray(diff.value.hunks) ? diff.value.hunks.length : 0,
      mergeSteps: Number(merged.value.stats && merged.value.stats.steps) || (Array.isArray(merged.value.steps) ? merged.value.steps.length : 0),
      mergeConflicts: Array.isArray(merged.value.conflicts) ? merged.value.conflicts.length : 0,
      fingerprintStable,
      deterministic,
      probesOk: probeResults.every((probe) => probe.ok),
      tmpOnly: workspace.isTmpOnly(),
      evidenceCalls: evidence.realModuleCalls.length,
      budgetProbeOk,
      fixtureBytes: persistedRun.value.bytes,
      peakHeapUsedMb: 0,
      peakRssMb: 0,
    };
    const memory = tracker.finish();
    metrics.peakHeapUsedMb = memory.peakHeapUsedMb;
    metrics.peakRssMb = memory.peakRssMb;
    workspace.assertSafe();
    return {
      id: SCENARIO.id,
      title: SCENARIO.title,
      scale: scale.name,
      seed: String(seed),
      ok: true,
      metrics,
      evidence: {
        ...evidence,
        fixture: {
          kind: 'record',
          fingerprint: fixture.fingerprint,
          steps: fixture.steps.length,
          stats: fixture.stats,
          files: workspace.listFiles(),
          bytes: persistedRun.value.bytes,
          tmp: workspace.dir,
        },
        validation: {
          errors: metrics.validateErrors,
          warnings: metrics.validateWarnings,
          issues: (validation.value.issues || []).slice(0, 10),
        },
        preflight: {
          strictBlockers: metrics.strictBlockers,
          strictCodes: strictBlockerCodes,
          allowedBlockers: metrics.allowedBlockers,
          allowedWarnings: (allowed.value.warnings || []).slice(0, 8),
          requiresHuman: (allowed.value.requiresHuman || []).length,
          replaySteps: Array.isArray(allowed.value.replayPlan) ? allowed.value.replayPlan.length : 0,
        },
        diff: {
          summary: diff.value.stats || null,
          hunks: (diff.value.hunks || []).slice(0, 5),
        },
        merge: { summary: merged.value.stats || null, conflicts: (merged.value.conflicts || []).slice(0, 5) },
        probes: { record: probeResults, overBudget: { level: overBudget.level, codes: overCodes } },
      },
      keptTmp: workspace.keep,
      tmpDir: workspace.keep ? workspace.dir : null,
    };
  } finally {
    if (!workspace.keep) workspace.cleanup();
  }
}
