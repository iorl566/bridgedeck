// src/dom-snapshot.js —— DOMSnapshot 事实采集（P1 增量）。
//
// 用 Chrome 原生 DOMSnapshot.captureSnapshot 一次拿到：每个节点的几何（bounds）、
// 指定的计算样式与 isClickable，再按 backendNodeId 映射到 AX 节点 / VOM 节点。
// 与 bsk 的 DOMSnapshot 管线同源，但当前只做“几何/可见性/可点击”增量，
// 不替换既有 page-lib VOM 遍历。

import { acquire, release, send as cdpSend } from './debugger.js';

/** 与 bsk BASIC_SNAPSHOT 对齐的一小组高价值样式。 */
export const FACTS_STYLES = [
  'display',
  'visibility',
  'opacity',
  'pointer-events',
  'position',
  'overflow-x',
  'overflow-y',
  'cursor',
  'color',
  'background-color',
];

/**
 * 纯解码：DOMSnapshot 回复 → Map<backendNodeId, {bounds, visible, clickable, styles}>。
 * 不依赖 chrome，便于单测。
 */
export function decodeSnapshotFacts(snapshot, { wantedStyles = FACTS_STYLES } = {}) {
  const facts = new Map();
  const document = snapshot && Array.isArray(snapshot.documents) ? snapshot.documents[0] : null;
  const nodes = document && document.nodes;
  const layout = document && document.layout;
  if (!nodes || !layout) return facts;
  const strings = Array.isArray(snapshot.strings) ? snapshot.strings : [];
  const backendNodeIds = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId : [];
  const nodeIndex = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
  const boundsList = Array.isArray(layout.bounds) ? layout.bounds : [];
  const stylesList = Array.isArray(layout.styles) ? layout.styles : [];
  const paintOrders = Array.isArray(layout.paintOrders) ? layout.paintOrders : [];
  const clickable = new Set(
    nodes.isClickable && Array.isArray(nodes.isClickable.index) ? nodes.isClickable.index : [],
  );
  const attributesList = Array.isArray(nodes.attributes) ? nodes.attributes : [];
  const nodeNameList = Array.isArray(nodes.nodeName) ? nodes.nodeName : [];
  const attributeOf = (idx, name) => {
    const raw = attributesList[idx];
    if (!Array.isArray(raw)) return undefined;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (strings[raw[i]] === name) return strings[raw[i + 1]];
    }
    return undefined;
  };
  const sparseMap = (data) => {
    const map = new Map();
    if (data && Array.isArray(data.index) && Array.isArray(data.value)) {
      for (let i = 0; i < data.index.length; i += 1) map.set(data.index[i], data.value[i]);
    }
    return map;
  };
  const inputValueByNode = sparseMap(nodes.inputValue);
  const checkedNodes = new Set(nodes.inputChecked && Array.isArray(nodes.inputChecked.index) ? nodes.inputChecked.index : []);
  const selectedNodes = new Set(nodes.optionSelected && Array.isArray(nodes.optionSelected.index) ? nodes.optionSelected.index : []);
  // node 数组下标 → layout 下标
  const layoutByNode = new Map();
  for (let k = 0; k < nodeIndex.length; k += 1) {
    const nodeIdx = nodeIndex[k];
    if (Number.isInteger(nodeIdx)) layoutByNode.set(nodeIdx, k);
  }
  for (let idx = 0; idx < backendNodeIds.length; idx += 1) {
    const backendId = backendNodeIds[idx];
    if (!Number.isInteger(backendId)) continue;
    const k = layoutByNode.get(idx);
    const rawBounds = k === undefined ? undefined : boundsList[k];
    let bounds = null;
    if (Array.isArray(rawBounds) && rawBounds.length >= 4) {
      const x = Number(rawBounds[0]);
      const y = Number(rawBounds[1]);
      const width = Number(rawBounds[2]);
      const height = Number(rawBounds[3]);
      if ([x, y, width, height].every((value) => Number.isFinite(value))) bounds = { x, y, width, height };
    }
    const styles = {};
    const rawStyles = k === undefined ? undefined : stylesList[k];
    if (Array.isArray(rawStyles)) {
      for (let i = 0; i < rawStyles.length; i += 1) {
        const name = wantedStyles[i] || String(i);
        const strIdx = rawStyles[i];
        styles[name] = strings[strIdx] !== undefined ? String(strings[strIdx]) : '';
      }
    }
    const display = styles.display || '';
    const visibility = styles.visibility || '';
    const opacity = styles.opacity || '';
    const hasArea = !bounds || (bounds.width > 0 && bounds.height > 0);
    const visible = k !== undefined
      && display !== 'none'
      && visibility !== 'hidden'
      && visibility !== 'collapse'
      && opacity !== '0'
      && hasArea;
    const fact = { bounds, visible, clickable: clickable.has(idx), styles };
    if (k !== undefined && Number.isFinite(Number(paintOrders[k]))) fact.paintOrder = Number(paintOrders[k]);
    if (inputValueByNode.has(idx)) {
      const valueIndex = inputValueByNode.get(idx);
      let value = strings[valueIndex] !== undefined ? String(strings[valueIndex]) : '';
      const tag = nodeNameList[idx] !== undefined ? String(strings[nodeNameList[idx]]).toLowerCase() : '';
      const type = String(attributeOf(idx, 'type') || '').toLowerCase();
      const autocomplete = String(attributeOf(idx, 'autocomplete') || '').toLowerCase();
      const sensitive = (tag === 'input' && type === 'password')
        || /(^|[\s-])(current|new|one-time|cc)-?password/i.test(autocomplete);
      if (sensitive) value = '********';
      fact.value = value;
    }
    if (checkedNodes.has(idx)) fact.checked = true;
    if (selectedNodes.has(idx)) fact.selected = true;
    facts.set(backendId, fact);
  }
  return facts;
}

/** 从 DOMSnapshot 的属性里解出页面侧 `data-bb-vom` 标记 → backendNodeId，省掉 DOM.getDocument。 */
export function decodeVomIds(snapshot) {
  const map = new Map();
  const document = snapshot && Array.isArray(snapshot.documents) ? snapshot.documents[0] : null;
  const nodes = document && document.nodes;
  if (!nodes) return map;
  const strings = Array.isArray(snapshot.strings) ? snapshot.strings : [];
  const backendNodeIds = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId : [];
  const attributes = Array.isArray(nodes.attributes) ? nodes.attributes : [];
  for (let index = 0; index < backendNodeIds.length; index += 1) {
    const backendId = backendNodeIds[index];
    const raw = attributes[index];
    if (!Number.isInteger(backendId) || !Array.isArray(raw)) continue;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = strings[raw[i]];
      if (name !== 'data-bb-vom') continue;
      const value = strings[raw[i + 1]];
      if (value) map.set(String(value), backendId);
      break;
    }
  }
  return map;
}

/** 采集当前标签页的 DOMSnapshot 事实与 vom 标记映射；调用方负责忽略失败。 */
export async function captureDomSnapshot(tabId) {
  await acquire(tabId, 'dom-facts');
  try {
    await cdpSend(tabId, 'DOMSnapshot.enable').catch(() => {});
    const snapshot = await cdpSend(tabId, 'DOMSnapshot.captureSnapshot', {
      computedStyles: [...FACTS_STYLES],
      includeDOMRects: true,
      includePaintOrder: true,
    });
    return { facts: decodeSnapshotFacts(snapshot), vomIds: decodeVomIds(snapshot) };
  } finally {
    await release(tabId, 'dom-facts').catch(() => {});
  }
}

/** 采集当前标签页的 DOMSnapshot 事实；调用方负责忽略失败。 */
export async function captureDomSnapshotFacts(tabId) {
  return (await captureDomSnapshot(tabId)).facts;
}
