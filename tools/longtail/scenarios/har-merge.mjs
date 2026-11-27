// tools/longtail/scenarios/har-merge.mjs —— 大 HAR（≥5MB / 多来源）合并 + 瀑布归因预算。
//
// 真实消费链：
//   lib/har-merge.mjs          parseHarSource → mergeHarSources → validateHarDeep → explainHarIssues
//                              arbitrateHarEntries（由 merge 内部驱动）→ compareHarRoundTrip
//   lib/har-import.mjs         importHar（合并后的 HAR 回灌成网络请求）
//   lib/har.mjs                buildHar（再导出 HAR）→ 与合并结果做往返保真比较
//   lib/waterfall-attribution.mjs attributeWaterfall / buildWaterfall / selectWaterfallRows /
//                              correlateFrames / auditCompletion / summarizeWaterfallAttribution
//
// 失败原因证据：
//   - 坏 HAR 探针（缺 URL / 非法状态码 / 非法 timing / 重复 page id / 分项与 time 不一致）
//     必须分别产出具名 issue code；
//   - 不可解析来源 / 非 HAR 来源 → parse/merge 的结构化 failure（unparsable-json / not-har）；
//   - 预算超时/超内存 → time/memory 原因码。

import { DEFAULT_SEED, stableHash } from '../lib/prng.mjs';
import { resolveScale, evaluateBudget, FAILURE_CODES } from '../lib/budget.mjs';
import { measureSync, createMemoryTracker, nowMs, roundMs } from '../lib/measure.mjs';
import { createWorkspace } from '../lib/tmpdir.mjs';
import * as model from '../lib/model.mjs';
import { buildHarFixture, buildHarFailureProbes } from '../gen/har.mjs';
import {
  parseHarSource,
  mergeHarSources,
  validateHarDeep,
  explainHarIssues,
  compareHarRoundTrip,
  summarizeHarMergeReport,
} from '../../../lib/har-merge.mjs';
import { importHar } from '../../../lib/har-import.mjs';
import { buildHar } from '../../../lib/har.mjs';
import {
  attributeWaterfall,
  selectWaterfallRows,
  correlateFrames,
  auditCompletion,
  summarizeWaterfallAttribution,
} from '../../../lib/waterfall-attribution.mjs';

export const SCENARIO = Object.freeze({
  id: 'har-merge',
  title: '大 HAR（≥5MB/多来源）合并与瀑布归因预算',
  requires: ['lib/har-merge.mjs', 'lib/har-import.mjs', 'lib/har.mjs', 'lib/waterfall-attribution.mjs'],
});

export const REAL_MODULE_CALLS = Object.freeze([
  'lib/har-merge.mjs#parseHarSource',
  'lib/har-merge.mjs#mergeHarSources',
  'lib/har-merge.mjs#validateHarDeep',
  'lib/har-merge.mjs#explainHarIssues',
  'lib/har-merge.mjs#compareHarRoundTrip',
  'lib/har-merge.mjs#summarizeHarMergeReport',
  'lib/har-import.mjs#importHar',
  'lib/har.mjs#buildHar',
  'lib/waterfall-attribution.mjs#attributeWaterfall',
  'lib/waterfall-attribution.mjs#selectWaterfallRows',
  'lib/waterfall-attribution.mjs#correlateFrames',
  'lib/waterfall-attribution.mjs#auditCompletion',
  'lib/waterfall-attribution.mjs#summarizeWaterfallAttribution',
]);

/** 场景预算（可被基线覆盖）。 */
export function budgetFor(scale) {
  const har = scale.har;
  const totalEntries = har.sources * har.entriesPerSource;
  // 只有条目数足够大时才会触发 200 行降级裁剪；smoke 规模不强行断言裁剪。
  const expectDegrade = totalEntries > 400;
  return {
    label: 'har-merge',
    kind: 'har-merge',
    timeMs: 30_000,
    timeWarnMs: 15_000,
    memoryMb: 768,
    checks: [
      { name: 'HAR 来源总体积 ≥ 目标', metric: 'sourceBytes', kind: 'min', limit: har.minBytes, unit: 'bytes', reason: 'HAR 夹具总体积低于 5MB 目标' },
      { name: '来源数量', metric: 'sourceCount', kind: 'min', limit: har.sources, unit: 'sources', reason: '多来源数量不足' },
      { name: '合并前条目数', metric: 'totalEntries', kind: 'min', limit: Math.floor(totalEntries * 0.9), unit: 'entries', reason: 'HAR 条目数不足' },
      { name: '合并后保留条目数', metric: 'keptEntries', kind: 'min', limit: Math.floor(totalEntries * 0.35), unit: 'entries', reason: '合并保留条目过少' },
      { name: '去重命中', metric: 'duplicates', kind: 'min', limit: 1, unit: 'entries', reason: '跨来源去重没有发生（夹具/合并路径退化）' },
      { name: '冲突裁决', metric: 'conflicts', kind: 'min', limit: 10, unit: 'conflicts', reason: '多来源冲突裁决没有发生' },
      { name: 'page 合并', metric: 'pages', kind: 'min', limit: har.sources, unit: 'pages', reason: '多来源页面没有全部并入' },
      { name: '合并时间轴跨度', metric: 'spanMs', kind: 'min', limit: 60_000, unit: 'ms', reason: '合并后的时间轴跨度过短' },
      { name: '合并结果体积', metric: 'mergedBytes', kind: 'min', limit: 100_000, unit: 'bytes', reason: '合并结果异常小' },
      { name: '深校验 error 数', metric: 'validationErrors', kind: 'equal', limit: 0, unit: 'issues', reason: '生成的 HAR 结构非法' },
      { name: '深校验可解释输出', metric: 'explainedIssues', kind: 'min', limit: 50, unit: 'chars', reason: 'explainHarIssues 没有产出可解释文本' },
      ...(expectDegrade
        ? [
          { name: '归因行数（降级后）', metric: 'degradedRows', kind: 'min', limit: 100, unit: 'rows', reason: '降级后的 waterfall 行数过少' },
          { name: '降级标记', metric: 'degradedLimited', kind: 'truthy', reason: '超过 limit 时没有标记 degraded.limited' },
          { name: 'selectWaterfallRows 裁剪', metric: 'selectedRows', kind: 'min', limit: 100, unit: 'rows', reason: 'selectWaterfallRows 返回过少' },
          { name: 'selectWaterfallRows 丢弃', metric: 'selectDropped', kind: 'min', limit: 1, unit: 'rows', reason: '没有发生任何丢弃（limit 未生效）' },
        ]
        : [
          { name: '归因行数（小夹具不降级）', metric: 'degradedRows', kind: 'min', limit: 50, unit: 'rows', reason: '归因行数过少' },
          { name: 'selectWaterfallRows 保留行', metric: 'selectedRows', kind: 'min', limit: 50, unit: 'rows', reason: 'selectWaterfallRows 返回过少' },
        ]),
      { name: '全量瀑布行数', metric: 'fullRows', kind: 'min', limit: Math.floor(totalEntries * 0.4), unit: 'rows', reason: '全量 waterfall 行数不足' },
      { name: '慢请求识别', metric: 'slowCount', kind: 'min', limit: 1, unit: 'requests', reason: '没有识别出慢请求' },
      { name: '三段归因完整', metric: 'phaseDominant', kind: 'exists', reason: '相位归因没有主导相位' },
      { name: '流式请求诚实标记', metric: 'streamingCount', kind: 'min', limit: 1, unit: 'requests', reason: '未完成请求没有进 streaming 统计' },
      { name: '跨 frame 关联', metric: 'frameCount', kind: 'min', limit: 2, unit: 'frames', reason: '跨 frame 归因没有覆盖多个 frame' },
      { name: '完成度审计', metric: 'auditOk', kind: 'truthy', reason: 'auditCompletion 发现完成度违规' },
      { name: '往返保真（entry 字段）', metric: 'roundTripEntryDiffs', kind: 'equal', limit: 0, unit: 'differences', reason: 'import→export 往返丢失 entry 字段' },
      { name: '坏 HAR/坏来源探针', metric: 'probesOk', kind: 'truthy', reason: '失败原因不可解释（缺少具名 code）' },
      { name: '确定性（同 seed 两次一致）', metric: 'deterministic', kind: 'truthy', reason: 'HAR 夹具/合并结果不确定' },
      { name: '夹具仅写 tmpdir', metric: 'tmpOnly', kind: 'truthy', reason: '大 HAR 写进了仓库' },
      { name: '真实模块消费点', metric: 'evidenceCalls', kind: 'min', limit: 13, unit: 'calls', reason: '真实模块消费证据不足' },
      { name: '预算失败原因可解释', metric: 'budgetProbeOk', kind: 'truthy', reason: '预算超限时没有给出原因码' },
      { name: '合并耗时', metric: 'mergeMs', kind: 'max', limit: 8_000, unit: 'ms', reason: 'HAR 合并超时' },
      { name: '归因耗时', metric: 'attributionMs', kind: 'max', limit: 4_000, unit: 'ms', reason: 'waterfall 归因超时' },
      { name: '往返耗时', metric: 'roundTripMs', kind: 'max', limit: 8_000, unit: 'ms', reason: 'HAR 往返导入导出超时' },
      { name: 'RSS 上限', metric: 'peakRssMb', kind: 'max', limit: 2_048, unit: 'MB', reason: '绝对内存占用异常' },
    ],
  };
}

function countsOf(validation) {
  // har-merge 的 countSeverities 返回 {errors, warnings, infos}（复数键）。
  return {
    errors: Number(validation && validation.counts && validation.counts.errors) || 0,
    warnings: Number(validation && validation.counts && validation.counts.warnings) || 0,
    infos: Number(validation && validation.counts && validation.counts.infos) || 0,
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
  const workspace = createWorkspace({ label: 'har', seed, keep: options.keepTmp === true });
  const evidence = {
    realModuleCalls: [...REAL_MODULE_CALLS],
    fixture: null,
    merge: null,
    attribution: null,
    roundTrip: null,
    probes: null,
  };
  try {
    // 1) 生成 + 写 tmp + 按索引读回（真实文件 I/O；大文件只在 tmpdir）。
    const generated = measureSync(() => buildHarFixture({
      sources: scale.har.sources,
      entriesPerSource: scale.har.entriesPerSource,
      bodyBytes: scale.har.bodyBytes,
      minBytes: scale.har.minBytes,
      seed,
      profile: scale.name,
    }), { label: 'generate' });
    if (!generated.ok) throw new Error('HAR fixture 生成失败：' + generated.error.message);
    const fixture = generated.value;
    const written = measureSync(() => {
      const files = [];
      for (const source of fixture.sources) {
        files.push(workspace.writeJson('har/' + source.label + '.json', source.har));
      }
      workspace.writeJson('har/index.json', { labels: fixture.labels, files: files.map((file) => file.path) });
      return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
    }, { label: 'write' });
    const back = measureSync(() => {
      const index = workspace.readJson('har/index.json');
      return index.files.map((file) => workspace.readText(file));
    }, { label: 'read' });
    const sourceStrings = back.value;
    tracker.sample();

    // 2) 逐来源解析（parseHarSource 的真实路径），再合并。
    const parse = measureSync(() => sourceStrings.map((raw, index) => parseHarSource(raw, { index, label: fixture.labels[index] })), { label: 'parse' });
    const parseFailures = parse.value.filter((item) => !item.ok).length;
    const now = fixture.baseMs + 6_000_000;
    const merged = measureSync(() => mergeHarSources(sourceStrings, {
      now,
      align: 'absolute',
      policy: 'prefer-complete',
      timeWindowMs: 1_000,
    }), { label: 'merge' });
    const report = merged.value.report;
    const mergeSummary = summarizeHarMergeReport(report);
    tracker.sample();

    // 3) 深校验 + 失败解释。
    const validation = measureSync(() => validateHarDeep(merged.value.har, { maxIssues: 500 }), { label: 'validate' });
    const explained = explainHarIssues(validation.value, { limit: 20 });
    const validationCounts = countsOf(validation.value);

    // 4) 往返保真：合并结果 → importHar → buildHar → 字段级比较。
    const roundTrip = measureSync(() => {
      const imported = importHar(merged.value.har, { now });
      const rebuilt = buildHar(imported.requests, { now, pageUrl: 'https://longtail.test/', pageTitle: '长尾合并 HAR' });
      return { requests: imported.requests.length, rebuilt, comparison: compareHarRoundTrip(merged.value.har, rebuilt, { now, maxDifferences: 100 }) };
    }, { label: 'roundtrip' });
    const comparison = roundTrip.value.comparison;
    const pageDiffs = (comparison.differences || []).filter((item) => String(item.path).startsWith('log.pages'));
    const entryDiffs = (comparison.differences || []).filter((item) => !String(item.path).startsWith('log.pages'));
    tracker.sample();

    // 5) 归因：HAR entries → network entries → 降级归因 + 全量归因 + 跨帧 + 完成度审计。
    const networkEntries = model.harToNetworkEntries(merged.value.har.log.entries, { openTail: 24 });
    const frames = model.frameRegistryOf(fixture.frames);
    const attributionNow = fixture.baseMs + (mergeSummary.spanMs || 0) + 5_000;
    const degraded = measureSync(() => attributeWaterfall(networkEntries, {
      limit: 200,
      slowMs: 800,
      now: attributionNow,
      frames,
    }), { label: 'attribution-degraded' });
    const full = measureSync(() => attributeWaterfall(networkEntries, {
      limit: Math.max(1, networkEntries.length + 10),
      slowMs: 800,
      now: attributionNow,
      frames,
    }), { label: 'attribution-full' });
    const selection = measureSync(() => selectWaterfallRows(full.value.rows, { limit: 150, slowMs: 800 }), { label: 'select-rows' });
    const correlated = measureSync(() => correlateFrames(full.value.rows, { frames }), { label: 'correlate-frames' });
    const audit = measureSync(() => auditCompletion(networkEntries), { label: 'audit-completion' });
    const attributionSummary = measureSync(() => summarizeWaterfallAttribution(full.value, { topSlow: 5, topFrames: 5 }), { label: 'summarize' });

    // 6) 失败原因探针：坏 HAR / 坏来源 / 坏预算。
    const harProbes = buildHarFailureProbes();
    const harProbeResults = harProbes.map((probe) => {
      const result = validateHarDeep(probe.har, { maxIssues: 50 });
      const codes = [...new Set((result.issues || []).map((issue) => issue.code))];
      return {
        name: probe.name,
        expectedCodes: probe.expectedCodes,
        codes,
        ok: probe.expectedCodes.every((code) => codes.includes(code)),
      };
    });
    const parseProbe = parseHarSource('{ 这不是 JSON', { label: 'broken' });
    const nonHarProbe = mergeHarSources([{ unexpected: true }], { now });
    const budgetProbe = budgetFor(scale);
    const overBudget = evaluateBudget({
      budget: budgetProbe,
      metrics: { timeMs: budgetProbe.timeMs + 1, peakHeapUsedMb: budgetProbe.memoryMb + 1 },
    });
    const overCodes = (overBudget.failures || []).map((failure) => failure.code);
    const probesOk = harProbeResults.every((probe) => probe.ok)
      && parseProbe.ok === false && parseProbe.failure.code === 'unparsable-json'
      && nonHarProbe.report.failures.length === 1 && nonHarProbe.report.failures[0].code === 'not-har'
      && overCodes.includes(FAILURE_CODES.TIME) && overCodes.includes(FAILURE_CODES.MEMORY);

    // 7) 确定性：同 seed 重建夹具指纹一致 + 同输入二次合并且合并报告指纹一致。
    const rebuilt = buildHarFixture({
      sources: scale.har.sources,
      entriesPerSource: scale.har.entriesPerSource,
      bodyBytes: scale.har.bodyBytes,
      minBytes: scale.har.minBytes,
      seed,
      profile: scale.name,
    });
    const secondMerge = mergeHarSources(sourceStrings, { now, align: 'absolute', policy: 'prefer-complete', timeWindowMs: 1_000 });
    const secondSummary = summarizeHarMergeReport(secondMerge.report);
    const deterministic = rebuilt.fingerprint === fixture.fingerprint
      && stableHash(secondSummary) === stableHash(mergeSummary);

    const fullSummary = attributionSummary.value;
    const phaseDominant = fullSummary && fullSummary.phases && fullSummary.phases.dominant ? fullSummary.phases.dominant.phase : '';
    const metrics = {
      timeMs: roundMs(nowMs() - totalStart),
      generateMs: generated.stats.median,
      writeMs: written.stats.median,
      readMs: back.stats.median,
      parseMs: parse.stats.median,
      mergeMs: merged.stats.median,
      validateMs: validation.stats.median,
      roundTripMs: roundTrip.stats.median,
      attributionMs: degraded.stats.median,
      fullAttributionMs: full.stats.median,
      selectMs: selection.stats.median,
      correlateMs: correlated.stats.median,
      auditMs: audit.stats.median,
      summarizeMs: attributionSummary.stats.median,
      sourceCount: fixture.sources.length,
      sourceBytes: written.value.bytes,
      totalEntries: mergeSummary.totalEntries,
      keptEntries: mergeSummary.keptEntries,
      duplicates: mergeSummary.duplicates,
      conflicts: mergeSummary.conflicts,
      pages: mergeSummary.pages,
      spanMs: mergeSummary.spanMs,
      mergedBytes: mergeSummary.bytes,
      validationErrors: validationCounts.errors,
      validationWarnings: validationCounts.warnings,
      validationInfos: validationCounts.infos,
      explainedIssues: String(explained || '').length,
      networkRows: networkEntries.length,
      degradedRows: (degraded.value.rows || []).length,
      degradedLimited: Boolean(degraded.value.degraded && degraded.value.degraded.limited),
      degradedStrategy: String((degraded.value.degraded && degraded.value.degraded.strategy) || ''),
      fullRows: (full.value.rows || []).length,
      selectedRows: (selection.value.rows || []).length,
      selectDropped: selection.value.dropped,
      slowCount: Number(fullSummary && fullSummary.slow && fullSummary.slow.count) || 0,
      streamingCount: Number(fullSummary && fullSummary.streaming && fullSummary.streaming.count) || 0,
      errorCount: Number(fullSummary && fullSummary.errors && fullSummary.errors.count) || 0,
      frameCount: Number(fullSummary && fullSummary.frames && fullSummary.frames.count) || 0,
      orphanFrames: Number(correlated.value.orphans ? correlated.value.orphans.length : 0),
      auditOk: audit.value.ok === true,
      auditViolations: (audit.value.violations || []).length,
      auditUnverifiable: (audit.value.unverifiable || []).length,
      phaseDominant,
      phaseShare: Number(fullSummary && fullSummary.phases && fullSummary.phases.dominant ? fullSummary.phases.dominant.share : 0),
      roundTripRequests: roundTrip.value.requests,
      roundTripDiffCount: (comparison.differences || []).length,
      roundTripEntryDiffs: entryDiffs.length,
      roundTripPageDiffs: pageDiffs.length,
      probesOk,
      deterministic,
      tmpOnly: workspace.isTmpOnly(),
      evidenceCalls: evidence.realModuleCalls.length,
      budgetProbeOk: overCodes.includes(FAILURE_CODES.TIME) && overCodes.includes(FAILURE_CODES.MEMORY),
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
          kind: 'har',
          fingerprint: fixture.fingerprint,
          sources: fixture.labels,
          totalBytes: fixture.stats.totalBytes,
          minBytes: fixture.stats.minBytes,
          files: workspace.listFiles(),
          bytes: written.value.bytes,
          tmp: workspace.dir,
        },
        merge: {
          summary: mergeSummary,
          parseFailures,
          explained: String(explained || '').slice(0, 400),
          conflictsByKind: summarizeConflicts(report),
        },
        roundTrip: {
          identical: comparison.identical,
          pageDiffs,
          entryDiffs: entryDiffs.slice(0, 10),
        },
        attribution: {
          degraded: degraded.value.degraded,
          phases: fullSummary.phases,
          frames: fullSummary.frames,
          streaming: fullSummary.streaming,
          selection: { strategy: selection.value.strategy, dropped: selection.value.dropped, reasons: selection.value.reasons },
          correlation: correlated.value.summary || null,
          audit: { ok: audit.value.ok, violations: audit.value.violations.slice(0, 5) },
        },
        probes: {
          har: harProbeResults,
          parse: parseProbe.ok ? null : parseProbe.failure,
          nonHar: nonHarProbe.report.failures,
          overBudget: { level: overBudget.level, codes: overCodes },
        },
      },
      keptTmp: workspace.keep,
      tmpDir: workspace.keep ? workspace.dir : null,
    };
  } finally {
    if (!workspace.keep) workspace.cleanup();
  }
}

function summarizeConflicts(report) {
  const byKind = {};
  for (const conflict of (report && Array.isArray(report.conflicts) ? report.conflicts : [])) {
    const kind = String(conflict.kind || 'unknown');
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  return byKind;
}
