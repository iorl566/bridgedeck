// src/tools/observation-ax.js —— AX 树采集/租约与 VOM backendNodeId 合并（从 observation 拆出）。
import { acquire, release, send as cdpSend } from '../debugger.js';
import { sleep } from '../tabs.js';
import { hideTakeover, showTakeover } from '../takeover.js';
import { captureDomSnapshotFacts } from '../dom-snapshot.js';
import { renderAxObservation } from '../lib/ax-render.js';
import { buildAxNodes } from '../lib/ax-pipeline.js';
import { computeTableFacts } from '../lib/table-facts.js';

/** 通过 data-bb-vom 临时标记把 DOM 节点映射到 backendNodeId（open shadow / 同源 iframe 也遍历）。 */
export async function mapVomBackendNodeIds(tabId) {
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
export function joinAxIntoNodes(nodes, axNodes, backendMap) {
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

export async function collectAxNodes(tabId, limit = 1000) {
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
export async function observeAxFallback(tabId, params, options = {}) {
  // 先收起 BridgeDeck 自己的浮层，避免 AX 树把接管卡片也当成页面内容。
  // AX 树更新有一拍延迟，移除后稍等一下再取快照。
  await hideTakeover(tabId, { preserveState: true }).catch(() => {});
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
