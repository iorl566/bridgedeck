// src/tools/observation.js —— observe / observe-frames / snapshot / get-html 与 AX/事实合并。
import { bridgeError } from '../errors.js';
import { execPage, execPageAllFrames } from '../inject.js';
import { sleep } from '../tabs.js';
import { log } from '../log.js';
import { acquire, release, send as cdpSend } from '../debugger.js';
import { hideTakeover, showTakeover } from '../takeover.js';
import { ensureFrameGraph } from '../frame-graph.js';
import { takeTokenChunk } from '../tokens.js';
import { diffObservation, observationId } from '../lib/observation-delta.js';
import { captureDomSnapshot, captureDomSnapshotFacts } from '../dom-snapshot.js';
import { annotateHiddenRefs, collectHiddenRefs } from '../lib/facts-annotate.js';
import { renderAxObservation } from '../lib/ax-render.js';
import { collectUnmappedAx, isInteractiveAxRole, renderUnmappedAx } from '../lib/unmapped-ax.js';
import { computeTableFacts, summarizeTables } from '../lib/table-facts.js';
import { computeBlockingLayers } from '../lib/blocking-layers.js';
import { applyBlockingLayers, applyFactToNode } from '../lib/facts-apply.js';
import { buildAxNodes } from '../lib/ax-pipeline.js';
import { intersectsViewport, summarizePipeline } from '../lib/pipeline-compare.js';
import { shadowRefs } from './state.js';
import { clearFrameAliases, setFrameAliases } from './frames.js';
import { collectCdpFrames } from '../frame-cdp.js';
import { closedShadowEntries } from './closed-shadow.js';
import { boundedTimeout, requireTabId } from './shared.js';
const observationCache = new Map();

/** 导航/刷新会重建文档：丢掉旧的观察基线，避免下一次 delta 拿上一页文本做 diff。 */
export function clearObservationCache(tabId) {
  const id = Number(tabId);
  if (Number.isInteger(id)) observationCache.delete(id);
}
// 连续 trusted fill 的聚焦状态缓存：同一标签页 1s 内复用，避免每次重复激活/可见性检查。

function encodeCursor(value) {
  const json = JSON.stringify(value);
  const base64 = btoa(unescape(encodeURIComponent(json)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(text) {
  const base64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(base64))));
}


/** observe：支持 --max-tokens 截断 + --cursor 续读（与协议约定一致）。 */
/** 通过 data-bb-vom 临时标记把 DOM 节点映射到 backendNodeId（open shadow / 同源 iframe 也遍历）。 */
async function mapVomBackendNodeIds(tabId) {
  const map = new Map();
  await acquire(tabId, 'vom-ax');
  try {
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    const doc = await cdpSend(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    (function walk(node) {
      if (!node) return;
      if (node.nodeType === 1) {
        const attrs = node.attributes || [];
        for (let index = 0; index + 1 < attrs.length; index += 2) {
          if (attrs[index] === 'data-bb-vom') {
            map.set(attrs[index + 1], node.backendNodeId);
            break;
          }
        }
      }
      for (const child of node.children || []) walk(child);
      for (const shadow of node.shadowRoots || []) walk(shadow);
      if (node.contentDocument) walk(node.contentDocument);
    })(doc && doc.root);
  } finally {
    await release(tabId, 'vom-ax').catch(() => {});
  }
  return map;
}

/** AX 与 DOM 节点合并：优先 backendNodeId 精确匹配，退回 role+name。 */
function joinAxIntoNodes(nodes, axNodes, backendMap) {
  const normalize = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 80);
  const keyOf = (role, name) => String(role || '') + '\u0000' + normalize(name);
  const byBackend = new Map();
  const buckets = new Map();
  for (const ax of axNodes) {
    if (ax.backendNodeId) byBackend.set(String(ax.backendNodeId), ax);
    const key = keyOf(ax.role, ax.name);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ax);
  }
  let matched = 0;
  let unmatched = 0;
  let byBackendNodeId = 0;
  let byRoleName = 0;
  for (const node of nodes) {
    if (!node || !node.role) continue;
    let ax = null;
    const backend = backendMap && node.vomId ? backendMap.get(node.vomId) : null;
    if (backend) {
      node.backendNodeId = backend;
      ax = byBackend.get(String(backend)) || null;
      if (ax) byBackendNodeId += 1;
    }
    if (!ax) {
      const list = buckets.get(keyOf(node.role, node.name));
      if (list && list.length) {
        ax = list.shift();
        byRoleName += 1;
      }
    }
    if (!ax) {
      unmatched += 1;
      continue;
    }
    node.ax = { ...ax };
    if (ax.checked !== null && ax.checked !== undefined) node.checked = ax.checked;
    if (ax.disabled === true) node.disabled = true;
    if (ax.expanded !== null && ax.expanded !== undefined) node.expanded = ax.expanded;
    if (ax.focused === true) node.focused = true;
    matched += 1;
  }
  return { matched, unmatched, byBackendNodeId, byRoleName };
}

/** AX 树：只读快照，用于和 DOM VOM 对照（--ax）。 */
// Accessibility 域按 10s 租约开着：连续观察不重复 enable，空闲后主动 disable，
// 避免 CDP 域常驻（租约到期即释放，而不是一直挂着）。
const AX_LEASE_MS = 10_000;
const axLeaseTimers = new Map();
const axLeaseDeadlines = new Map();

/** 当前 AX 域租约（诊断用）：tabId + 剩余毫秒。 */
export function axLeaseSnapshot() {
  const now = Date.now();
  const out = [];
  for (const [tabId, until] of axLeaseDeadlines) {
    const remainingMs = Math.max(0, Number(until) - now);
    if (remainingMs > 0) out.push({ tabId, remainingMs });
    else axLeaseDeadlines.delete(tabId);
  }
  return out;
}

function armAxLease(tabId) {
  const previous = axLeaseTimers.get(tabId);
  if (previous) clearTimeout(previous);
  axLeaseDeadlines.set(tabId, Date.now() + AX_LEASE_MS);
  const timer = setTimeout(() => {
    axLeaseTimers.delete(tabId);
    axLeaseDeadlines.delete(tabId);
    void cdpSend(tabId, 'Accessibility.disable').catch(() => {});
  }, AX_LEASE_MS);
  timer.unref?.();
  axLeaseTimers.set(tabId, timer);
}

async function collectAxNodes(tabId, limit = 1000) {
  await acquire(tabId, 'ax');
  try {
    const pending = axLeaseTimers.get(tabId);
    if (pending) {
      clearTimeout(pending);
      axLeaseTimers.delete(tabId);
      axLeaseDeadlines.delete(tabId);
    }
    await cdpSend(tabId, 'Accessibility.enable').catch(() => {});
    const tree = await cdpSend(tabId, 'Accessibility.getFullAXTree', {});
    const nodes = [];
    const allNodes = tree && Array.isArray(tree.nodes) ? tree.nodes : [];
    const parentById = new Map();
    for (const raw of allNodes) {
      if (raw && raw.nodeId !== undefined) parentById.set(raw.nodeId, raw.parentId);
    }
    const depthMemo = new Map();
    const depthOf = (nodeId) => {
      if (depthMemo.has(nodeId)) return depthMemo.get(nodeId);
      let depth = 0;
      let current = nodeId;
      const seen = new Set();
      while (parentById.has(current)) {
        const parent = parentById.get(current);
        if (parent === undefined || parent === null || seen.has(parent)) break;
        seen.add(parent);
        current = parent;
        depth += 1;
        if (depth >= 20) break;
      }
      depthMemo.set(nodeId, depth);
      return depth;
    };
    for (const node of allNodes) {
      if (!node || node.ignored === true) continue;
      const role = node.role && node.role.value ? String(node.role.value) : '';
      if (!role || role === 'none' || role === 'generic') continue;
      const props = {};
      for (const prop of Array.isArray(node.properties) ? node.properties : []) {
        if (!prop || !prop.name) continue;
        props[prop.name] = prop.value ? prop.value.value : undefined;
      }
      const rawName = node.name && node.name.value != null ? String(node.name.value) : '';
      let rawValue = node.value && node.value.value != null ? String(node.value.value) : '';
      if (props.protected === true || /password/i.test(rawName)) rawValue = rawValue ? '********' : '';
      nodes.push({
        role,
        name: rawName.slice(0, 120),
        value: rawValue.slice(0, 120),
        checked: props.checked === undefined ? null : props.checked,
        disabled: props.disabled === true,
        expanded: props.expanded === undefined ? null : props.expanded,
        focused: props.focused === true,
        required: props.required === true,
        selected: props.selected === undefined ? null : props.selected,
        backendNodeId: node.backendDOMNodeId || null,
        nodeId: node.nodeId !== undefined && node.nodeId !== null ? String(node.nodeId) : null,
        parentId: node.parentId !== undefined && node.parentId !== null ? String(node.parentId) : null,
        depth: depthOf(node.nodeId),
      });
      if (nodes.length >= limit) break;
    }
    return nodes;
  } finally {
    await release(tabId, 'ax').catch(() => {});
    armAxLease(tabId);
  }
}

/** page-lib 观察失败时的 AX 兜底：CDP 仍可用，返回无 ref 的降级语义树。 */
async function observeAxFallback(tabId, params, options = {}) {
  // 先收起 BridgeDeck 自己的浮层，避免 AX 树把接管卡片也当成页面内容。
  // AX 树更新有一拍延迟，移除后稍等一下再取快照。
  await hideTakeover(tabId).catch(() => {});
  await sleep(300);
  let axNodes;
  try {
    axNodes = await collectAxNodes(tabId, 800);
  } finally {
    showTakeover(tabId, {}).catch(() => {});
  }
  if (!axNodes.length) return null;
  let facts = null;
  try {
    facts = await captureDomSnapshotFacts(tabId);
  } catch {
    facts = null;
  }
  const requested = Number(params.maxNodes);
  const observation = renderAxObservation(axNodes, facts, {
    maxNodes: Number.isFinite(requested) && requested > 0 ? requested : 120,
  });
  if (!observation.trim()) return null;
  let pageUrl = '';
  let pageTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab && typeof tab.url === 'string' ? tab.url : '';
    pageTitle = tab && typeof tab.title === 'string' ? tab.title : '';
  } catch {
    // 页面可能已关闭；保留空 url/title
  }
  const factsSummary = facts
    ? {
      nodes: facts.size,
      axMatched: axNodes.filter((node) => Number.isInteger(node.backendNodeId) && facts.has(node.backendNodeId)).length,
      vomMatched: 0,
    }
    : null;
  let nodes = [];
  if (options.buildNodes === true) {
    const limit = Number.isFinite(Number(params.maxNodes)) && Number(params.maxNodes) > 0
      ? Number(params.maxNodes)
      : 200;
    nodes = buildAxNodes(axNodes, facts, { limit });
    const tableFacts = computeTableFacts(axNodes);
    if (tableFacts.size) {
      for (const node of nodes) {
        if (!node || !Number.isInteger(node.backendNodeId)) continue;
        const fact = tableFacts.get(node.backendNodeId);
        if (fact) node.table = fact;
      }
    }
  }
  return {
    observation,
    refs: 0,
    nodes,
    axNodes,
    url: pageUrl,
    title: pageTitle,
    fallback: 'ax',
    downgraded: true,
    ...(options.pipeline ? { pipeline: options.pipeline } : {}),
    ...(factsSummary ? { facts: factsSummary } : {}),
  };
}

/**
 * 视觉候选扫描（visual.scan）：列出当前视口里可作为"看图目标"的区域
 * （canvas / 图片 / 自绘背景区域）。坐标随后由 screenshot --visual <index>
 * 绑定到该区域，命中校验也能判断"点的是不是它"。
 */
export async function visualScan(params = {}) {
  const tabId = requireTabId(params);
  const result = await execPage(tabId, 'visual-scan', {});
  const candidates = result && Array.isArray(result.candidates) ? result.candidates : [];
  return {
    ok: true,
    candidates,
    viewport: (result && result.viewport) || null,
    hint: '用 screenshot --visual <index> 只拍该区域并绑定坐标；随后 click/drag --capture <id> --image-x/--image-y',
  };
}

export async function observe(params = {}) {  if (params.vom === true && (params.cursor || Number(params.maxTokens) > 0)) {
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
        markVom: params.vom === true && (params.ax === true || params.facts === true),
        force: params.force === true,
        delta: params.delta === true,
        baseline: params.baseline,
      });
    } catch (error) {
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
  const observeArgs = {
    probeHover: params.probeHover === true,
    maxDepth: params.maxDepth,
    debugSurfaces: params.debugSurfaces === true,
    vom: params.vom === true,
    markVom: params.vom === true && (params.ax === true || params.facts === true),
    force: params.force === true,
    delta: params.delta === true,
    baseline: params.baseline,
  };
  const earlyEligible = params.closedShadow !== true && params.vom !== true && params.ax !== true
    && params.facts !== true && !params.maxTokens && params.cursor === undefined;
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
      log('阻挡层推导失败（忽略）：' + ((error && error.message) || error));
    }
  }

  // 双跑对照（诊断）：独立跑一次 AX+DOMSnapshot 管线，量化覆盖率与耗时，不影响主输出。
  let pipelineCompare = null;
  if (params.compareAx === true) {
    try {
      // 对照前收起 BridgeDeck 自身浮层，避免把“暂停 Agent/停止任务”算成页面交互元素。
      await hideTakeover(tabId).catch(() => {});
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
      at: Date.now(),
      id: observationId(tabId),
    };
    observationCache.set(tabId, cache);
  }

  const chunk = takeTokenChunk(cache.text, offset, budget);
  return {
    observation: chunk.text,
    refs: cache.refs,
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
    cursor: chunk.next != null ? encodeCursor({ t: tabId, o: chunk.next, at: cache.at }) : null,
    ...(params.vom === true ? { nodes: Array.isArray(base.nodes) ? base.nodes : [] } : {}),
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


/** 默认 observe：页面有 iframe 时把各 frame 一起观察，ref 统一为 @eN。 */
export async function observeSmart(params = {}) {
  const tabId = requireTabId(params);
  const all = await observeFrames({ ...params, smart: true });
  const revision = typeof all.revision === 'number' ? all.revision : null;
  const cache = observationCache.get(tabId);
  const url = all.url || (cache && cache.url) || '';
  const title = all.title || (cache && cache.title) || '';
  if (all.unchanged === true) {
    const id = cache ? cache.id : observationId(tabId);
    return { url, title, observation: '', refs: all.refs || 0, unchanged: true, observationId: id, ...(all.mutations ? { mutations: all.mutations } : {}), ...(revision != null ? { revision } : {}) };
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
    ...(revision != null ? { revision } : {}),
  };
}

/** observe-frames：所有 frame（含跨源）分别观察，ref 统一为 @eN，并记录 frame 映射。 */
export async function observeFrames(params = {}) {
  const tabId = requireTabId(params);
  const allowUnchanged = params.smart === true && params.force !== true;
  const listArgs = { probeHover: params.probeHover === true, maxDepth: params.maxDepth, debugSurfaces: params.debugSurfaces === true, force: params.force === true };
  const list = await execPageAllFrames(tabId, 'observe', listArgs);
  // 单 frame 页面没变：交回 unchanged，让 daemon 用缓存补文本（别把空文本当成新观察）。
  if (allowUnchanged && list.length === 1 && list[0].result && list[0].result.unchanged === true) {
    return {
      frames: [{ frameId: list[0].frameId, url: list[0].result.url || '', title: list[0].result.title || '', refs: list[0].result.refs || 0, observation: '' }],
      text: '',
      refs: list[0].result.refs || 0,
      aliases: [],
      unchanged: true,
      ...(list[0].result.mutations ? { mutations: list[0].result.mutations } : {}),
      url: list[0].result.url || '',
      title: list[0].result.title || '',
    };
  }
  const graph = await ensureFrameGraph(tabId).catch(() => []);
  const graphById = new Map(graph.map((item) => [item.frameId, item]));
  const metaList = await execPageAllFrames(tabId, 'frame-meta', {}).catch(() => []);
  const metaById = new Map(metaList.filter((item) => item && item.result).map((item) => [item.frameId, item.result]));
  const frames = [];
  const aliases = [];
  const mutationTotals = { text: 0, added: 0, removed: 0, attributes: 0, total: 0, layout: false, interaction: false };
  let aliasSeq = 0;
  for (const item of list) {
    if (item.error || !item.result) {
      const meta = graphById.get(item.frameId) || {};
      const visibility = metaById.get(item.frameId) || {};
      frames.push({ frameId: item.frameId, parentFrameId: meta.parentFrameId, url: meta.url || '', title: '', refs: 0, hidden: visibility.hidden === true, hiddenReason: visibility.reason || null, observation: '（该 frame 不可观察：' + (item.error || 'no result') + '）', error: item.error || 'no result' });
      continue;
    }
    let result = item.result;
    if (allowUnchanged && result.unchanged === true) {
      // 多 frame 页面里个别 frame 没变：单独强制重取该 frame，保证合并文本完整。
      const refreshed = await execPage(tabId, 'observe', { ...listArgs, force: true }, item.frameId).catch(() => null);
      if (refreshed) result = refreshed;
    }
    if (result.mutations) {
      mutationTotals.text += Number(result.mutations.text) || 0;
      mutationTotals.added += Number(result.mutations.added) || 0;
      mutationTotals.removed += Number(result.mutations.removed) || 0;
      mutationTotals.attributes += Number(result.mutations.attributes) || 0;
      mutationTotals.layout = mutationTotals.layout || result.mutations.layout === true;
      mutationTotals.interaction = mutationTotals.interaction || result.mutations.interaction === true;
    }
    const meta = graphById.get(item.frameId) || {};
    const visibility = metaById.get(item.frameId) || {};
    const observation = String(result.observation || '').replace(/\[@e(\d+)\]/g, (match, n) => {
      aliasSeq += 1;
      const alias = '@e' + aliasSeq;
      aliases.push({ ref: alias, frameId: item.frameId, localRef: '@e' + n });
      return '[' + alias + ']';
    });
    frames.push({
      frameId: item.frameId,
      parentFrameId: meta.parentFrameId,
      url: result.url || meta.url || '',
      title: result.title || '',
      refs: typeof result.refs === 'number' ? result.refs : 0,
      hidden: visibility.hidden === true,
      hiddenReason: visibility.reason || null,
      offscreen: visibility.offscreen === true,
      frameSize: visibility.width != null ? { width: visibility.width, height: visibility.height } : null,
      observation,
    });
  }
  frames.sort((x, y) => {
    const a = Number(x.frameId);
    const b = Number(y.frameId);
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
    return String(x.frameId).localeCompare(String(y.frameId));
  });
  // 注入失败（跨源/沙箱/受限）的 frame 用 CDP 兜底采集；--cdp-frames 可强制用于诊断。
  let cdpFallback = false;
  let cdpFrameCount = 0;
  if (params.cdpFrames === true || list.some((item) => item && item.error)) {
    const observedUrls = new Set(frames.map((frame) => frame.url).filter(Boolean));
    const collected = await collectCdpFrames(tabId, { maxNodes: params.cdpMaxNodes }).catch(() => []);
    for (const frame of collected) {
      if (!frame || !frame.text) continue;
      if (params.cdpFrames !== true && observedUrls.has(frame.url)) continue;
      if (frames.some((item) => item.cdp === true && item.url === frame.url)) continue;
      frames.push({
        frameId: frame.frameId,
        parentFrameId: null,
        url: frame.url,
        title: '',
        refs: 0,
        hidden: false,
        hiddenReason: null,
        observation: frame.text,
        cdp: true,
        cdpSessionId: frame.sessionId || null,
      });
      cdpFallback = true;
      cdpFrameCount += 1;
    }
  }
  // 跨源 frame 的 frameElement 不可见：用父 frame 的 iframe 元素可见性补标。
  for (const frame of frames) {
    if (frame.hidden === true) continue;
    const parent = metaById.get(frame.parentFrameId);
    const child = parent && Array.isArray(parent.children)
      ? parent.children.find((item) => item && item.url && item.url === frame.url)
      : null;
    if (child && child.hidden === true) {
      frame.hidden = true;
      frame.hiddenReason = child.reason || 'not-visible';
      frame.offscreen = child.offscreen === true;
      if (child.width != null) frame.frameSize = { width: child.width, height: child.height };
    }
  }
  const aliasMap = new Map();
  for (const entry of aliases) aliasMap.set(entry.ref, { frameId: entry.frameId, localRef: entry.localRef });
  setFrameAliases(tabId, aliasMap);
  const text = frames.map((frame) => 'frame ' + frame.frameId + ' ' + frame.url + '\n' + frame.observation).join('\n\n');
  const mainRevision = typeof list[0]?.result?.revision === 'number' ? list[0].result.revision : null;
  mutationTotals.total = mutationTotals.text + mutationTotals.added + mutationTotals.removed + mutationTotals.attributes;
  return {
    frames,
    text,
    refs: frames.reduce((sum, frame) => sum + frame.refs, 0),
    aliases,
    hiddenFrames: frames.filter((frame) => frame.hidden === true).length,
    ...(mutationTotals.total || mutationTotals.layout || mutationTotals.interaction ? { mutations: mutationTotals } : {}),
    ...(cdpFallback ? { cdpFallback: true, cdpFrames: cdpFrameCount } : {}),
    ...(mainRevision != null ? { revision: mainRevision } : {}),
  };
}

