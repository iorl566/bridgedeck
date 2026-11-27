// src/tools/observation.js —— observe / observe-frames / snapshot / get-html 与 AX/事实合并。
import { bridgeError } from '../errors.js';
import { execPage, execPageAllFrames } from '../inject.js';
import { sleep } from '../tabs.js';
import { log } from '../log.js';
import { acquire, release, send as cdpSend } from '../debugger.js';
import { hideTakeover, showTakeover } from '../takeover.js';
import { ensureFrameGraph } from '../frame-graph.js';
import { matchBrowserFrame, readBrowserFrames } from './frame-identity.js';
import { estimateTokens, takeTokenChunk } from '../tokens.js';
import { formatLayerSummary } from '../lib/layer-summary.js';
import { buildRefDetails } from '../lib/ref-details.js';
import { attachVomScores, rankVomNodes, VOM_WEIGHTS_VERSION, VOM_TOKEN_SAFETY_FACTOR, filterVomNodes, scoreVomNode, estimateVomTokens } from '../lib/vom-weights.js';
import { summarizeVomFunnel } from '../lib/vom-funnel.js';
import {
  captureStagesFromPageStages,
  chainCaptureReports,
  createCaptureTrace,
  pageStagesCaptureReport,
  summarizeCaptureReport,
} from '../lib/vom-capture.js';
import { applyVisibilityGate, summarizeVisibilityGate } from '../lib/vom-visibility.js';
import { applySemanticBudget, buildVomBudgetReport, normalizeVomBudget, summarizeVomBudget, trimVomGroups } from '../lib/vom-budget.js';
import { summarizeRowAnchors } from '../lib/vom-rows.js';
import { resolveVomProfile } from '../lib/vom-profile.js';
import { compactVomNodes } from '../lib/vom-compact.js';
import { createBillingLedger } from '../lib/vom-billing.js';
import { loadO200k } from '../lib/o200k.js';
import { renderAriaSnapshot } from '../lib/aria-snapshot.js';
import { buildVomSemanticGraph } from '../lib/vom-semantic.js';
import { summarizeVomCompression } from '../lib/vom-compress.js';
import { queryVomRelations, summarizeRelationQuery } from '../lib/vom-query.js';
import { buildCrossFrameRelations, summarizeCrossFrameRelations } from '../lib/vom-frame-relations.js';
import { decodeCursor, encodeCursor } from '../lib/observation-cursor.js';
import { buildVomPayload } from '../lib/vom-payload.js';
import { observeFrames as collectObserveFrames } from './observe-frames.js';
// 第九批 VOM 深度：绘制栈/遮挡链、关系全链、视觉对象稳定身份、证据/降级报告、跨帧深度。
import { buildZOrderModel, describeZOrder, summarizeZOrder } from '../lib/vom-zorder.js';
import { buildRelationChains, describeRelationChains, findRelationPaths, summarizeRelationChains } from '../lib/vom-relations-chain.js';
import { assignVisualIdentity, describeVisualIdentity, summarizeVisualIdentity } from '../lib/vom-visual-identity.js';
import { buildEvidenceReport, describeEvidence, summarizeEvidence } from '../lib/vom-degrade.js';
import { buildFrameDepthReport, describeFrameDepth, summarizeFrameDepth } from '../lib/vom-frames-depth.js';
import { diffObservation, observationId } from '../lib/observation-delta.js';
import { captureDomSnapshot } from '../dom-snapshot.js';
import { annotateHiddenRefs, collectHiddenRefs } from '../lib/facts-annotate.js';
import { renderAxObservation } from '../lib/ax-render.js';
import { collectUnmappedAx, isInteractiveAxRole, renderUnmappedAx } from '../lib/unmapped-ax.js';
import { computeTableFacts, summarizeTables } from '../lib/table-facts.js';
import { computeBlockingLayers, computeLayerBands } from '../lib/blocking-layers.js';
import { applyBlockingLayers, applyFactToNode } from '../lib/facts-apply.js';
import { intersectsViewport, summarizePipeline } from '../lib/pipeline-compare.js';
import { refRegistry, shadowRefs } from './state.js';
import { clearFrameAliases, setFrameAliases } from './frames.js';
import { collectCdpFrames } from '../frame-cdp.js';
import { closedShadowEntries } from './closed-shadow.js';
import { boundedTimeout, requireTabId } from './shared.js';
import { axLeaseSnapshot, collectAxNodes, joinAxIntoNodes, mapVomBackendNodeIds, observeAxFallback } from './observation-ax.js';
import { buildLayerFacts, collectVisualFacts, emptyVisualObjects } from './observation-visual.js';
export { visualScan } from './observation-visual.js';
export { axLeaseSnapshot };
const observationCache = new Map();

/** --vom-relation-query 接受对象或 JSON 字符串；非法输入退化为空查询（fail-open 只影响诊断字段）。 */
function parseRelationQuery(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 导航/刷新会重建文档：丢掉旧的观察基线，避免下一次 delta 拿上一页文本做 diff。 */
export function clearObservationCache(tabId) {
  const id = Number(tabId);
  if (Number.isInteger(id)) observationCache.delete(id);
}
// 连续 trusted fill 的聚焦状态缓存：同一标签页 1s 内复用，避免每次重复激活/可见性检查。

export async function observe(params = {}) {
  const policyTabId = requireTabId(params);
  // 新一轮 observe 让旧 frame 别名/closed-shadow ref 失效，避免 @eN 串到另一个元素。
  clearFrameAliases(policyTabId);
  shadowRefs.delete(policyTabId);
  if (params.vom === true && (params.cursor || Number(params.maxTokens) > 0)) {
    throw bridgeError('E_BAD_ARG', '--vom 不能与 --cursor/--max-tokens 同时使用');
  }
  if (params.fallbackAx === true && (params.vom === true || params.ax === true)) {
    throw bridgeError('E_BAD_ARG', 'AX 兜底观察不支持 --vom/--ax（没有 page-lib ref）');
  }
  if (params.pipeline === 'ax' && (params.vom === true || params.ax === true || params.fallbackAx === true)) {
    throw bridgeError('E_BAD_ARG', '--pipeline ax 是独立的备用采集器，不能与 --vom/--ax/--fallback-ax 组合');
  }
  const observeTabId = Number.isInteger(params.tabId) ? params.tabId : null;
  if (observeTabId != null && (params.closedShadow || params.cursor || params.maxTokens)) clearFrameAliases(observeTabId);
  const tabId = requireTabId(params);
  const issues = [];
  const noteIssue = (stage, error) => {
    issues.push({ stage, reason: String((error && error.message) || error || 'unknown').slice(0, 240) });
  };
  // 多 frame 页面的默认观察是合并文本；delta 必须用同一份合并文本做基线，
  // 否则会拿主 frame 文本去 diff 合并文本，把其它 frame 整个删掉。
  if (params.delta === true && params.force !== true && chrome.webNavigation && typeof chrome.webNavigation.getAllFrames === 'function') {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
    if (frames && frames.length > 1) return observeSmart(params);
  }
  if (params.pipeline === 'ax') {
    const observed = await observeAxFallback(tabId, params, { buildNodes: true, pipeline: 'ax' });
    if (!observed) throw bridgeError('E_INTERNAL', 'AX 采集器不可用（页面无可访问的 AX 树）');
    return observed;
  }
  const observeStartedAt = Date.now();
  let base;
  if (params.fallbackAx === true) {
    base = await observeAxFallback(tabId, params);
    if (!base) throw bridgeError('E_INTERNAL', 'AX 兜底观察不可用（页面无可访问的 AX 树）');
    log('按请求使用 AX 兜底观察 tab=' + tabId);
  } else {
    try {
      base = await execPage(tabId, 'observe', {
        probeHover: params.probeHover === true,
        maxDepth: params.maxDepth,
        debugSurfaces: params.debugSurfaces === true,
        vom: params.vom === true,
        vomDeep: params.vomDeep === true,
        deepMaxTokens: params.deepMaxTokens,
        markVom: params.vom === true && (params.ax === true || params.facts === true),
        force: params.force === true,
        delta: params.delta === true,
        baseline: params.baseline,
        collectNodes: true,
      });
    } catch (error) {
      noteIssue('observe', error);
      if (params.fallback === false) throw error;
      let fallback = null;
      try {
        fallback = await observeAxFallback(tabId, params);
      } catch {
        fallback = null;
      }
      if (!fallback) throw error;
      log('observe 失败，已降级为 AX 观察：' + ((error && error.message) || error));
      base = fallback;
    }
  }
  const pageLibMs = Date.now() - observeStartedAt;
  // 六阶段捕获漏斗从这里开始：collect = 页面库采集（含页面侧丢弃原因），
  // resolve = 扩展侧深观察合并/身份解析。后续 filter/enrich/rank/emit 在 VOM 管线里记录。
  const captureTrace = createCaptureTrace({
    meta: {
      tabId,
      mode: params.vom === true ? 'vom' : 'text',
      pipeline: params.fallbackAx === true ? 'ax-fallback' : 'page-lib',
    },
  });
  const pageNodeCount = Array.isArray(base && base.nodes) ? base.nodes.length : 0;
  const pageStages = base && base.stages ? captureStagesFromPageStages(base.stages) : [];
  const pageCaptureReport = base && base.stages ? pageStagesCaptureReport(base.stages) : null;
  const pageCollected = pageStages.length ? pageStages[0].input : pageNodeCount;
  const pageDropReasons = [];
  for (const stage of pageStages) for (const item of stage.dropReasons) pageDropReasons.push(item);
  captureTrace.record('collect', {
    input: pageCollected,
    output: pageNodeCount,
    dropped: Math.max(0, pageCollected - pageNodeCount),
    dropReasons: pageDropReasons,
    ms: pageLibMs,
    meta: {
      source: base && base.fallback ? 'ax-fallback' : 'page-lib',
      pageElapsedMs: base && base.stages ? Number(base.stages.elapsedMs) || null : null,
      pageTokens: base && base.stages ? Number(base.stages.tokens) || null : null,
    },
  });
  const observeArgs = {
    probeHover: params.probeHover === true,
    maxDepth: params.maxDepth,
    debugSurfaces: params.debugSurfaces === true,
    vom: params.vom === true,
    markVom: params.vom === true && (params.ax === true || params.facts === true),
    force: params.force === true,
    delta: params.delta === true,
    baseline: params.baseline,
    collectNodes: true,
  };
  const earlyEligible = params.closedShadow !== true && params.vom !== true && params.ax !== true
    && params.facts !== true && !params.maxTokens && params.cursor === undefined && params.force !== true;
  // 页面没变：不生成/传输全文。daemon 用缓存补文本；调用方拿到 unchanged 即可。
  if (base && base.unchanged === true) {
    if (earlyEligible) {
      const prior = observationCache.get(tabId);
      return {
        observation: '',
        unchanged: true,
        observationId: prior ? prior.id : observationId(tabId),
        refs: typeof base.refs === 'number' ? base.refs : 0,
        url: base.url || (prior && prior.url) || '',
        title: base.title || (prior && prior.title) || '',
        issues: Array.isArray(issues) ? issues : [],
        ...(base.mutations ? { mutations: base.mutations } : {}),
        ...(base.blocking ? { blocking: base.blocking } : {}),
      };
    }
    // 需要全文的调用（closed-shadow / vom / ax / facts / 分页）不能复用空文本：强制重取。
    base = await execPage(tabId, 'observe', { ...observeArgs, force: true });
  }
  let observation = String(base.observation || '');
  let closedShadow = null;
  if (params.closedShadow === true) {
    await acquire(tabId, 'closed-shadow');
    try {
      await cdpSend(tabId, 'DOM.enable').catch(() => {});
      closedShadow = await closedShadowEntries(tabId);
      const map = new Map();
      let next = (typeof base.refs === 'number' ? base.refs : 0) + 1;
      const suffix = [];
      for (const entry of closedShadow) {
        const ref = '@e' + next++;
        map.set(ref, entry);
        entry.ref = ref;
        suffix.push('- ' + ref + ' ' + entry.tag + ' ' + JSON.stringify(entry.text) + '  (closed shadow)');
      }
      shadowRefs.set(tabId, map);
      if (suffix.length) observation += '\n' + suffix.join('\n');
    } finally {
      await release(tabId, 'closed-shadow').catch(() => {});
    }
  }

  // --facts 先抓一次 DOMSnapshot：其中已带页面侧 data-bb-vom 标记，用它直接映射 backendNodeId，
  // 大数据页可省掉一次 DOM.getDocument(pierce)。
  let factsMap = null;
  let factsCaptured = false;
  let backendMap = null;
  let backendMarked = false;
  if (params.facts === true) {
    try {
      const snapshot = await captureDomSnapshot(tabId);
      factsMap = snapshot.facts;
      factsCaptured = true;
      if (params.vom === true && Array.isArray(base.nodes) && snapshot.vomIds && snapshot.vomIds.size) {
        backendMap = snapshot.vomIds;
      }
    } catch (error) {
      factsMap = null;
      noteIssue('facts', error);
      log('DOMSnapshot 事实采集失败（忽略）：' + ((error && error.message) || error));
    }
  }

  let axNodes = Array.isArray(base.axNodes) ? base.axNodes : null;
  if (params.ax === true && !axNodes) {
    try {
      axNodes = await collectAxNodes(tabId);
    } catch (error) {
      axNodes = [];
      log('AX 树采集失败：' + ((error && error.message) || error));
    }
  }

  let axJoin = null;
  if (axNodes && params.vom === true && Array.isArray(base.nodes) && base.nodes.length) {
    if (!backendMap) {
      try {
        backendMap = await mapVomBackendNodeIds(tabId);
        backendMarked = true;
      } catch (error) {
        log('VOM backendNodeId 映射失败，退回 role+name：' + ((error && error.message) || error));
      }
    }
    try {
      axJoin = joinAxIntoNodes(base.nodes, axNodes, backendMap);
    } finally {
      await execPage(tabId, 'clear-vom-markers', {}).catch(() => {});
      backendMarked = false;
    }
  }

  // 把映射到的 backendNodeId 写回节点，供事实富化使用；snapshot 没给映射时回退 DOM.getDocument。
  if (params.facts === true && params.vom === true && Array.isArray(base.nodes) && base.nodes.length) {
    if (!backendMap) {
      try {
        backendMap = await mapVomBackendNodeIds(tabId);
        backendMarked = true;
      } catch (error) {
        log('VOM backendNodeId 映射失败：' + ((error && error.message) || error));
      }
    }
    if (backendMap) {
      for (const node of base.nodes) {
        if (!node || node.backendNodeId) continue;
        const backend = node.vomId ? backendMap.get(node.vomId) : null;
        if (backend) node.backendNodeId = backend;
      }
    }
  }

  let factsSummary = null;
  if (params.facts === true && factsCaptured && factsMap) {
    const apply = (target) => {
      if (!target || !Number.isInteger(target.backendNodeId)) return 0;
      const fact = factsMap.get(target.backendNodeId);
      if (!fact) return 0;
      applyFactToNode(target, fact);
      return 1;
    };
    let axMatched = 0;
    for (const ax of axNodes || []) axMatched += apply(ax);
    let vomMatched = 0;
    for (const node of Array.isArray(base.nodes) ? base.nodes : []) {
      vomMatched += apply(node);
      if (node && node.ax) apply(node.ax);
    }
    factsSummary = { nodes: factsMap.size, axMatched, vomMatched };
  }

  let hiddenRefs = [];
  if (factsSummary) {
    hiddenRefs = collectHiddenRefs(base.nodes);
    if (hiddenRefs.length) {
      observation = annotateHiddenRefs(observation, hiddenRefs);
      factsSummary.hiddenRefs = hiddenRefs.length;
    }
  }

  let unmappedAx = [];
  let tableSummary = [];
  if (params.ax === true && params.vom === true && Array.isArray(axNodes) && axNodes.length) {
    const matchedBackend = new Set();
    for (const node of Array.isArray(base.nodes) ? base.nodes : []) {
      if (node && Number.isInteger(node.backendNodeId)) matchedBackend.add(node.backendNodeId);
    }
    unmappedAx = collectUnmappedAx(axNodes, matchedBackend, factsMap, { limit: 20 });
    if (unmappedAx.length) {
      observation += '\n\n── 未映射的可交互元素（AX/DOMSnapshot，仅供定位）──\n' + renderUnmappedAx(unmappedAx);
    }
    // 表格/网格结构事实：AX 层级 → row/col/header；同时给 AX 节点与匹配的 VOM 节点。
    const tableFacts = computeTableFacts(axNodes);
    if (tableFacts.size) {
      for (const ax of axNodes) {
        if (!ax || !Number.isInteger(ax.backendNodeId)) continue;
        const fact = tableFacts.get(ax.backendNodeId);
        if (fact) ax.table = fact;
      }
      for (const node of Array.isArray(base.nodes) ? base.nodes : []) {
        if (!node || !Number.isInteger(node.backendNodeId)) continue;
        const fact = tableFacts.get(node.backendNodeId);
        if (fact) node.table = fact;
      }
    }
    tableSummary = summarizeTables(axNodes);
  }

  let blockingLayers = [];
  if (params.ax === true && factsMap) {
    try {
      blockingLayers = computeBlockingLayers(axNodes, factsMap);
      if (blockingLayers.length) applyBlockingLayers(base.nodes, blockingLayers);
    } catch (error) {
      blockingLayers = [];
      noteIssue('layers', error);
      log('阻挡层推导失败（忽略）：' + ((error && error.message) || error));
    }
  }

  if (params.vomDeep === true && base && !base.deepVom) {
    try {
      base.deepVom = await execPage(tabId, 'deep-vom', { deepMaxTokens: params.deepMaxTokens });
      if (base.deepVom && base.deepVom.stages) base.deepVom.vomFunnel = summarizeVomFunnel(base.deepVom.stages);
    } catch {
      // 深观察失败不影响普通观察
    }
  }

  if (base && base.deepVom && base.deepVom.stages && !base.deepVom.vomFunnel) {
    base.deepVom = { ...base.deepVom, vomFunnel: summarizeVomFunnel(base.deepVom.stages) };
  }

  // VOM 默认走深观察的绘制序/去重结果；字段仍用树观察的富化节点，文本观察不受影响。
  const resolveStartedAt = Date.now();
  if (params.vom === true && params.vomTree !== true) {
    try {
      const deep = base.deepVom || await execPage(tabId, 'deep-vom', { deepMaxTokens: params.deepMaxTokens });
      if (deep && Array.isArray(deep.nodes) && deep.nodes.length) {
        const original = Array.isArray(base.nodes) ? base.nodes : [];
        const byRef = new Map(original.map((node) => [node.ref, node]));
        const used = new Set();
        const refined = deep.nodes.map((item) => {
          const rich = byRef.get(item.ref);
          if (item.ref) used.add(item.ref);
          return rich ? { ...rich } : { ...item };
        });
        // 深观察未覆盖的树节点（如纯文本段落）追加在末尾，保证信息不丢。
        for (const node of original) {
          if (!node.ref || !used.has(node.ref)) refined.push(node);
        }
        base.nodes = refined;
        base.vomPipeline = 'deep-refined';
        base.vomRefined = { before: byRef.size, after: base.nodes.length };
      }
    } catch {
      // 深观察失败时保留树观察节点
    }
  }
  const resolvedNodes = Array.isArray(base.nodes) ? base.nodes : [];
  const resolveDropped = Math.max(0, pageNodeCount - resolvedNodes.length);
  captureTrace.record('resolve', {
    input: pageNodeCount,
    output: resolvedNodes.length,
    dropped: resolveDropped,
    dropReasons: resolveDropped ? [{ reason: 'deduped-by-ref', count: resolveDropped }] : [],
    ms: Date.now() - resolveStartedAt,
    meta: {
      pipeline: base.vomPipeline || null,
      refined: base.vomRefined || null,
    },
  });

  // 分层文档：优先用 paint-order 带（固定/铺满视口的遮挡层），否则退回页面侧提示。
  const layerBands = factsCaptured && factsMap ? computeLayerBands(axNodes, factsMap) : [];
  const layerFacts = layerBands.length ? layerBands : buildLayerFacts(blockingLayers, base);
  if (layerFacts.length) observation += '\n\n' + formatLayerSummary(base.url || '', layerFacts);

  // ref 详情提前构建：视觉对象也要带上 stableRef/backendNodeId，才能直接驱动动作。
  const refDetails = buildRefDetails(base.nodes, { frameId: 0, revision: base.revision, documentId: base.url || 'main', cdpSessionId: tabId + ':0' });
  let scoredNodes = base.nodes;
  let vomBudgetDropped = { nodes: 0, tokens: 0 };
  let effectiveVomMinScore = null;
  let effectiveExcludeHidden = false;
  let vomCompacted = null;
  let effectiveSemanticFiltered = null;
  let vomBudgetReport = null;
  let vomVisibilityGate = null;
  let vomGroupBudget = null;
  let captureReport = null;
  let emitStartedAt = 0;
  const customVomWeights = params.vomWeights && typeof params.vomWeights === 'object' ? params.vomWeights : null;
  if (params.vom === true) {
    const profile = resolveVomProfile(params.vomProfile);
    const budgetInput = params.vomBudget && typeof params.vomBudget === 'object' ? params.vomBudget : {};
    const budgetPlan = normalizeVomBudget({
      maxNodes: params.vomMaxNodes !== undefined ? params.vomMaxNodes : (budgetInput.maxNodes !== undefined ? budgetInput.maxNodes : profile && profile.maxNodes),
      maxTokens: params.vomMaxTokens !== undefined ? params.vomMaxTokens : (budgetInput.maxTokens !== undefined ? budgetInput.maxTokens : profile && profile.maxTokens),
      top: params.vomTop > 0 ? params.vomTop : budgetInput.top,
      groups: budgetInput.maxGroups !== undefined ? budgetInput.maxGroups : budgetInput.groups,
      groupTokens: budgetInput.groupTokens,
    });
    // enrich：打分（affordance/层/关系在 payload 构建时补，计分仍是排序依据）。
    const enrichStartedAt = Date.now();
    scoredNodes = attachVomScores(base.nodes, customVomWeights ? { weights: customVomWeights } : {});
    const enrichMs = Date.now() - enrichStartedAt;
    const enrichOutput = scoredNodes.length;
    const effectiveMinScore = params.vomMinScore !== undefined ? params.vomMinScore : profile && profile.minScore !== undefined ? profile.minScore : undefined;
    effectiveVomMinScore = effectiveMinScore === undefined ? null : effectiveMinScore;
    // filter：语义组预算 + 组预算 + 统一可见性/遮挡 gate + 最低分。
    const filterStartedAt = Date.now();
    const filterInput = scoredNodes.length;
    const filterDrops = [];
    let semanticFiltered = null;
    if (params.vomSemanticMaxGroups || params.vomSemanticMinScore || params.vomSemanticMaxTokens) {
      const entries = scoredNodes.map((node, index) => ({ id: String(node.ref || node.stableRef || ('n' + index)), node }));
      const semantic = buildVomSemanticGraph(entries);
      const filtered = applySemanticBudget(entries, semantic, {
        maxGroups: params.vomSemanticMaxGroups,
        minGroupScore: params.vomSemanticMinScore,
        maxGroupTokens: params.vomSemanticMaxTokens,
        includeContext: params.vomGroupContext === true,
      });
      if (filtered) {
        scoredNodes = scoredNodes.filter((node, index) => filtered.ids.has(String(node.ref || node.stableRef || ('n' + index))));
        semanticFiltered = {
          groups: filtered.groups,
          dropped: filtered.dropped,
          tokensUsed: filtered.tokensUsed,
          contextGroups: filtered.contextGroups || 0,
          groupsDropped: filtered.groupsDropped || 0,
          totalGroups: filtered.totalGroups || 0,
        };
        effectiveSemanticFiltered = semanticFiltered;
        if (filtered.dropped > 0) filterDrops.push({ reason: 'semantic-group-budget', count: filtered.dropped });
      }
    }
    // 组预算（--vom-budget.groups）：保留得分最高的 N 组，未分组节点保留；trimVomGroups 的运行路径。
    if (budgetPlan.groups > 0) {
      const entries = scoredNodes.map((node, index) => ({ id: String(node.ref || node.stableRef || ('n' + index)), node }));
      const semantic = buildVomSemanticGraph(entries);
      const trim = trimVomGroups(semantic.nodes, {
        maxGroups: budgetPlan.groups,
        maxTokens: budgetPlan.groupTokens,
        costOf: (group) => Number(group && group.tokens) || 0,
      });
      const grouped = new Set(semantic.nodes.flatMap((group) => (Array.isArray(group.memberIds) ? group.memberIds : [])));
      const keep = new Set(trim.groups.flatMap((group) => (Array.isArray(group.memberIds) ? group.memberIds : [])));
      const beforeGroup = scoredNodes.length;
      scoredNodes = scoredNodes.filter((node, index) => {
        const id = String(node.ref || node.stableRef || ('n' + index));
        return !grouped.has(id) || keep.has(id);
      });
      vomGroupBudget = { ...trim, droppedNodes: beforeGroup - scoredNodes.length, groupLimit: budgetPlan.groups };
      if (vomGroupBudget.droppedNodes > 0) filterDrops.push({ reason: 'group-limit', count: vomGroupBudget.droppedNodes });
    }
    // 统一 gate：excludeHidden 只丢“画不出来”；vomExcludeOccluded 再丢遮挡/pointer-events/回收行。
    const excludeHidden = params.vomExcludeHidden === true || (profile && profile.excludeHidden === true);
    effectiveExcludeHidden = excludeHidden;
    const gateMode = params.vomExcludeOccluded === true ? 'interactable' : (excludeHidden ? 'paintable' : null);
    if (gateMode) {
      const gate = applyVisibilityGate(scoredNodes, { mode: gateMode });
      scoredNodes = gate.nodes;
      vomVisibilityGate = summarizeVisibilityGate(gate);
      for (const [reason, count] of Object.entries(gate.counts.byReason)) filterDrops.push({ reason, count });
    }
    if (effectiveMinScore !== undefined) {
      const beforeScore = scoredNodes.length;
      scoredNodes = filterVomNodes(scoredNodes, effectiveMinScore);
      const droppedByScore = beforeScore - scoredNodes.length;
      if (droppedByScore > 0) filterDrops.push({ reason: 'min-score', count: droppedByScore });
    }
    const filterOutput = scoredNodes.length;
    captureTrace.record('filter', {
      input: filterInput,
      output: filterOutput,
      dropped: Math.max(0, filterInput - filterOutput),
      dropReasons: filterDrops,
      ms: Date.now() - filterStartedAt,
      meta: {
        minScore: effectiveMinScore === undefined ? null : Number(effectiveMinScore),
        excludeHidden,
        gate: gateMode,
        semanticGroups: semanticFiltered ? semanticFiltered.groups : null,
        groupBudget: vomGroupBudget ? vomGroupBudget.kept : null,
      },
    });
    captureTrace.record('enrich', {
      input: filterOutput,
      output: filterOutput,
      dropped: 0,
      dropReasons: [],
      ms: enrichMs,
      meta: { scored: enrichOutput, weights: VOM_WEIGHTS_VERSION },
    });
    // rank：排序 + 分组压缩（top 在 emit 的预算里裁）。
    const rankStartedAt = Date.now();
    const rankInput = scoredNodes.length;
    const rankDrops = [];
    if (params.vomRank === true) scoredNodes = rankVomNodes(scoredNodes, customVomWeights ? { weights: customVomWeights } : {});
    const compacted = compactVomNodes(scoredNodes, { perGroup: params.vomPerGroup, maxGroupTokens: params.vomGroupTokens });
    scoredNodes = compacted.nodes;
    vomCompacted = compacted;
    if (compacted.dropped > 0) rankDrops.push({ reason: 'group-compact', count: compacted.dropped });
    const rankOutput = scoredNodes.length;
    captureTrace.record('rank', {
      input: rankInput,
      output: rankOutput,
      dropped: Math.max(0, rankInput - rankOutput),
      dropReasons: rankDrops,
      ms: Date.now() - rankStartedAt,
      meta: { ranked: params.vomRank === true, perGroup: params.vomPerGroup !== undefined ? Number(params.vomPerGroup) : null },
    });
    // emit：token/node/top 预算强制裁剪（计费口径仍是 name+role 的 estimateVomTokens）。
    emitStartedAt = Date.now();
    const emitInput = scoredNodes.length;
    const groupTrimTotal = (semanticFiltered ? Math.max(0, Number(semanticFiltered.groupsDropped) || 0) : 0)
      + (vomGroupBudget ? Math.max(0, Number(vomGroupBudget.dropped) || 0) : 0);
    const budgetOutcome = buildVomBudgetReport({
      nodes: scoredNodes,
      nodeBudget: { maxNodes: budgetPlan.nodes, maxTokens: budgetPlan.tokens },
      groupTrim: { dropped: groupTrimTotal },
      top: budgetPlan.top,
    });
    scoredNodes = budgetOutcome.nodes;
    vomBudgetDropped = { nodes: budgetOutcome.trimmed.nodes, tokens: budgetOutcome.trimmed.tokens };
    vomBudgetReport = {
      budget: { nodes: budgetOutcome.budget.nodes, tokens: budgetOutcome.budget.tokens },
      used: { nodes: budgetOutcome.used.nodes, tokens: budgetOutcome.used.tokens },
      trimmed: {
        groups: budgetOutcome.trimmed.groups,
        nodes: budgetOutcome.trimmed.nodes,
        tokens: budgetOutcome.trimmed.tokens,
      },
      reason: budgetOutcome.reason,
      active: budgetOutcome.active,
      text: summarizeVomBudget(budgetOutcome),
    };
    const emitReasonCounts = {};
    for (const drop of budgetOutcome.drops) emitReasonCounts[drop.reason] = (emitReasonCounts[drop.reason] || 0) + 1;
    captureTrace.record('emit', {
      input: emitInput,
      output: scoredNodes.length,
      dropped: Math.max(0, emitInput - scoredNodes.length),
      dropReasons: Object.entries(emitReasonCounts).map(([reason, count]) => ({ reason, count })),
      ms: Date.now() - emitStartedAt,
      meta: {
        budget: { nodes: budgetPlan.nodes, tokens: budgetPlan.tokens, groups: budgetPlan.groups },
        top: budgetPlan.top || null,
      },
    });
  }

  // VOM 观察同时返回视觉候选区域（canvas/图片/自绘区域），供截图/按图动作直接引用。
  let visualRegions = null;
  let visualRefs = null;
  let visualObjects = emptyVisualObjects();
  if (params.vom === true) {
    const visual = await collectVisualFacts(tabId);
    visualRegions = visual.visualRegions;
    visualRefs = visual.visualRefs;
    visualObjects = visual.visualObjects;
    const detailByRef = new Map(refDetails.map((detail) => [detail.ref, detail]));
    for (const object of visualObjects) {
      if (!object || object.kind !== 'ref') continue;
      const detail = detailByRef.get(object.ref);
      if (!detail) continue;
      object.stableRef = detail.stableRef;
      object.backendNodeId = detail.backendNodeId;
    }
  }
  // 视觉对象稳定身份（跨 observe 复用 voId）：上一轮对象来自 observationCache，
  // 匹配上就保留旧 voId 并标 stable/moved/resized/replaced，没匹配上才记 added。
  let visualIdentity = null;
  if (params.vom === true) {
    const previousObservation = observationCache.get(tabId);
    visualIdentity = assignVisualIdentity(visualObjects, {
      previous: previousObservation && Array.isArray(previousObservation.visualObjects) ? previousObservation.visualObjects : [],
      revision: typeof base.revision === 'number' ? base.revision : null,
      previousRevision: previousObservation && typeof previousObservation.revision === 'number' ? previousObservation.revision : null,
      documentId: base.url || '',
    });
    visualObjects = visualIdentity.objects;
  }
  const vomNodes = scoredNodes.map((node) => ({
    ...node,
    stableRef: node.stableRef || (refDetails.find((detail) => detail.ref === node.ref) || {}).stableRef || null,
  }));
  // 绘制栈/遮挡链：层事实 + 节点几何 → 有序绘制栈、每个节点的遮挡者链与命中测试。
  // 没有层/几何时模型会给出 missing 证据，而不是假装知道绘制顺序。
  let vomZOrder = null;
  let zorderModel = null;
  if (params.vom === true) {
    zorderModel = buildZOrderModel({ layers: layerFacts, nodes: vomNodes, viewport: base.viewport || null });
    vomZOrder = summarizeZOrder(zorderModel);
  }
  if (params.vom === true && (!params.vomBillingModel || params.vomBillingModel === 'o200k')) await loadO200k();
  const vomBilling = params.vom === true ? createBillingLedger(vomNodes, params.vomBillingModel ? { model: String(params.vomBillingModel) } : {}) : null;
  const vomPayload = params.vom === true
    ? buildVomPayload({
      nodes: vomNodes,
      layers: layerFacts,
      visual: visualObjects,
      issues,
      documentId: base.url || '',
      revision: base.revision,
      facts: factsSummary,
      graph: base.graph || null,
      axNodes: params.ax === true && Array.isArray(axNodes) ? axNodes : null,
      // opt-in 语义压缩：true / 选项对象都接受；默认不压缩（不改变既有输出与计费）。
      compress: params.vomCompress === true || (params.vomCompress && typeof params.vomCompress === 'object')
        ? params.vomCompress
        : null,
    })
    : null;
  // 关系查询（opt-in）：按 kind/role/name 过滤 + 分页 + 摘要，直接跑在 payload 的关系图上。
  const relationQuery = params.vom === true && vomPayload && params.vomRelationQuery
    ? queryVomRelations(vomPayload.relations, parseRelationQuery(params.vomRelationQuery), vomPayload.nodes)
    : null;
  // emit 阶段要把 payload 序列化算进去；capture 报告并入 payload 供 daemon/诊断单点读取。
  if (params.vom === true) {
    captureTrace.record('emit', { ms: Date.now() - emitStartedAt });
    captureReport = captureTrace.report();
    if (vomPayload) vomPayload.capture = captureReport;
  }
  // 关系全链（containment/ownership/labels/controls/describes/invalidates）+ 路径查询：
  // 直接消费 payload.relations，不重新推导边；悬空端点/环等完整性结果一并输出。
  let vomRelationChains = null;
  let vomRelationPaths = null;
  let vomVisualIdentity = null;
  let vomEvidence = null;
  if (params.vom === true) {
    if (vomPayload && vomPayload.relations) {
      const chainReport = buildRelationChains(vomPayload.relations, { nodes: vomPayload.nodes, limits: { nodes: 32, depth: 3 } });
      vomRelationChains = summarizeRelationChains(chainReport, { nodes: 16 });
    }
    const chainQuery = params.vomRelationQuery ? parseRelationQuery(params.vomRelationQuery) : null;
    if (vomPayload && chainQuery && chainQuery.path && typeof chainQuery.path === 'object') {
      vomRelationPaths = findRelationPaths(vomPayload.relations, {
        from: chainQuery.path.from,
        to: chainQuery.path.to,
        types: Array.isArray(chainQuery.path.types) ? chainQuery.path.types : undefined,
        maxDepth: chainQuery.path.maxDepth,
        limit: chainQuery.path.limit,
      });
    }
    vomVisualIdentity = summarizeVisualIdentity(visualIdentity, {
      nodes: Array.isArray(base.nodes) ? base.nodes : [],
      dpr: base.dpr,
      viewport: base.viewport || null,
    });
    // 证据/降级报告：token/节点/分组/边预算 + 各阶段丢弃原因 + 缺失证据（不伪造）。
    vomEvidence = summarizeEvidence(buildEvidenceReport({
      capture: captureReport,
      budget: vomBudgetReport,
      layers: layerFacts,
      graph: vomPayload ? vomPayload.graph : null,
      relations: vomPayload ? vomPayload.relations : null,
      visual: visualObjects,
      axNodes,
      billing: vomBilling,
      gate: vomVisibilityGate,
      zorder: vomZOrder,
      issues,
      fallback: base.fallback ? String(base.fallback) : null,
      visualBlocked: vomVisualIdentity ? vomVisualIdentity.blockedReasons : null,
      limits: { degradations: 32, missing: 16 },
    }));
    if (vomPayload) {
      // payload 只追加新字段；既有字段（version/stages/edges/graph/layers/...）原样保留。
      if (vomZOrder) vomPayload.zorder = vomZOrder;
      if (vomRelationChains) vomPayload.relationChains = vomRelationChains;
      if (vomVisualIdentity) vomPayload.visualIdentity = vomVisualIdentity;
      vomPayload.evidence = vomEvidence;
    }
  }

  // 双跑对照（诊断）：独立跑一次 AX+DOMSnapshot 管线，量化覆盖率与耗时，不影响主输出。
  let pipelineCompare = null;
  if (params.compareAx === true) {
    try {
      // 对照前收起 BridgeDeck 自身浮层，避免把“暂停 Agent/停止任务”算成页面交互元素。
      await hideTakeover(tabId, { preserveState: true }).catch(() => {});
      await sleep(300);
      const axStarted = Date.now();
      const compareAx = await collectAxNodes(tabId, 800);
      // 给 VOM 节点打临时标记，随后用同一张 DOMSnapshot 解出 vomId→backendNodeId，
      // 这样即使主观察没开 --vom 也能计算 AX→VOM 覆盖率。
      try {
        await execPage(tabId, 'observe', { vom: true, markVom: true, maxDepth: params.maxDepth });
      } catch {
        // 页面可能不允许注入；覆盖率退化为 0
      }
      let compareFacts = null;
      let compareVomIds = null;
      try {
        const snapshot = await captureDomSnapshot(tabId);
        compareFacts = snapshot.facts;
        compareVomIds = snapshot.vomIds;
      } catch {
        compareFacts = null;
        compareVomIds = null;
      }
      await execPage(tabId, 'clear-vom-markers', {}).catch(() => {});
      const compareText = renderAxObservation(compareAx, compareFacts, { maxNodes: 120 });
      const axMs = Date.now() - axStarted;
      const vomBackends = new Set(compareVomIds ? [...compareVomIds.values()] : []);
      for (const node of Array.isArray(base.nodes) ? base.nodes : []) {
        if (node && Number.isInteger(node.backendNodeId)) vomBackends.add(node.backendNodeId);
      }
      const rootAx = compareAx.find((node) => String(node.role || '').toLowerCase() === 'rootwebarea'
        && compareFacts && compareFacts.get(node.backendNodeId) && compareFacts.get(node.backendNodeId).bounds);
      const viewport = rootAx ? compareFacts.get(rootAx.backendNodeId).bounds : null;
      const interactive = compareAx.filter((node) => {
        if (!isInteractiveAxRole(node.role)) return false;
        if (compareFacts === null) return true;
        const fact = compareFacts.get(node.backendNodeId);
        if (!fact) return true;
        if (fact.visible === false) return false;
        return intersectsViewport(fact.bounds, viewport);
      });      const matched = interactive.filter((node) => Number.isInteger(node.backendNodeId) && vomBackends.has(node.backendNodeId)).length;
      pipelineCompare = summarizePipeline({
        pageLib: { ms: pageLibMs, refs: base.refs || 0, text: base.observation || '' },
        ax: { ms: axMs, nodes: compareAx.length, text: compareText },
        interactiveTotal: interactive.length,
        matched,
      });
      showTakeover(tabId, {}).catch(() => {});
    } catch (error) {
      pipelineCompare = null;
      showTakeover(tabId, {}).catch(() => {});
      log('双跑对照失败（忽略）：' + ((error && error.message) || error));
    }
  }

  if (backendMarked || (params.facts === true && params.vom === true)) {
    await execPage(tabId, 'clear-vom-markers', {}).catch(() => {});
    backendMarked = false;
  }

  refRegistry.invalidateTab(tabId);
  for (const detail of refDetails) {
    try {
      refRegistry.register(tabId, detail.ref, {
        backendNodeId: detail.backendNodeId,
        frameId: 0,
        documentId: detail.documentId,
        revision: detail.revision,
      }, { role: detail.role, name: detail.name, stableRef: detail.stableRef });
    } catch {
      // 没有 documentId 的极早观察不注册；不阻塞 observe。
    }
  }

  const budget = Number(params.maxTokens) > 0 ? Math.min(Math.max(Math.round(Number(params.maxTokens)), 200), 20000) : 0;
  let cache = observationCache.get(tabId);
  let offset = 0;
  let baselineReason = '';

  if (params.cursor) {
    let decoded = null;
    try {
      decoded = decodeCursor(params.cursor);
    } catch {
      decoded = null;
    }
    if (!decoded || decoded.t !== tabId) {
      throw bridgeError('E_CURSOR_STALE', 'cursor 不属于当前标签页，请重新 observe');
    }
    if (!cache || cache.at !== decoded.at) {
      throw bridgeError('E_CURSOR_STALE', 'cursor 已过期（页面重新观察过），请重新 observe');
    }
    if (decoded.r != null && cache.revision != null && Number(decoded.r) !== Number(cache.revision)) {
      throw bridgeError('E_CURSOR_STALE', 'cursor 的 revision 已变化，请重新 observe');
    }
    offset = Math.max(0, Number(decoded.o) || 0);
  } else {
    const requestDelta = params.delta === true && typeof params.baseline === 'string' && params.baseline;
    if (requestDelta && cache && cache.id === params.baseline) {
      const diff = diffObservation(cache.text, observation);
      if (diff.kind === 'text' || diff.kind === 'same' || diff.kind === 'structural-text') {
        const id = observationId(tabId);
        const nextCache = { ...cache, text: observation, at: Date.now(), id, url: base.url || cache.url, title: base.title || cache.title };
        observationCache.set(tabId, nextCache);
        return {
          observation: diff.kind === 'same' ? '' : observation,
          delta: true,
          observationId: id,
          baseline: params.baseline,
          patch: diff.patch,
          changes: diff.changes,
          refs: nextCache.refs,
          url: nextCache.url,
          title: nextCache.title,
          issues: Array.isArray(issues) ? issues : [],
          ...(base && base.mutations ? { mutations: base.mutations } : {}),
          ...(base && base.incremental === true ? { incremental: true } : {}),
        };
      }
      baselineReason = diff.reason || 'structural';
    }
    cache = {
      text: observation,
      refs: typeof base.refs === 'number' ? base.refs : 0,
      url: base.url || '',
      title: base.title || '',
      blocking: base.blocking || null,
      revision: typeof base.revision === 'number' ? base.revision : null,
      documentId: base.url || '',
      stages: base.stages ? { ...base.stages, tokens: estimateTokens(observation) } : null,
      refDetails,
      nodeCount: Array.isArray(base.nodes) ? base.nodes.length : -1,
      layers: layerFacts,
      issues,
      visualRegions,
      visualRefs,
      visualObjects,
      vom: vomPayload,
      at: Date.now(),
      id: observationId(tabId),
    };
    observationCache.set(tabId, cache);
  }

  const chunk = takeTokenChunk(cache.text, offset, budget);
  return {
    observation: chunk.text,
    refs: cache.refs,
    refDetails: Array.isArray(cache.refDetails) ? cache.refDetails : [],
    nodeCount: Number.isInteger(cache.nodeCount) ? cache.nodeCount : null,
    layers: Array.isArray(cache.layers) ? cache.layers : [],
    issues: Array.isArray(cache.issues) ? cache.issues : [],
    ...(cache.visualRegions ? { visualRegions: cache.visualRegions } : {}),
    ...(cache.visualRefs ? { visualRefs: cache.visualRefs } : {}),
    ...(Array.isArray(cache.visualObjects) && cache.visualObjects.length ? { visualObjects: cache.visualObjects } : {}),
    ...(cache.vom ? { vom: cache.vom } : {}),
    ...(params.vom === true && vomPayload ? { semantic: vomPayload.semantic, relations: vomPayload.relations, groups: vomPayload.groups, groupEdges: vomPayload.groupEdges, context: vomPayload.context } : {}),
    ...(params.vom === true && vomPayload && vomPayload.compression ? { vomCompression: vomPayload.compression, vomCompressionText: summarizeVomCompression(vomPayload.compression) } : {}),
    ...(relationQuery ? { relationQuery, relationQueryText: summarizeRelationQuery(relationQuery) } : {}),
    // 第九批深度诊断（全部为新增可选字段；未开 --vom 时不出现，默认输出不变）。
    ...(vomRelationPaths ? {
      vomRelationPaths,
      vomRelationPathsText: 'relation paths from=' + String(vomRelationPaths.from || '')
        + ' to=' + String(vomRelationPaths.to || '')
        + ' found=' + (Array.isArray(vomRelationPaths.paths) ? vomRelationPaths.paths.length : 0),
    } : {}),
    ...(params.vom === true && vomZOrder ? { vomZOrder, vomZOrderText: describeZOrder(vomZOrder) } : {}),
    ...(params.vom === true && vomRelationChains ? { vomRelationChains, vomRelationChainsText: describeRelationChains(vomRelationChains) } : {}),
    ...(params.vom === true && vomVisualIdentity ? { vomVisualIdentity, vomVisualIdentityText: describeVisualIdentity(vomVisualIdentity) } : {}),
    ...(params.vom === true && vomEvidence ? { vomEvidence, vomEvidenceText: describeEvidence(vomEvidence) } : {}),
    ...(params.vom === true ? { ariaSnapshot: renderAriaSnapshot(vomNodes), vomWeights: { version: VOM_WEIGHTS_VERSION, tokenSafetyFactor: VOM_TOKEN_SAFETY_FACTOR, estimatedTokens: vomBilling ? vomBilling.totalTokens : (Array.isArray(vomNodes) ? vomNodes : []).reduce((sum, node) => sum + estimateVomTokens(node), 0),
      billing: { ...vomBilling, ...(vomPayload && vomPayload.semantic ? { groups: vomPayload.semantic.stats.groups, grouped: vomPayload.semantic.stats.grouped } : {}) }, budgetPlan: { nodeLimit: vomBudgetReport ? vomBudgetReport.budget.nodes : (params.vomMaxNodes ?? null), tokenLimit: vomBudgetReport ? vomBudgetReport.budget.tokens : (params.vomMaxTokens ?? null), groupLimit: vomBudgetReport ? vomBudgetReport.budget.groups : null, nodes: vomNodes.length, tokens: vomBilling ? vomBilling.totalTokens : 0, semanticGroups: effectiveSemanticFiltered ? effectiveSemanticFiltered.groups : null, semanticTokens: effectiveSemanticFiltered ? effectiveSemanticFiltered.tokensUsed : null, groupDropped: effectiveSemanticFiltered ? effectiveSemanticFiltered.dropped : 0, nodeDropped: vomBudgetDropped, budgetReason: vomBudgetReport ? vomBudgetReport.reason : null, groupBudget: vomGroupBudget ? { limit: vomGroupBudget.groupLimit, kept: vomGroupBudget.kept, droppedNodes: vomGroupBudget.droppedNodes } : null }, ranked: params.vomRank === true, top: params.vomTop > 0 ? Math.round(params.vomTop) : null, minScore: effectiveVomMinScore !== null ? Number(effectiveVomMinScore) : null, profile: params.vomProfile || null, excludeHidden: effectiveExcludeHidden, semanticFiltered: effectiveSemanticFiltered, perGroup: params.vomPerGroup !== undefined ? Number(params.vomPerGroup) : null, groupTokens: params.vomGroupTokens !== undefined ? Number(params.vomGroupTokens) : null, compacted: vomCompacted ? { groups: vomCompacted.groups, dropped: vomCompacted.dropped } : null, budget: vomBudgetDropped, custom: customVomWeights ? Object.keys(customVomWeights) : [] } } : {}),
    // 六阶段捕获漏斗 / 预算裁剪报告 / 统一可见性 gate / 行事实汇总：observe 的一次性诊断出口。
    ...(params.vom === true && captureReport ? { vomCapture: captureReport, vomCaptureText: summarizeCaptureReport(captureReport) } : {}),
    ...(params.vom === true && captureReport && pageCaptureReport ? { vomCaptureChain: chainCaptureReports(pageCaptureReport, captureReport) } : {}),
    ...(params.vom === true && vomBudgetReport ? { vomBudget: vomBudgetReport } : {}),
    ...(params.vom === true && vomPayload && vomPayload.visibility ? { vomVisibility: vomPayload.visibility } : {}),
    ...(vomVisibilityGate ? { visibilityGate: vomVisibilityGate } : {}),
    ...(params.vom === true ? { rowAnchors: summarizeRowAnchors(vomNodes) } : {}),
    ...(cache.stages ? { stages: cache.stages } : {}),
    ...(params.vomExplain === true ? { vomExplain: Object.fromEntries(scoredNodes.map((node) => [String(node.ref || node.name || 'node'), scoreVomNode(node, customVomWeights || {}).factors])) } : {}),
    ...(base.stages ? { vomFunnel: summarizeVomFunnel(base.stages) } : {}),
    ...(base && base.deepVom ? { deepVom: base.deepVom } : {}),
    tokenEstimate: estimateTokens(cache.text),
    ...(budget > 0 ? {
      budget: {
        maxTokens: budget,
        usedTokens: estimateTokens(chunk.text),
        lines: chunk.lines,
        omittedChars: chunk.omittedChars,
        omittedLines: chunk.omittedLines,
        hasMore: chunk.next != null,
      },
    } : {}),
    observationId: cache.id,
    ...(baselineReason ? { baselineReason } : {}),
    ...(base && base.mutations ? { mutations: base.mutations } : {}),
    ...(base && base.incremental === true ? { incremental: true } : {}),
    url: cache.url,
    title: cache.title,
    blocking: cache.blocking || null,
    ...(cache.revision != null ? { revision: cache.revision } : {}),
    offset,
    totalChars: cache.text.length,
    truncated: chunk.next != null,
    cursor: chunk.next != null ? encodeCursor({ t: tabId, o: chunk.next, at: cache.at, r: cache.revision, d: cache.documentId }) : null,
    ...(params.vom === true ? { nodes: Array.isArray(vomNodes) ? vomNodes : [] } : {}),
    ...(axNodes ? { axNodes } : {}),
    ...(axJoin ? { axJoin } : {}),
    ...(factsSummary ? { facts: factsSummary } : {}),
    ...(hiddenRefs.length ? { hiddenRefs } : {}),
    ...(base.fallback ? { fallback: base.fallback } : {}),
    ...(unmappedAx.length ? { unmappedAx } : {}),
    ...(tableSummary.length ? { tables: tableSummary } : {}),
    ...(blockingLayers.length ? { blockingLayers } : {}),
    ...(pipelineCompare ? { pipelineCompare } : {}),
    ...(closedShadow ? { closedShadow } : {}),
    ...(base.downgraded ? { downgraded: true } : {}),
  };
}

export async function snapshot(params = {}) {
  const tabId = requireTabId(params);
  return execPage(tabId, 'snapshot', {});
}

/** get-html */
export async function getHtml(params = {}) {
  const tabId = requireTabId(params);
  return execPage(tabId, 'get-html', {
    ref: params.ref,
    selector: params.selector,
  });
}


/**
 * observe-frames 的深度包装：默认字段原样转发（frames/aliases/frameGaps/... 不变）；
 * --vom 时追加跨帧深度报告（frame 归属链 / iframe→子帧 frame 边 / 隐藏帧与未关联缺口）。
 * 注意：深度报告失败只丢诊断字段，不影响 observe-frames 主结果。
 */
export async function observeFrames(params = {}) {
  const all = await collectObserveFrames(params);
  return attachFrameDepth(all, params);
}

function attachFrameDepth(all, params) {
  if (!all || params.vom !== true) return all;
  try {
    const report = buildFrameDepthReport({
      frames: all.frames,
      vomFrames: all.vomFrames,
      frameGaps: all.frameGaps,
    });
    const summary = summarizeFrameDepth(report);
    return {
      ...all,
      vomFrameDepth: summary,
      vomFrameDepthText: describeFrameDepth(summary),
    };
  } catch {
    return all;
  }
}

/** 默认 observe：页面有 iframe 时把各 frame 一起观察，ref 统一为 @eN。 */
export async function observeSmart(params = {}) {
  const tabId = requireTabId(params);
  const all = await observeFrames({ ...params, smart: true });
  // 跨 frame 关系（opt-in 与 --vom 同源）：每帧子图已由 observe-frames 挂在 frame.vom 上，
  // 这里拼成“frame 作为节点”的关系层；单 frame 页面没有跨帧关系，不产生额外字段。
  let frameRelations = null;
  if (params.vom === true) {
    const frameInputs = (Array.isArray(all.frames) ? all.frames : [])
      .filter((frame) => frame && frame.vom)
      .map((frame) => ({ frameId: frame.frameId, url: frame.url, parentFrameId: frame.parentFrameId, vom: frame.vom }));
    if (frameInputs.length > 1) frameRelations = buildCrossFrameRelations(frameInputs);
  }
  const revision = typeof all.revision === 'number' ? all.revision : null;
  const cache = observationCache.get(tabId);
  const url = all.url || (cache && cache.url) || '';
  const title = all.title || (cache && cache.title) || '';
  if (all.unchanged === true) {
    const id = cache ? cache.id : observationId(tabId);
    return { url, title, observation: '', refs: all.refs || 0, unchanged: true, observationId: id, ...(all.mutations ? { mutations: all.mutations } : {}), ...(revision != null ? { revision } : {}), ...(all.vomFrameDepth ? { vomFrameDepth: all.vomFrameDepth, vomFrameDepthText: all.vomFrameDepthText } : {}) };
  }
  const single = !all.frames || all.frames.length <= 1;
  const main = single ? ((all.frames && all.frames[0]) || { observation: '', refs: 0 }) : null;
  const text = single ? String(main.observation || '') : String(all.text || '');
  const refs = single ? (typeof main.refs === 'number' ? main.refs : 0) : (typeof all.refs === 'number' ? all.refs : 0);
  // --delta：与 observe() 共用同一个 observationCache，保证两条路径的 observationId 一致。
  if (params.delta === true && typeof params.baseline === 'string' && params.baseline && cache && cache.id === params.baseline) {
    const diff = diffObservation(cache.text, text);
    if (diff.kind === 'same' || diff.kind === 'text' || diff.kind === 'structural-text') {
      const id = observationId(tabId);
      observationCache.set(tabId, { text, refs, url, title, blocking: null, at: Date.now(), id });
      return {
        url,
        title,
        observation: diff.kind === 'same' ? '' : text,
        delta: true,
        observationId: id,
        baseline: params.baseline,
        patch: diff.patch,
        changes: diff.changes,
        refs,
        ...(all.mutations ? { mutations: all.mutations } : {}),
        ...(all.cdpFallback ? { cdpFallback: true, cdpFrames: all.cdpFrames } : {}),
        ...(revision != null ? { revision } : {}),
        ...(all.vomFrameDepth ? { vomFrameDepth: all.vomFrameDepth, vomFrameDepthText: all.vomFrameDepthText } : {}),
      };
    }
  }
  const id = observationId(tabId);
  observationCache.set(tabId, { text, refs, url, title, blocking: null, at: Date.now(), id });
  return {
    url,
    title,
    observation: text,
    refs,
    observationId: id,
    ...(single ? {} : { frames: all.frames, aliases: all.aliases }),
    ...(all.mutations ? { mutations: all.mutations } : {}),
    ...(all.cdpFallback ? { cdpFallback: true, cdpFrames: all.cdpFrames } : {}),
    ...(frameRelations ? { vomFrameRelations: frameRelations, vomFrameRelationsText: summarizeCrossFrameRelations(frameRelations) } : {}),
    ...(all.vomFrameDepth ? { vomFrameDepth: all.vomFrameDepth, vomFrameDepthText: all.vomFrameDepthText } : {}),
    ...(revision != null ? { revision } : {}),
  };
}

