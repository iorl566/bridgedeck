// tools/longtail/scenarios/page-vom.mjs —— 大页面夹具 × 真实 VOM 模块：元素 / 边 / 时间预算。
//
// 真实消费链（全部只读 import，不修改扩展源码）：
//   1. buildPageFixture（本工具）→ 写 tmp → 读回（证明夹具落盘、仓库无大文件）
//   2. extension/src/lib/vom-graph.js        buildVomGraph（默认上限截断 + 提高上限的全量图）
//   3. extension/src/lib/vom-weights.js      attachVomScores / rankVomNodes（元素打分/排序预算）
//   4. extension/src/lib/vom-budget.js       evaluateVomBudget（元素/token 预算裁剪）
//   5. extension/src/lib/vom-affordance.js   summarizeAffordances（交互能力统计）
//   6. extension/src/lib/vom-semantic.js     buildVomSemanticGraph（语义分组/上下文）
//   7. extension/src/lib/vom-groups.js       buildVomGroups（section/row/form 分组）
//   8. extension/src/lib/frame-vom.js        buildFrameVomGraphs（13 帧子图 + frame 边）
//   9. extension/src/lib/vom-frames-depth.js buildFrameDepthReport（帧树/归属链/缺口）
//  10. extension/src/lib/vom-frame-relations.js buildCrossFrameRelations（跨帧关系）
//  11. extension/src/lib/vom-relations.js    buildVomRelationGraph（语义关系边）
//
// 预算证据：
//   - 元素：全量图节点数 ≥ 夹具 refs；默认上限下 truncated=true 且 nodes=600（上限生效）。
//   - 边：关系边（labels/controls/owns/describes/invalidates）+ 跨帧 frame 边 ≥ 各下限。
//   - 时间/内存：每阶段实测 median + 场景总时长/堆峰值增量，超阈值即失败并给原因码。
//   - 失败可解释：探针让预算器在超时/超内存时给出 time/memory 原因码（不只 return false）。

import { DEFAULT_SEED, stableHash } from '../lib/prng.mjs';
import { resolveScale, evaluateBudget, FAILURE_CODES } from '../lib/budget.mjs';
import { measureSync, createMemoryTracker, nowMs, roundMs } from '../lib/measure.mjs';
import { createWorkspace } from '../lib/tmpdir.mjs';
import * as model from '../lib/model.mjs';
import { buildPageFixture } from '../gen/page.mjs';
import { buildVomGraph } from '../../../extension/src/lib/vom-graph.js';
import { attachVomScores, rankVomNodes } from '../../../extension/src/lib/vom-weights.js';
import { evaluateVomBudget } from '../../../extension/src/lib/vom-budget.js';
import { summarizeAffordances } from '../../../extension/src/lib/vom-affordance.js';
import { buildVomSemanticGraph } from '../../../extension/src/lib/vom-semantic.js';
import { buildVomGroups } from '../../../extension/src/lib/vom-groups.js';
import { buildFrameVomGraphs } from '../../../extension/src/lib/frame-vom.js';
import { buildFrameDepthReport } from '../../../extension/src/lib/vom-frames-depth.js';
import { buildCrossFrameRelations } from '../../../extension/src/lib/vom-frame-relations.js';
import { buildVomRelationGraph } from '../../../extension/src/lib/vom-relations.js';

export const SCENARIO = Object.freeze({
  id: 'page-vom',
  title: '大页面夹具 × VOM：元素/边/时间预算',
  requires: ['extension/src/lib/vom-*.js', 'extension/src/lib/frame-vom.js'],
});

export const REAL_MODULE_CALLS = Object.freeze([
  'extension/src/lib/vom-graph.js#buildVomGraph',
  'extension/src/lib/vom-weights.js#attachVomScores+rankVomNodes',
  'extension/src/lib/vom-budget.js#evaluateVomBudget',
  'extension/src/lib/vom-affordance.js#summarizeAffordances',
  'extension/src/lib/vom-semantic.js#buildVomSemanticGraph',
  'extension/src/lib/vom-groups.js#buildVomGroups',
  'extension/src/lib/frame-vom.js#buildFrameVomGraphs',
  'extension/src/lib/vom-frames-depth.js#buildFrameDepthReport',
  'extension/src/lib/vom-frame-relations.js#buildCrossFrameRelations',
  'extension/src/lib/vom-relations.js#buildVomRelationGraph',
]);

/** 场景预算（可被基线覆盖）。数字是"本机实测 × 2~3 倍余量"，不是拍脑袋的 0。 */
export function budgetFor(scale) {
  const refs = scale.page.refs;
  const expectedDefaultNodes = Math.min(600, refs + scale.page.frames + 2);
  const expectTruncation = expectedDefaultNodes >= 600;
  return {
    label: 'page-vom',
    kind: 'page-vom',
    timeMs: 8_000,
    timeWarnMs: 4_000,
    memoryMb: 384,
    checks: [
      { name: 'refs 达到目标', metric: 'refs', kind: 'min', limit: refs, unit: 'refs', reason: '页面夹具 refs 低于规模目标' },
      { name: '嵌套深度达到目标', metric: 'maxDepth', kind: 'min', limit: scale.page.depth, unit: 'levels', reason: '嵌套深度不足' },
      { name: 'iframe 数量达到目标', metric: 'frames', kind: 'min', limit: scale.page.frames, unit: 'frames', reason: 'iframe 数量不足' },
      { name: '总元素边 ≥ refs', metric: 'edges', kind: 'min', limit: refs, unit: 'edges', reason: '页面图边数不足' },
      { name: '夹具大小合理', metric: 'fixtureBytes', kind: 'min', limit: Math.floor(refs * 300), unit: 'bytes', reason: '页面图夹具落盘体积过小' },
      ...(expectTruncation
        ? [
          { name: '默认上限截断生效', metric: 'graphTruncated', kind: 'truthy', reason: 'VOM 图默认上限没有触发截断（大页面应被保护）' },
          { name: '默认上限节点数=600', metric: 'graphDefaultNodes', kind: 'equal', limit: 600, unit: 'nodes', reason: '默认节点上限与 vom-graph 契约不一致' },
        ]
        : [
          { name: '默认上限未截断（小夹具）', metric: 'graphTruncated', kind: 'equal', limit: 0, unit: 'flag', reason: '小夹具不应触发默认上限' },
          { name: '默认图像保留全部元素', metric: 'graphDefaultNodes', kind: 'min', limit: refs, unit: 'nodes', reason: '小夹具应完整保留' },
        ]),
      { name: '关系边数量', metric: 'relations', kind: 'min', limit: Math.floor(refs * 0.5), unit: 'relations', reason: '语义关系边不足' },
      { name: 'label 关系边', metric: 'relationLabels', kind: 'min', limit: Math.floor(refs * 0.2), unit: 'edges', reason: 'label 关系不足' },
      { name: 'invalidates 关系边', metric: 'relationInvalidates', kind: 'min', limit: 1, unit: 'edges', reason: '错误/校验消息关系缺失' },
      { name: '跨帧归属边', metric: 'frameLinks', kind: 'min', limit: Math.max(1, scale.page.frames - 1), unit: 'links', reason: '多 iframe 归属边缺失' },
      { name: '帧深度链', metric: 'depthMaxDepth', kind: 'min', limit: 2, unit: 'levels', reason: '嵌套 iframe 链深度不足' },
      { name: '帧缺口为 0', metric: 'depthGaps', kind: 'equal', limit: 0, unit: 'gaps', reason: '帧归属证据缺失（应为 0）' },
      { name: '跨帧关系', metric: 'crossRelations', kind: 'min', limit: 10, unit: 'relations', reason: '跨帧关系图不足' },
      { name: '语义分组', metric: 'semanticGroups', kind: 'min', limit: 1, unit: 'groups', reason: '语义分组缺失' },
      { name: '元素预算裁剪', metric: 'budgetTrimmed', kind: 'min', limit: 1, unit: 'nodes', reason: '元素/token 预算没有发生裁剪' },
      { name: '交互能力统计', metric: 'affordanceTypes', kind: 'min', limit: 2, unit: 'types', reason: 'affordance 统计过于单一' },
      { name: '确定性（同 seed 两次一致）', metric: 'deterministic', kind: 'truthy', reason: '生成器/模块输出不确定' },
      { name: '夹具仅写 tmpdir', metric: 'tmpOnly', kind: 'truthy', reason: '大夹具写进了仓库' },
      { name: '真实模块消费点', metric: 'evidenceCalls', kind: 'min', limit: 10, unit: 'calls', reason: '真实模块消费证据不足' },
      { name: '预算失败原因可解释', metric: 'budgetProbeOk', kind: 'truthy', reason: '预算超限时没有给出 time/memory 原因码' },
      { name: 'VOM 图构建时间', metric: 'graphMs', kind: 'max', limit: 500, unit: 'ms', reason: 'VOM 图构建超时' },
      { name: '帧子图构建时间', metric: 'framesMs', kind: 'max', limit: 1_500, unit: 'ms', reason: '13 帧子图构建超时' },
      { name: '关系图构建时间', metric: 'relationsMs', kind: 'max', limit: 1_500, unit: 'ms', reason: '关系图构建超时' },
      { name: 'RSS 上限', metric: 'peakRssMb', kind: 'max', limit: 2_048, unit: 'MB', reason: '绝对内存占用异常' },
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
  const workspace = createWorkspace({ label: 'page', seed, keep: options.keepTmp === true });
  const evidence = { realModuleCalls: [...REAL_MODULE_CALLS], fixture: null, stageRuns: {} };
  try {
    // 1) 生成 + 落盘 + 读回（只写 tmpdir）。
    const generated = measureSync(() => buildPageFixture({
      refs: scale.page.refs,
      depth: scale.page.depth,
      frames: scale.page.frames,
      subgraphNodes: scale.page.subgraphNodes,
      seed,
      profile: scale.name,
    }), { label: 'generate' });
    if (!generated.ok) throw new Error('page fixture 生成失败：' + generated.error.message);
    const fixture = generated.value;
    const persistedRun = measureSync(() => workspace.writeJson('page/graph.json', fixture), { label: 'persist' });
    const persisted = persistedRun.value;
    const readBack = measureSync(() => workspace.readJson('page/graph.json'), { label: 'readback' });
    const page = readBack.value;
    tracker.sample();

    // 2) 元素：observed 节点 + 打分/排序 + 元素/token 预算。
    const observed = measureSync(() => model.observedNodesOf(page, 0), { label: 'observed' });
    const ranking = measureSync(() => {
      const scored = attachVomScores(observed.value);
      const ranked = rankVomNodes(scored, { limit: 400 });
      return { scored, ranked };
    }, { label: 'rank' });
    const scoredNodes = ranking.value.scored;
    const elementBudget = measureSync(() => evaluateVomBudget(scoredNodes, {
      maxNodes: Math.max(64, Math.floor(scoredNodes.length * 0.4)),
      maxTokens: 30_000,
    }), { label: 'element-budget' });
    const affordances = measureSync(() => summarizeAffordances(observed.value), { label: 'affordance' });

    // 3) 图：默认上限（保护）+ 提高上限（全量）。
    const graphDefault = measureSync(() => buildVomGraph({
      graph: page.main,
      nodes: observed.value,
    }), { label: 'vom-graph-default' });
    const graphScaled = measureSync(() => buildVomGraph({
      graph: page.main,
      nodes: observed.value,
      limits: { nodes: 5_000, edges: 20_000 },
    }), { label: 'vom-graph-scaled' });
    tracker.sample();

    // 4) 多 iframe：子图 → 帧深度 → 跨帧关系。
    const frameEntries = model.frameVomEntries(page);
    const frameVom = measureSync(() => buildFrameVomGraphs(frameEntries, {
      limits: { frames: 32, nodes: 2_000, edges: 5_000 },
    }), { label: 'frame-vom' });
    const enrichedFrames = model.attachFrameMeta(frameVom.value, page);
    const depth = measureSync(() => buildFrameDepthReport(model.frameDepthInput(page, frameVom.value)), { label: 'frame-depth' });
    const cross = measureSync(() => buildCrossFrameRelations(enrichedFrames), { label: 'frame-relations' });
    tracker.sample();

    // 5) 语义关系：entries → semantic → relations。
    const relationEntries = model.relationEntriesOf(page);
    const semantic = measureSync(() => buildVomSemanticGraph(relationEntries), { label: 'semantic' });
    const groups = measureSync(() => buildVomGroups(relationEntries, { limit: 400 }), { label: 'groups' });
    const relations = measureSync(() => buildVomRelationGraph(model.relationInput(page, {
      graph: graphScaled.value.payload,
      semantic: semantic.value,
      frameGraphs: enrichedFrames,
      limits: { relations: 4_000, groups: 400, contexts: 400 },
    })), { label: 'relations' });
    tracker.sample();

    // 6) 确定性：同 seed 重建夹具 + 同输入重算关系图，指纹必须一致。
    const rebuilt = buildPageFixture({
      refs: scale.page.refs,
      depth: scale.page.depth,
      frames: scale.page.frames,
      subgraphNodes: scale.page.subgraphNodes,
      seed,
      profile: scale.name,
    });
    const relationFingerprintA = stableHash(relations.value.relations);
    const relationFingerprintB = stableHash(buildVomRelationGraph(model.relationInput(page, {
      graph: buildVomGraph({ graph: page.main, nodes: observed.value, limits: { nodes: 5_000, edges: 20_000 } }).payload,
      semantic: buildVomSemanticGraph(relationEntries),
      frameGraphs: enrichedFrames,
      limits: { relations: 4_000, groups: 400, contexts: 400 },
    })).relations);
    const deterministic = rebuilt.fingerprint === page.fingerprint && relationFingerprintA === relationFingerprintB;

    // 7) 失败原因探针：预算超时/超内存时必须给出可读原因码。
    const probeBudget = budgetFor(scale);
    const overBudget = evaluateBudget({
      budget: probeBudget,
      metrics: { timeMs: probeBudget.timeMs + 1, peakHeapUsedMb: probeBudget.memoryMb + 1 },
    });
    const overCodes = [...(overBudget.failures || []).map((failure) => failure.code)];
    const budgetProbeOk = overCodes.includes(FAILURE_CODES.TIME) && overCodes.includes(FAILURE_CODES.MEMORY);

    const depthStats = depth.value.stats || {};
    const frameSummary = frameVom.value.summary || {};
    const relationStats = relations.value.stats || {};
    const byType = relationStats.byType || {};
    const semanticGraph = semantic.value || { nodes: [], edges: [] };
    const affordanceSummary = affordances.value || { byType: {}, total: 0 };

    const metrics = {
      timeMs: roundMs(nowMs() - totalStart),
      generateMs: generated.stats.median,
      persistMs: persistedRun.stats.median,
      readbackMs: readBack.stats.median,
      graphMs: graphScaled.stats.median,
      graphDefaultMs: graphDefault.stats.median,
      rankMs: ranking.stats.median,
      budgetMs: elementBudget.stats.median,
      affordanceMs: affordances.stats.median,
      semanticMs: semantic.stats.median,
      groupsMs: groups.stats.median,
      framesMs: frameVom.stats.median,
      depthMs: depth.stats.median,
      crossMs: cross.stats.median,
      relationsMs: relations.stats.median,
      refs: Number(page.stats && page.stats.refs) || 0,
      nodes: Number(page.stats && page.stats.nodes) || 0,
      edges: Number(page.stats && page.stats.edges) || 0,
      maxDepth: Number(page.stats && page.stats.maxDepth) || 0,
      frames: Number(page.stats && page.stats.frames) || 0,
      iframeNodes: Number(page.stats && page.stats.iframeNodes) || 0,
      fixtureBytes: persisted.bytes,
      fixtureFiles: workspace.stats().files,
      observed: observed.value.length,
      scored: scoredNodes.length,
      ranked: ranking.value.ranked.length,
      budgetKept: elementBudget.value.kept,
      budgetTrimmed: elementBudget.value.trimmed.nodes,
      budgetReason: String(elementBudget.value.reason || ''),
      graphNodes: graphScaled.value.payload.counts.nodes,
      graphEdges: graphScaled.value.payload.counts.edges,
      graphTruncated: graphDefault.value.payload.truncated === true,
      graphDefaultNodes: graphDefault.value.payload.counts.nodes,
      semanticGroups: semanticGraph.nodes.length,
      semanticEdges: semanticGraph.edges.length,
      groupsTotal: groups.value.total,
      frameGraphs: frameSummary.count || 0,
      frameNodes: frameSummary.nodes || 0,
      frameEdges: frameSummary.edges || 0,
      frameLinks: frameSummary.links ? frameSummary.links.length : 0,
      frameUnlinked: frameSummary.unlinked || 0,
      depthFrames: depthStats.frames || 0,
      depthLinks: depthStats.links || 0,
      depthGaps: Array.isArray(depth.value.gaps) ? depth.value.gaps.length : 0,
      depthMaxDepth: depthStats.maxDepth || 0,
      crossRelations: (cross.value.stats && cross.value.stats.relations) || 0,
      crossFrames: (cross.value.stats && cross.value.stats.frames) || 0,
      relations: relationStats.relations || 0,
      relationTruncated: relationStats.relations >= 4_000,
      relationLabels: byType.labels || 0,
      relationControls: byType.controls || 0,
      relationOwns: byType.owns || 0,
      relationDescribes: byType.describes || 0,
      relationInvalidates: byType.invalidates || 0,
      affordanceTypes: Object.keys(affordanceSummary.byType || {}).length,
      deterministic,
      tmpOnly: workspace.isTmpOnly(),
      evidenceCalls: evidence.realModuleCalls.length,
      budgetProbeOk,
      peakHeapUsedMb: 0,
      peakRssMb: 0,
    };

    // 内存最后采（把前面所有阶段保留的结果都算进去）。
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
          kind: 'page',
          fingerprint: page.fingerprint,
          refs: metrics.refs,
          frames: metrics.frames,
          maxDepth: metrics.maxDepth,
          files: workspace.listFiles(),
          bytes: persisted.bytes,
          tmp: workspace.dir,
        },
        moduleOutputs: {
          graphFingerprint: stableHash(graphScaled.value.payload),
          relationFingerprint: relationFingerprintA,
          frameSummary,
          depthStats,
          crossStats: cross.value.stats,
          relationStats,
          budgetReason: elementBudget.value.reason,
          affordanceTotal: affordanceSummary.total,
        },
        probes: {
          overBudget: { level: overBudget.level, codes: overCodes, failures: overBudget.failures },
        },
      },
      keptTmp: workspace.keep,
      tmpDir: workspace.keep ? workspace.dir : null,
    };
  } finally {
    if (!workspace.keep) workspace.cleanup();
  }
}
