// src/actions.js —— 页面动作、等待类命令
import { bridgeError } from './errors.js';
import { execPage, evalInMain, evalByCdp, readConsole } from './inject.js';
import { getTab, sleep, waitForLoad, waitForNavigation } from './tabs.js';
import { execPageAllFrames } from './inject.js';
import { acquire, isAttached, isTabArmed, onEvent, release, send as cdpSend } from './debugger.js';
import { log } from './log.js';
import { hideTakeover, showTakeover } from './takeover.js';
import { withOverlaysHidden } from './overlay-suppress.js';
import { takeTokenChunk } from './tokens.js';
import { acquireInputLease, releaseInputLease } from './input-lease.js';
import { isCommandCancelled } from './command-cancel.js';
import { ensureFrameGraph } from './frame-graph.js';
import { withForegroundTab } from './background-execution.js';
import { diffObservation, observationId } from './lib/observation-delta.js';
import { readDocumentIdentity, sameDocumentIdentity } from './document-identity.js';
import { captureDomSnapshot, captureDomSnapshotFacts } from './dom-snapshot.js';
import { annotateHiddenRefs, collectHiddenRefs } from './lib/facts-annotate.js';
import { renderAxObservation } from './lib/ax-render.js';
import { collectUnmappedAx, isInteractiveAxRole, renderUnmappedAx } from './lib/unmapped-ax.js';
import { computeTableFacts, summarizeTables } from './lib/table-facts.js';
import { computeBlockingLayers } from './lib/blocking-layers.js';
import { applyBlockingLayers, applyFactToNode } from './lib/facts-apply.js';
import { buildAxNodes } from './lib/ax-pipeline.js';
import { intersectsViewport, summarizePipeline } from './lib/pipeline-compare.js';

const DEFAULT_NAV_TIMEOUT_MS = 30000;
const DEFAULT_ELEMENT_TIMEOUT_MS = 10000;
const DEFAULT_WAIT_NAV_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const WAIT_ELEMENT_POLL_MS = 150;
const VALID_ELEMENT_STATES = new Set(['visible', 'hidden', 'attached', 'detached']);
// 刚 fill 过的目标：紧随其后的 trusted press 不需要再点击一次来聚焦（省 1 次可信鼠标往返）。
const recentFillFocus = new Map(); // tabId -> { ref, at }

export function requireTabId(params) {
  if (!params || !Number.isInteger(params.tabId)) {
    throw bridgeError('E_BAD_ARG', '缺少 tabId（由 daemon 注入）');
  }
  return params.tabId;
}

function boundedTimeout(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.max(Math.round(number), 100), MAX_TIMEOUT_MS);
}

async function resetRefsQuietly(tabId) {
  try {
    await execPage(tabId, 'reset-refs', {});
  } catch (error) {
    log(`清理 tab ${tabId} 的 ref 表失败（忽略）`, error && error.message);
  }
}

/** navigate */
export async function navigate(params = {}) {
  const tabId = requireTabId(params);
  if (typeof params.url !== 'string' || !params.url.trim()) {
    throw bridgeError('E_BAD_ARG', 'navigate 需要非空 url');
  }
  const url = params.url.trim();
  const tab = await getTab(tabId);
  shadowRefs.delete(tabId);
  clearFrameAliases(tabId);
  recentFillFocus.delete(tabId);
  const timeoutMs = boundedTimeout(params.timeoutMs, DEFAULT_NAV_TIMEOUT_MS);
  try {
    if ((tab.url || '') === url) {
      await chrome.tabs.reload(tabId);
    } else {
      await chrome.tabs.update(tabId, { url });
    }
  } catch (error) {
    throw bridgeError('E_NAV_FAIL', `导航到 ${url} 失败: ${(error && error.message) || error}`);
  }
  const loaded = await waitForLoad(tabId, timeoutMs);
  if (!loaded) log(`tab ${tabId} 导航 ${timeoutMs}ms 内未完成加载，返回当前状态`);
  await resetRefsQuietly(tabId);
  const current = await getTab(tabId);
  // 浮层是可见性提示，注入失败/延迟不影响导航结果；不阻塞导航返回。
  showTakeover(tabId, { name: 'BridgeDeck' }).catch(() => {});
  return { url: current.url || current.pendingUrl || url, title: current.title || '' };
}

/** reload */
export async function reload(params = {}) {
  const tabId = requireTabId(params);
  await getTab(tabId);
  try {
    await chrome.tabs.reload(tabId);
  } catch (error) {
    throw bridgeError('E_NAV_FAIL', `reload 失败: ${(error && error.message) || error}`);
  }
  await waitForLoad(tabId, 15000).catch(() => null);
  await resetRefsQuietly(tabId);
  return { ok: true };
}

async function goHistory(tabId, direction) {
  await getTab(tabId);
  try {
    if (direction === 'back') await chrome.tabs.goBack(tabId);
    else await chrome.tabs.goForward(tabId);
  } catch (error) {
    throw bridgeError('E_NAV_FAIL', `历史${direction === 'back' ? '后退' : '前进'}失败: ${(error && error.message) || error}`);
  }
  await waitForLoad(tabId, 15000).catch(() => null);
  await resetRefsQuietly(tabId);
  return { ok: true };
}

export async function goBack(params = {}) {
  return goHistory(requireTabId(params), 'back');
}

export async function goForward(params = {}) {
  return goHistory(requireTabId(params), 'forward');
}

/** wait-ms */
export async function waitMs(params = {}) {
  requireTabId(params);
  const ms = Number(params.ms);
  if (!Number.isFinite(ms) || ms < 0) throw bridgeError('E_BAD_ARG', 'wait-ms 需要非负 ms');
  if (ms > MAX_TIMEOUT_MS) throw bridgeError('E_BAD_ARG', `wait-ms 上限 ${MAX_TIMEOUT_MS}ms`);
  const commandId = typeof params.commandId === 'string' ? params.commandId : '';
  const deadline = Date.now() + Math.round(ms);
  while (Date.now() < deadline) {
    if (commandId && isCommandCancelled(commandId)) throw bridgeError('E_CANCELLED', 'wait-ms 已被取消');
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  if (commandId && isCommandCancelled(commandId)) throw bridgeError('E_CANCELLED', 'wait-ms 已被取消');
  return { ok: true };
}

/** 进行中的 wait-for-element，可被 operation cancel 中止。 */
const activeWaits = new Map();

export function cancelWait(operationId) {
  const entry = activeWaits.get(String(operationId));
  if (!entry) return { ok: false, error: '未知等待操作：' + operationId };
  entry.cancelled = true;
  return { ok: true, operationId: String(operationId) };
}

/** wait-for-element：超时返回 satisfied:false（不抛错），与协议约定一致。 */
export async function waitForElement(params = {}) {
  const tabId = requireTabId(params);
  const selector = typeof params.selector === 'string' ? params.selector : '';
  const ref = typeof params.ref === 'string' ? params.ref : '';
  if (!selector && !ref) throw bridgeError('E_BAD_ARG', 'wait-for-element 需要 selector 或 ref');
  const stateName = typeof params.state === 'string' ? params.state : 'visible';
  if (!VALID_ELEMENT_STATES.has(stateName)) {
    throw bridgeError('E_BAD_ARG', 'state 只能是 ' + [...VALID_ELEMENT_STATES].join('/'));
  }
  const operationId = typeof params.operationId === 'string' && params.operationId
    ? params.operationId
    : 'wait-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  const timeoutMs = boundedTimeout(params.timeoutMs, DEFAULT_ELEMENT_TIMEOUT_MS);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const entry = { cancelled: false };
  activeWaits.set(operationId, entry);
  let probe = null;

  try {
    for (;;) {
      if (entry.cancelled) {
        return {
          satisfied: false,
          cancelled: true,
          operationId,
          state: stateName,
          selector: selector || null,
          ref: ref || null,
          attached: Boolean(probe && probe.present),
          visible: Boolean(probe && probe.visible),
          elapsedMs: Date.now() - startedAt,
        };
      }
      probe = await execPage(tabId, 'probe-state', { selector, ref, state: stateName });
      if (elementStateReady(probe, stateName)) {
        return {
          satisfied: true,
          operationId,
          state: stateName,
          selector: selector || null,
          ref: ref || null,
          attached: Boolean(probe && probe.present),
          visible: Boolean(probe && probe.visible),
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (Date.now() >= deadline) {
        return {
          satisfied: false,
          operationId,
          state: stateName,
          selector: selector || null,
          ref: ref || null,
          attached: Boolean(probe && probe.present),
          visible: Boolean(probe && probe.visible),
          elapsedMs: Date.now() - startedAt,
          timedOut: true,
        };
      }
      await sleep(WAIT_ELEMENT_POLL_MS);
    }
  } finally {
    activeWaits.delete(operationId);
  }
}

function elementStateReady(probe, state) {
  const present = Boolean(probe && probe.present);
  const visible = Boolean(probe && probe.visible);
  switch (state) {
    case 'visible':
      return present && visible;
    case 'hidden':
      return !present || !visible;
    case 'attached':
      return present;
    case 'detached':
      return !present;
    default:
      return false;
  }
}

/** wait-for-navigation */
export async function waitForNavigationCmd(params = {}) {
  const tabId = requireTabId(params);
  await getTab(tabId);
  const timeoutMs = boundedTimeout(params.timeoutMs, DEFAULT_WAIT_NAV_TIMEOUT_MS);
  const waitUntil = ['load', 'domcontentloaded', 'networkidle', 'commit'].includes(params.waitUntil) ? params.waitUntil : 'load';
  const navigation = await waitForNavigation(tabId, timeoutMs);
  if (waitUntil === 'commit') return { ok: true, url: navigation.url, phase: 'commit' };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await getTab(tabId);
      if (tab && tab.status === 'complete') break;
    } catch { break; }
    await sleep(50);
  }
  if (waitUntil === 'networkidle') await sleep(700);
  // 宽限：页面刚 complete 时可能紧接着开始新的主导航（重定向/SPA 跳转），
  // 只有在一段安静窗口内 URL 与状态都稳定，才算真正到达。60ms 覆盖常见重定向，
  // 需要更保守时传 graceMs。
  const graceMs = Math.max(0, Math.min(Number(params.graceMs) || 60, 2000));
  let stableSince = 0;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const tab = await getTab(tabId).catch(() => null);
    const loading = !tab || tab.status === 'loading';
    const url = (tab && tab.url) || '';
    if (!loading && url === lastUrl) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= graceMs) break;
    } else {
      stableSince = 0;
    }
    lastUrl = url;
    await sleep(30);
  }
  const settled = await getTab(tabId).catch(() => null);
  return { ok: true, url: (settled && settled.url) || navigation.url, phase: waitUntil };
}

/** 最近一次完整观察的缓存（分页续读用）。 */
const observationCache = new Map();
// 连续 trusted fill 的聚焦状态缓存：同一标签页 1s 内复用，避免每次重复激活/可见性检查。
const inputFocusCache = new Map();

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
async function collectAxNodes(tabId, limit = 1000) {
  await acquire(tabId, 'ax');
  try {
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

export async function observe(params = {}) {
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
      if (diff.kind === 'text' || diff.kind === 'same') {
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
    url: cache.url,
    title: cache.title,
    blocking: cache.blocking || null,
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

function pageAction(name) {
  return async function handler(params = {}) {
    const tabId = requireTabId(params);
    const frameId = Number.isInteger(params.frameId) ? params.frameId : 0;
    return execPage(tabId, name, params, frameId);
  };
}

const rawClick = pageAction('click');
const rawHover = pageAction('hover');

const TARGET_RETRY_CODES = new Set(['E_NOT_FOUND', 'E_STALE_REF']);

/**
 * 显式 waitTimeoutMs 时，对 selector 目标做短暂重试：
 * SPA 重新渲染/懒加载造成目标短暂消失时，等它回来再动作；默认（未显式给）仍立即失败。
 */
async function retryTarget(params, run) {
  const waitMs = Number(params && params.waitTimeoutMs);
  if (!(waitMs > 0) || !(params && params.selector)) return run();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!error || !TARGET_RETRY_CODES.has(error.code) || Date.now() >= deadline) throw error;
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
  }
}

/**
 * 可信输入前置：把目标标签页切到前台。
 * 后台标签页收不到 CDP 原生鼠标/键盘事件（事件会被浏览器丢弃），
 * 表现就是 --trusted 返回成功但页面 trustedMoves=0。只影响显式 --trusted。
 */
async function ensureInputFocus(tabId) {
  // 会话 CDP 已启用焦点仿真：页面自认可见，直接派发原生输入，不切 tab/窗口。
  if (isTabArmed(tabId)) return true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        if (tab.active === false) await chrome.tabs.update(tabId, { active: true });
        if (Number.isInteger(tab.windowId)) {
          try {
            const win = await chrome.windows.get(tab.windowId);
            if (win && win.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'normal' });
          } catch { /* 窗口状态读取失败时仍尝试聚焦 */ }
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      }
    } catch {
      // 标签/窗口已关闭或权限受限：继续尝试派发，失败会回退到页面内动作
    }
    try {
      const state = await evalInMain(tabId, 'document.visibilityState');
      if (state && state.value === 'visible') return true;
    } catch {
      // 注入失败时按不可见处理，继续重试
    }
    await sleep(120);
  }
  return false;
}

async function trustedOrFallback(kind, params, fallback) {
  const tabId = requireTabId(params);
  if (kind === 'click' && params && params.ref) {
    const map = shadowRefs.get(tabId);
    const entry = map && map.get(params.ref);
    if (entry) {
      const point = await shadowRefClick(tabId, entry).catch(() => null);
      if (point) return { ok: true, trusted: true, via: 'closed-shadow-ref', x: point.x, y: point.y };
    }
  }
  if (!(params && params.trusted === true)) return fallback(params);
  if (params && (params.modifiers || (params.button && params.button !== 'left'))) return fallback(params);
  await ensureInputFocus(tabId);
  const target = params && params.ref ? { ref: params.ref } : (params && params.selector ? { selector: params.selector } : null);
  if (target && params.force !== true) {
    const hit = await execPage(tabId, 'hit-test', target).catch(() => null);
    if (hit && (hit.state === 'blocked' || hit.state === 'pointer-events-none')) {
      throw bridgeError(
        'E_OCCLUDED',
        '目标在动作前被遮挡（' + hit.state + '）：请先关闭浮层/弹窗，或用 --force 强制派发',
        { hitTest: hit.state, occludedBy: hit.occludedBy || null, rect: hit.rect || null, dispatched: false },
      );
    }
  }
  if (target) {
    let point = null;
    try {
      point = await execPage(tabId, 'point', target);
    } catch {
      point = null;
    }
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      const lease = acquireInputLease(tabId, 'trusted:' + kind);
      try {
        try {
          await acquire(tabId, 'input');
          try {
            await cdpSend(tabId, 'Page.bringToFront').catch(() => {});
            await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
            await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
            const path = kind === 'click'
              ? [[point.x - 36, point.y - 18], [point.x - 18, point.y - 6], [point.x, point.y]]
              : [[point.x - 24, point.y - 10], [point.x, point.y]];
            for (const [mx, my] of path) {
              await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my, button: 'none', buttons: 0, clickCount: 0 });
            }
            if (kind === 'click') {
              await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
              await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
            }
            return { ok: true, trusted: true, x: point.x, y: point.y };
          } finally {
            void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
            await release(tabId, 'input').catch(() => {});
          }
        } catch {
          // debugger 不可用：回退到页面内点击
        }
      } finally {
        releaseInputLease(tabId, lease.token);
      }
    }
  }
  return fallback(params);
}

async function trustedDrag(params, fallback) {
  const tabId = requireTabId(params);
  await ensureInputFocus(tabId);
  const fromPoint = await execPage(tabId, 'point', params.from).catch(() => null);
  if (!fromPoint) return fallback(params);
  let toPoint = null;
  if (params.to) toPoint = await execPage(tabId, 'point', params.to).catch(() => null);
  const start = {
    x: fromPoint.x + (Number(params.fromOffsetX) || 0),
    y: fromPoint.y + (Number(params.fromOffsetY) || 0),
  };
  const end = toPoint
    ? { x: toPoint.x + (Number(params.toOffsetX) || 0), y: toPoint.y + (Number(params.toOffsetY) || 0) }
    : { x: start.x + (Number(params.dx) || 0), y: start.y + (Number(params.dy) || 0) };
  const steps = Math.max(2, Math.min(60, Number(params.steps) || 10));
  const modifiers = Number(params.modifiers) || 0;
  const holdMs = Math.max(0, Math.min(5000, Number(params.holdMs) || 0));
  const durationMs = Math.max(0, Math.min(5000, Number(params.durationMs) || 0));
  const pause = durationMs > 0 ? Math.min(200, Math.round(durationMs / steps)) : 0;
  const lease = acquireInputLease(tabId, 'trusted:drag', 30000);
  try {
    await acquire(tabId, 'input');
    try {
      await cdpSend(tabId, 'Page.bringToFront').catch(() => {});
      await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0, clickCount: 0, modifiers });
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
      if (holdMs > 0) await sleep(holdMs);
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const x = start.x + (end.x - start.x) * t;
        const y = start.y + (end.y - start.y) * t;
        await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers });
        if (pause > 0) await sleep(pause);
      }
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1, modifiers });
      return { ok: true, trusted: true, from: start, to: end };
    } finally {
      void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
}

export async function click(params = {}) {
  return retryTarget(params, () => {
    if (params && params.trusted === true && Number.isInteger(params.tabId)) {
      return withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, () => trustedOrFallback('click', params, rawClick)));
    }
    return trustedOrFallback('click', params, rawClick);
  });
}

/**
 * click-backend：按 backendNodeId 点击 AX/DOMSnapshot 发现、但没有 @eN ref 的元素
 *（closed shadow、page-lib 漏掉的节点）。动作前做滚动/可见性/遮挡检查，
 * 然后派发 CDP 原生鼠标事件（isTrusted=true）。
 */
export async function clickBackend(params = {}) {
  const tabId = requireTabId(params);
  const backendId = Number(params.backendId);
  if (!Number.isInteger(backendId) || backendId <= 0) {
    throw bridgeError('E_BAD_ARG', 'click-backend 需要 backendId 正整数');
  }
  await acquire(tabId, 'click-backend');
  try {
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    const resolved = await cdpSend(tabId, 'DOM.resolveNode', { backendNodeId: backendId });
    const objectId = resolved && resolved.object && resolved.object.objectId;
    if (!objectId) throw bridgeError('E_NOT_FOUND', 'backendNodeId 已失效或不在当前文档');
    const checked = await cdpSend(tabId, 'Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      awaitPromise: false,
      functionDeclaration: `function () {
        const el = this;
        if (!el || !el.isConnected) return { ok: false, reason: 'detached' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: 'zero-size' };
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') {
          return { ok: false, reason: 'not-actionable' };
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const root = el.getRootNode();
        if (root === document) {
          const hit = document.elementFromPoint(x, y);
          if (!hit) return { ok: false, reason: 'no-hit' };
          if (hit !== el && !el.contains(hit)) return { ok: false, reason: 'occluded', by: hit.tagName };
        }
        return { ok: true, x, y };
      }`,
    });
    const value = checked && checked.result ? checked.result.value : null;
    if (!value || value.ok !== true) {
      const reason = value && value.reason ? value.reason : 'unknown';
      if (reason === 'occluded') {
        throw bridgeError('E_OCCLUDED', '目标被遮挡：' + (value.by || 'unknown'), {
          hitTest: 'blocked', backendNodeId: backendId, dispatched: false,
        });
      }
      throw bridgeError('E_NOT_ACTIONABLE', 'backend 节点当前不可点击（' + reason + '）', {
        backendNodeId: backendId, reason, dispatched: false,
      });
    }
    const x = Math.round(Number(value.x) * 100) / 100;
    const y = Math.round(Number(value.y) * 100) / 100;
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { ok: true, trusted: true, via: 'cdp-backend', backendNodeId: backendId, x, y };
  } finally {
    await release(tabId, 'click-backend').catch(() => {});
  }
}

const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

function parseKeySpec(spec) {
  const parts = String(spec || '').split('+').map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw bridgeError('E_BAD_ARG', 'press 需要 key');
  const keyName = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const token = part.toLowerCase();
    if (token === 'ctrl' || token === 'control') modifiers |= 2;
    else if (token === 'alt' || token === 'option') modifiers |= 1;
    else if (token === 'shift') modifiers |= 8;
    else if (token === 'meta' || token === 'cmd' || token === 'win') modifiers |= 4;
  }
  let info = KEY_CODES[keyName] || KEY_CODES[keyName.charAt(0).toUpperCase() + keyName.slice(1)];
  if (!info && keyName.length === 1) {
    const ch = keyName;
    const upper = ch.toUpperCase();
    const isDigit = /[0-9]/.test(ch);
    info = {
      key: ch,
      code: isDigit ? 'Digit' + ch : (/[a-zA-Z]/.test(ch) ? 'Key' + upper : ''),
      vk: isDigit ? ch.charCodeAt(0) : (upper.charCodeAt(0) || 0),
      text: ch,
    };
  }
  if (!info) throw bridgeError('E_BAD_ARG', '不支持的按键：' + spec);
  return { ...info, modifiers };
}

async function trustedKey(tabId, spec) {
  const info = parseKeySpec(spec);
  const base = {
    modifiers: info.modifiers,
    key: info.key,
    code: info.code || '',
    windowsVirtualKeyCode: info.vk || 0,
    nativeVirtualKeyCode: info.vk || 0,
  };
  const withText = info.text !== undefined && (info.modifiers & (2 | 4)) === 0;
  await pipeCdp(tabId, [
    ['Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(withText ? { text: info.text } : {}) }],
    ['Input.dispatchKeyEvent', { type: 'keyUp', ...base }],
  ]);
}

async function trustedFocusPoint(tabId, params) {
  const target = params && params.ref ? { ref: params.ref } : (params && params.selector ? { selector: params.selector } : null);
  if (!target) return null;
  return execPage(tabId, 'point', target).catch(() => null);
}

/** 同一条 CDP 会话上的命令按发送顺序执行；无需逐条等待响应，可省往返。 */
function pipeCdp(tabId, commands) {
  return Promise.all(commands.map(([method, params]) => cdpSend(tabId, method, params)));
}

async function trustedClickPoint(tabId, point) {
  await pipeCdp(tabId, [
    ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, clickCount: 0 }],
    ['Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }],
    ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }],
  ]);
}

/**
 * 3–4 步 fast path：页面内聚焦并选中 → CDP insertText → 页面内校验。
 * 省掉鼠标点击、Ctrl+A、焦点仿真与置前；不适合的控件返回 null 走原 trustedFill。
 */
async function trustedFillFast(params) {
  const tabId = requireTabId(params);
  const target = params.ref ? { ref: params.ref } : (params.selector ? { selector: params.selector } : null);
  if (!target) return null;
  const now = Date.now();
  const cachedFocus = inputFocusCache.get(tabId);
  if (!cachedFocus || now - cachedFocus > 1000) {
    const focused = await ensureInputFocus(tabId);
    if (!focused) return null;
    inputFocusCache.set(tabId, now);
  }
  const raw = await execPage(tabId, 'fill-focus', target).catch((error) => { throw error; });
  const prep = raw && raw.value && typeof raw.value === 'object' ? raw.value : raw;
  if (!prep || prep.textLike !== true) return null;
  if (prep.occluded === true && params.force !== true) {
    throw bridgeError('E_NOT_ACTIONABLE', '目标被遮挡（occluded），可用 --force 强制填写');
  }

  const value = String(params.value === undefined ? '' : params.value);
  const lease = acquireInputLease(tabId, 'trusted:fill');
  try {
    await acquire(tabId, 'input');
    try {
      await cdpSend(tabId, 'Input.insertText', { text: value });
    } finally {
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
  const verified = await execPage(tabId, 'fill-verify', { ...target, expected: value }).catch(() => null);
  return {
    ok: true,
    trusted: true,
    fast: true,
    ...(verified ? {
      ...(verified.sensitive === true ? { formatted: verified.formatted === true } : { actualValue: verified.value, formatted: verified.formatted === true }),
    } : {}),
  };
}

async function trustedFill(params, fallback) {
  const tabId = requireTabId(params);
  const now = Date.now();
  const cachedFocus = inputFocusCache.get(tabId);
  if (!cachedFocus || now - cachedFocus > 1000) {
    const focused = await ensureInputFocus(tabId);
    if (focused) inputFocusCache.set(tabId, now);
  }
  const point = await trustedFocusPoint(tabId, params);
  if (!point) return fallback(params);
  const lease = acquireInputLease(tabId, 'trusted:fill');
  try {
    await acquire(tabId, 'input');
    try {
      // 三个 CDP 设置互不依赖，合并为一次往返；后台标签才需要 bringToFront/lifecycle。
      const setup = [];
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.active === false) {
        setup.push(cdpSend(tabId, 'Page.bringToFront').catch(() => {}));
        setup.push(cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {}));
      }
      setup.push(cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}));
      await Promise.all(setup);
      await trustedClickPoint(tabId, point);
      if (params.noClear !== true) {
        await trustedKey(tabId, 'Control+a');
      } else {
        await trustedKey(tabId, 'End');
      }
      await cdpSend(tabId, 'Input.insertText', { text: String(params.value === undefined ? '' : params.value) });
      return { ok: true, trusted: true };
    } finally {
      void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
}

async function trustedPress(params, fallback) {
  const tabId = requireTabId(params);
  await ensureInputFocus(tabId);
  const recent = recentFillFocus.get(tabId);
  const skipClick = Boolean(params.ref && recent && recent.ref === params.ref && Date.now() - recent.at < 3000);
  const point = skipClick ? null : await trustedFocusPoint(tabId, params);
  const lease = acquireInputLease(tabId, 'trusted:press');
  try {
    await acquire(tabId, 'input');
    try {
      await cdpSend(tabId, 'Page.bringToFront').catch(() => {});
      await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      if (point) await trustedClickPoint(tabId, point);
      await trustedKey(tabId, String(params.key));
      return { ok: true, trusted: true };
    } finally {
      void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
}

const rawFill = pageAction('fill');
const rawPress = pageAction('press');
export async function actionable(params = {}) {
  const tabId = requireTabId(params);
  const target = params.ref ? { ref: params.ref } : (params.selector ? { selector: params.selector } : null);
  if (!target) throw bridgeError('E_BAD_ARG', 'actionable 需要 ref 或 selector');
  return execPage(tabId, 'actionable', target);
}

export async function fill(params = {}) {
  return retryTarget(params, async () => {
    if (!params || params.trusted !== true) {
      const result = await rawFill(params);
      if (params && params.ref) recentFillFocus.set(Number(params.tabId), { ref: params.ref, at: Date.now() });
      return result;
    }
    const run = async () => {
      const fast = await trustedFillFast(params).catch((error) => {
        // 语义错误必须让调用方看到；只有真正的环境问题才回退。
        if (error && ['E_INPUT_BUSY', 'E_NOT_ACTIONABLE', 'E_BAD_ARG', 'E_TARGET_NOT_FILLABLE', 'E_OPTION_NOT_FOUND', 'E_OPTION_AMBIGUOUS'].includes(error.code)) throw error;
        return null;
      });
      if (fast) {
        if (params.ref) recentFillFocus.set(Number(params.tabId), { ref: params.ref, at: Date.now() });
        return fast;
      }
      const result = await trustedFill(params, rawFill).catch((error) => {
        if (error && error.code === 'E_INPUT_BUSY') throw error;
        return rawFill(params);
      });
      if (params.ref) recentFillFocus.set(Number(params.tabId), { ref: params.ref, at: Date.now() });
      return result;
    };
    return Number.isInteger(params.tabId) ? withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, run)) : run();
  });
}
export async function press(params = {}) {
  return retryTarget(params, () => {
    if (!params || params.trusted !== true) return rawPress(params);
    const run = () => trustedPress(params, rawPress).catch((error) => {
      if (error && error.code === 'E_INPUT_BUSY') throw error;
      return rawPress(params);
    });
    return Number.isInteger(params.tabId) ? withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, run)) : run();
  });
}


export async function hover(params = {}) {
  return retryTarget(params, () => {
    if (params && params.trusted === true && Number.isInteger(params.tabId)) {
      return withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, () => trustedOrFallback('hover', params, rawHover)));
    }
    return trustedOrFallback('hover', params, rawHover);
  });
}
const rawSelect = pageAction('select');
export async function select(params = {}) {
  return retryTarget(params, () => rawSelect(params));
}
export const focus = pageAction('focus');
export const scrollTo = pageAction('scroll-to');
const rawRead = pageAction('read');
/** 读类操作的文档身份护栏：读取前后主文档必须一致，否则这次采样不可信。 */
async function withDocumentIdentity(tabId, fn) {
  const before = await readDocumentIdentity(tabId).catch(() => null);
  const result = await fn();
  if (before) {
    const after = await readDocumentIdentity(tabId).catch(() => null);
    if (!sameDocumentIdentity(before, after)) {
      throw bridgeError('E_CONTEXT_STALE', '读取期间主文档发生变化（导航或重渲染），本次 read/extract 结果已丢弃；请重新 observe');
    }
  }
  return result;
}

export async function read(params = {}) {
  const tabId = requireTabId(params);
  if (params && params.ref) {
    const map = shadowRefs.get(tabId);
    const entry = map && map.get(params.ref);
    if (entry) {
      const text = await shadowRefRead(tabId, entry).catch(() => null);
      if (text != null) return { value: text, text, via: 'closed-shadow-ref' };
    }
  }
  return withDocumentIdentity(tabId, () => rawRead(params));
}
export const extract = pageAction('extract');
const rawDrag = pageAction('drag');
export async function drag(params = {}) {
  if (!params || params.trusted !== true) return rawDrag(params);
  const run = () => trustedDrag(params, rawDrag).catch((error) => {
    if (error && error.code === 'E_INPUT_BUSY') throw error;
    return rawDrag(params);
  });
  return Number.isInteger(params.tabId) ? withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, run)) : run();
}
export const wheel = pageAction('wheel');
export const blur = pageAction('blur');


/** extract：discover 候选表格/列表，或按 target id / selector 导出。 */
export async function extractDiscover(params = {}) {
  const tabId = requireTabId(params);
  return withDocumentIdentity(tabId, () => execPage(tabId, 'extract', { discover: true }));
}

export async function extractList(params = {}) {
  const tabId = requireTabId(params);
  return withDocumentIdentity(tabId, () => execPage(tabId, 'extract', {
    mode: 'list',
    target: params.target,
    selector: params.selector,
    ref: params.ref,
    itemSelector: params.itemSelector,
    fields: params.fields,
    maxRows: params.maxRows,
    maxBytes: params.maxBytes,
  }));
}

export async function extractTable(params = {}) {
  const tabId = requireTabId(params);
  return withDocumentIdentity(tabId, () => execPage(tabId, 'extract', {
    target: params.target,
    selector: params.selector,
    ref: params.ref,
    maxRows: params.maxRows,
    maxBytes: params.maxBytes,
  }));
}

/** evaluate（主世界）；--unverified 跳过观察校验，结果标记 verified:false。 */
export async function evaluate(params = {}) {
  const tabId = requireTabId(params);
  if (typeof params.expression !== 'string' || !params.expression.trim()) {
    throw bridgeError('E_BAD_ARG', 'evaluate 需要非空 expression');
  }
  // 会话标签页已挂 CDP：Runtime.evaluate 快路径（也天然绕过页面 CSP）。
  // 未挂载（借用 tab / 预挂失败）时退回注入式 eval，语义一致。
  let result = null;
  if (isAttached(tabId)) {
    result = await evalByCdp(tabId, params.expression).catch(() => null);
  }
  if (!result) result = await evalInMain(tabId, params.expression);
  return params.unverified === true ? { ...result, verified: false } : result;
}

/** console */
export async function consoleEntries(params = {}) {
  const tabId = requireTabId(params);
  const since = Number(params.since);
  const limit = Number(params.limit);
  return readConsole(tabId, Number.isFinite(since) ? since : undefined, Number.isInteger(limit) && limit > 0 ? limit : undefined);
}

/** 兜底：直接用 CDP 把真实文件路径赋给 file input（selector 精确匹配，否则第一个）。 */
async function setFirstFileInputFiles(tabId, paths, selector) {
  const doc = await cdpSend(tabId, 'DOM.getDocument', { depth: -1, pierce: false });
  let found = null;
  if (selector) {
    try {
      const queried = await cdpSend(tabId, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: String(selector) });
      if (queried && queried.nodeId) {
        const described = await cdpSend(tabId, 'DOM.describeNode', { nodeId: queried.nodeId });
        const node = described && described.node;
        if (node && node.nodeName === 'INPUT') {
          const attrs = node.attributes || [];
          const map = {};
          for (let index = 0; index + 1 < attrs.length; index += 2) map[attrs[index]] = attrs[index + 1];
          if (String(map.type || '').toLowerCase() === 'file') found = node;
        }
      }
    } catch {
      found = null;
    }
  }
  if (!found) {
    (function walk(node) {
      if (found || !node) return;
      if (node.nodeType === 1 && node.nodeName === 'INPUT') {
        const attrs = node.attributes || [];
        const map = {};
        for (let index = 0; index + 1 < attrs.length; index += 2) map[attrs[index]] = attrs[index + 1];
        if (String(map.type || '').toLowerCase() === 'file') {
          found = node;
          return;
        }
      }
      for (const child of node.children || []) walk(child);
    })(doc && doc.root);
  }
  if (!found || !found.backendNodeId) return false;
  await cdpSend(tabId, 'DOM.setFileInputFiles', { files: paths, backendNodeId: found.backendNodeId });
  return true;
}

/** upload：file input 直接赋值；按钮/标签则拦截系统文件选择器。 */
export async function upload(params = {}) {
  const tabId = requireTabId(params);
  await getTab(tabId);
  if (params.mode === 'drop') {
    const paths = Array.isArray(params.paths) ? params.paths.filter((item) => typeof item === 'string' && item) : [];
    if (!paths.length) throw bridgeError('E_BAD_ARG', 'upload --mode drop 需要文件路径');
    await execPage(tabId, 'scroll-to', { ref: params.ref, selector: params.selector }).catch(() => {});
    await sleep(150);
    const rect = await execPage(tabId, 'element-rect', { ref: params.ref, selector: params.selector });
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    const dragData = { items: [], files: paths, dragOperationsMask: 1 };
    await acquire(tabId, 'upload-drop');
    try {
      await cdpSend(tabId, 'Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: dragData });
      await cdpSend(tabId, 'Input.dispatchDragEvent', { type: 'dragOver', x, y, data: dragData });
      await cdpSend(tabId, 'Input.dispatchDragEvent', { type: 'drop', x, y, data: dragData });
      return { ok: true, via: 'drop', names: paths.map((item) => item.split(/[\\/]/).pop()) };
    } finally {
      await release(tabId, 'upload-drop').catch(() => {});
    }
  }
  const probe = await execPage(tabId, 'upload-probe', { ref: params.ref, selector: params.selector });
  if (probe && probe.isFileInput) {
    const hasInline = Array.isArray(params.files) && params.files.some((file) => file && file.base64);
    const directPaths = Array.isArray(params.paths) ? params.paths.filter((item) => typeof item === 'string' && item) : [];
    if (!hasInline && directPaths.length) {
      try {
        await acquire(tabId, 'upload');
        try {
          if (await setFirstFileInputFiles(tabId, directPaths, params.selector)) {
            return { ok: true, names: directPaths.map((item) => item.split(/[\\/]/).pop()), via: 'input-path' };
          }
        } finally {
          await release(tabId, 'upload').catch(() => {});
        }
      } catch {
        // 继续用页面内 base64 赋值
      }
    }
    return execPage(tabId, 'upload', params);
  }

  const paths = Array.isArray(params.paths) ? params.paths.filter((item) => typeof item === 'string' && item) : [];
  if (!paths.length) {
    throw bridgeError('E_BAD_ARG', '该目标不是 input[type=file]，需要文件路径（CLI 与浏览器需在同一台机器）');
  }
  const dbg = await acquire(tabId, 'upload');
  let unsubscribe = null;
  try {
    await cdpSend(tabId, 'Page.enable').catch(() => {});
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    await cdpSend(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
    let chooser = null;
    unsubscribe = onEvent(dbg, 'Page.fileChooserOpened', (event) => {
      chooser = event;
    });
    // 先把目标滚进视口，否则 CDP 点击坐标落在视口外
    await execPage(tabId, 'scroll-to', { ref: params.ref, selector: params.selector }).catch(() => {});
    await sleep(200);
    const rect = await execPage(tabId, 'element-rect', { ref: params.ref, selector: params.selector });
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    const deadline = Date.now() + 5000;
    while (!chooser && Date.now() < deadline) await sleep(100);
    if (!chooser || !chooser.backendNodeId) {
      // 选择器没拦住：优先用 CDP 把真实路径赋给页面里的 file input（大文件 staging 也适用）
      if (paths.length) {
        try {
          if (await setFirstFileInputFiles(tabId, paths, params.selector)) {
            return { ok: true, names: paths.map((item) => item.split(/[\\/]/).pop()), via: 'hidden-input' };
          }
        } catch {
          // 继续尝试 base64 兜底
        }
      }
      // 有些站点用程序化 click 打开选择器，CDP 拦截不到；退回给页面里的隐藏 file input 赋值
      if (Array.isArray(params.files) && params.files.length) {
        const fallback = await execPage(tabId, 'upload-first', { files: params.files });
        return { ok: true, names: (fallback && fallback.names) || [], via: 'hidden-input' };
      }
      throw bridgeError('E_NO_FILE_CHOOSER', '点击后没有出现文件选择器，且没有可赋值的 input[type=file]');
    }
    await cdpSend(tabId, 'DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
    return { ok: true, names: paths.map((item) => item.split(/[\\\\/]/).pop()), via: 'chooser' };
  } finally {
    if (unsubscribe) unsubscribe();
    await cdpSend(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
    await release(tabId, 'upload').catch(() => {});
  }
}

/** 收集 closed shadow 树里的交互元素（只读，不分配 ref）。 */
const shadowRefs = new Map(); // tabId -> Map('@eN' -> entry)

async function closedShadowEntries(tabId, limit = 50) {
  const doc = await cdpSend(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
  const candidates = [];
  (function walk(node, inClosed) {
    if (!node) return;
    if (inClosed && node.nodeType === 1 && /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY)$/.test(node.nodeName || '')) {
      candidates.push(node);
    }
    for (const child of node.children || []) walk(child, inClosed);
    for (const shadow of node.shadowRoots || []) walk(shadow, inClosed || shadow.shadowRootType === 'closed');
    if (node.contentDocument) walk(node.contentDocument, false);
  })(doc && doc.root, false);
  const entries = [];
  for (const node of candidates.slice(0, 300)) {
    if (entries.length >= limit) break;
    let objectId = null;
    try {
      const resolved = await cdpSend(tabId, 'DOM.resolveNode', { nodeId: node.nodeId });
      objectId = resolved && resolved.object && resolved.object.objectId;
      if (!objectId) continue;
      const info = await cdpSend(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ return { text: (this.textContent || "").trim().slice(0, 120), tag: this.tagName.toLowerCase(), visible: !!(this.offsetWidth || this.offsetHeight || this.getClientRects().length) }; }',
        returnByValue: true,
      });
      const value = info && info.result && info.result.value;
      if (value && value.visible && value.text) entries.push({ ...value, backendNodeId: node.backendNodeId });
    } catch {
      // 忽略单个节点
    } finally {
      if (objectId) cdpSend(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }
  return entries;
}

async function shadowObject(tabId, entry) {
  if (!entry || !Number.isInteger(entry.backendNodeId)) return null;
  const resolved = await cdpSend(tabId, 'DOM.resolveNode', { backendNodeId: entry.backendNodeId });
  return resolved && resolved.object ? resolved.object.objectId : null;
}

async function shadowRefClick(tabId, entry) {
  const objectId = await shadowObject(tabId, entry);
  if (!objectId) return null;
  try {
    const rect = await cdpSend(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ this.scrollIntoView({ block: "center", inline: "center" }); const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }',
      returnByValue: true,
    });
    const point = rect && rect.result ? rect.result.value : null;
    if (!point) return null;
    await acquire(tabId, 'shadow-ref');
    try {
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, clickCount: 0 });
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
    } finally {
      await release(tabId, 'shadow-ref').catch(() => {});
    }
    return point;
  } finally {
    cdpSend(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

async function shadowRefRead(tabId, entry) {
  const objectId = await shadowObject(tabId, entry);
  if (!objectId) return null;
  try {
    const info = await cdpSend(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ return (this.textContent || "").trim(); }',
      returnByValue: true,
    });
    return info && info.result ? info.result.value : null;
  } finally {
    cdpSend(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

/** 在 closed shadow 树里按文本找元素（CDP DOM.pierce + Runtime）。 */
async function findClosedShadow(tabId, text) {
  const doc = await cdpSend(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
  const candidates = [];
  (function walk(node, inClosed) {
    if (!node) return;
    if (inClosed && node.nodeType === 1 && /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL|SUMMARY)$/.test(node.nodeName || '')) {
      candidates.push(node);
    }
    for (const child of node.children || []) walk(child, inClosed);
    for (const shadow of node.shadowRoots || []) walk(shadow, inClosed || shadow.shadowRootType === 'closed');
    if (node.contentDocument) walk(node.contentDocument, false);
  })(doc && doc.root, false);
  for (const node of candidates.slice(0, 300)) {
    let objectId = null;
    let keep = false;
    try {
      const resolved = await cdpSend(tabId, 'DOM.resolveNode', { nodeId: node.nodeId });
      objectId = resolved && resolved.object && resolved.object.objectId;
      if (!objectId) continue;
      const info = await cdpSend(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(){ return { text: (this.textContent || "").trim().slice(0, 160), tag: this.tagName.toLowerCase(), visible: !!(this.offsetWidth || this.offsetHeight || this.getClientRects().length) }; }',
        returnByValue: true,
      });
      const value = info && info.result && info.result.value;
      if (value && value.visible && value.text.includes(text)) {
        keep = true;
        return { objectId, value };
      }
    } catch {
      // 单个节点失败继续找
    } finally {
      if (objectId && !keep) cdpSend(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }
  return null;
}

export async function shadowClick(params = {}) {
  const tabId = requireTabId(params);
  const text = String(params.text || '').trim();
  if (!text) throw bridgeError('E_BAD_ARG', 'shadow-click 需要 --closed-shadow-text <文本>');
  await acquire(tabId, 'closed-shadow');
  try {
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    const found = await findClosedShadow(tabId, text);
    if (!found) throw bridgeError('E_NOT_FOUND', 'closed shadow 内没有匹配文本的元素：' + text);
    await cdpSend(tabId, 'Runtime.callFunctionOn', {
      objectId: found.objectId,
      functionDeclaration: 'function(){ this.click(); return true; }',
      returnByValue: true,
    });
    return { ok: true, matched: found.value.text, tag: found.value.tag, via: 'cdp-closed-shadow' };
  } finally {
    await release(tabId, 'closed-shadow').catch(() => {});
  }
}

export async function shadowRead(params = {}) {
  const tabId = requireTabId(params);
  const text = String(params.text || '').trim();
  if (!text) throw bridgeError('E_BAD_ARG', 'shadow-read 需要 --closed-shadow-text <文本>');
  await acquire(tabId, 'closed-shadow');
  try {
    await cdpSend(tabId, 'DOM.enable').catch(() => {});
    const found = await findClosedShadow(tabId, text);
    if (!found) throw bridgeError('E_NOT_FOUND', 'closed shadow 内没有匹配文本的元素：' + text);
    return { ok: true, matched: found.value.text, tag: found.value.tag, via: 'cdp-closed-shadow' };
  } finally {
    await release(tabId, 'closed-shadow').catch(() => {});
  }
}

const frameAliasMaps = new Map();

/** 默认 observe：页面有 iframe 时把各 frame 一起观察，ref 统一为 @eN。 */
export async function observeSmart(params = {}) {
  const all = await observeFrames(params);
  if (!all.frames || all.frames.length <= 1) {
    const main = (all.frames && all.frames[0]) || { url: '', title: '', observation: '', refs: 0 };
    return { url: main.url, title: main.title, observation: main.observation, refs: main.refs };
  }
  const main = all.frames[0];
  return { url: main.url, title: main.title, observation: all.text, refs: all.refs, frames: all.frames, aliases: all.aliases };
}

export function clearFrameAliases(tabId) {
  frameAliasMaps.delete(tabId);
}

export function resolveFrameAlias(tabId, ref) {
  const map = frameAliasMaps.get(tabId);
  return (map && map.get(ref)) || null;
}

/** observe-frames：所有 frame（含跨源）分别观察，ref 统一为 @eN，并记录 frame 映射。 */
export async function observeFrames(params = {}) {
  const tabId = requireTabId(params);
  const list = await execPageAllFrames(tabId, 'observe', { probeHover: params.probeHover === true, maxDepth: params.maxDepth, debugSurfaces: params.debugSurfaces === true });
  const graph = await ensureFrameGraph(tabId).catch(() => []);
  const graphById = new Map(graph.map((item) => [item.frameId, item]));
  const metaList = await execPageAllFrames(tabId, 'frame-meta', {}).catch(() => []);
  const metaById = new Map(metaList.filter((item) => item && item.result).map((item) => [item.frameId, item.result]));
  const frames = [];
  const aliases = [];
  let aliasSeq = 0;
  for (const item of list) {
    if (item.error || !item.result) {
      const meta = graphById.get(item.frameId) || {};
      const visibility = metaById.get(item.frameId) || {};
      frames.push({ frameId: item.frameId, parentFrameId: meta.parentFrameId, url: meta.url || '', title: '', refs: 0, hidden: visibility.hidden === true, hiddenReason: visibility.reason || null, observation: '（该 frame 不可观察：' + (item.error || 'no result') + '）', error: item.error || 'no result' });
      continue;
    }
    const result = item.result;
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
  frames.sort((x, y) => x.frameId - y.frameId);
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
  frameAliasMaps.set(tabId, aliasMap);
  const text = frames.map((frame) => 'frame ' + frame.frameId + ' ' + frame.url + '\n' + frame.observation).join('\n\n');
  return { frames, text, refs: frames.reduce((sum, frame) => sum + frame.refs, 0), aliases, hiddenFrames: frames.filter((frame) => frame.hidden === true).length };
}
