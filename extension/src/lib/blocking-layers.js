// extension/src/lib/blocking-layers.js —— 从 AX + DOMSnapshot 识别阻挡层（对话框/弹窗）。
//
// page-lib 的 blocking 检测基于页面内可见性/命中测试；这里用 AX 的角色与 DOMSnapshot 的
// 几何做一次独立交叉检查：role=dialog/alertdialog、可见、面积达到视口一定比例即视为阻挡层。
// 只读事实，不改变动作策略。可见性/pointer-events 判定统一走 lib/vom-visibility.js，
// 不再在本模块维护第二套口径。
import { deriveLayers } from './vom-layers.js';
import { isFactVisible, isPointerTransparent } from './vom-visibility.js';

const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);

function areaOf(rect) {
  return rect && Number.isFinite(rect.width) && Number.isFinite(rect.height) ? rect.width * rect.height : 0;
}

/** 用有序层模型回填 index/kind/zIndex/blocking/topLayer（保留既有字段）。 */
function enrichLayers(list) {
  const model = deriveLayers(list);
  const bySource = new Map();
  for (const item of model.layers) {
    if (item.sourceIndex >= 0) bySource.set(item.sourceIndex, item);
  }
  list.forEach((layer, index) => {
    const mapped = bySource.get(index);
    if (!mapped || !layer) return;
    layer.index = mapped.index;
    layer.layerKind = mapped.kind;
    layer.zIndex = mapped.zIndex;
    layer.blocking = mapped.blocking;
    layer.topLayer = mapped.topLayer || null;
  });
  return list;
}

function rootViewport(axNodes, facts) {
  for (const node of Array.isArray(axNodes) ? axNodes : []) {
    if (!node || String(node.role || '').toLowerCase() !== 'rootwebarea') continue;
    const fact = Number.isInteger(node.backendNodeId) && facts ? facts.get(node.backendNodeId) : null;
    if (fact && fact.bounds && areaOf(fact.bounds) > 0) return fact.bounds;
  }
  return null;
}

/**
 * @param {Array} axNodes collectAxNodes 输出
 * @param {Map<number, {bounds?: object, visible?: boolean}>|null} facts DOMSnapshot 事实
 * @param {{minCoverage?: number, limit?: number}} options
 */
export function computeBlockingLayers(axNodes, facts, options = {}) {
  if (!facts || typeof facts.get !== 'function') return [];
  const minCoverage = Math.min(Math.max(Number(options.minCoverage) || 0.25, 0.05), 1);
  const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 10);
  const viewport = rootViewport(axNodes, facts);
  const viewportArea = areaOf(viewport);
  if (!viewportArea) return [];
  const layers = [];
  for (const node of Array.isArray(axNodes) ? axNodes : []) {
    if (!node || !DIALOG_ROLES.has(String(node.role || '').toLowerCase())) continue;
    const fact = Number.isInteger(node.backendNodeId) ? facts.get(node.backendNodeId) : null;
    if (!fact || !isFactVisible(fact) || !fact.bounds) continue;
    const coverage = areaOf(fact.bounds) / viewportArea;
    if (coverage < minCoverage) continue;
    layers.push({
      role: node.role,
      name: String(node.name || '').slice(0, 100),
      backendNodeId: Number.isInteger(node.backendNodeId) ? node.backendNodeId : null,
      bounds: fact.bounds,
      coverage: Math.round(coverage * 1000) / 1000,
    });
    if (layers.length >= limit) break;
  }
  return enrichLayers(layers);
}

function spansViewport(bounds, viewport, tolerance = 2) {
  if (!bounds || !viewport) return false;
  const t = Math.max(0, Number(tolerance) || 2);
  return bounds.x <= t
    && bounds.y <= t
    && bounds.x + bounds.width >= viewport.width - t
    && bounds.y + bounds.height >= viewport.height - t;
}

/**
 * Paint-order 分层：固定/粘性且铺满视口的元素，或 dialog/modal 角色，作为 L2 带。
 * 返回分层因子（winner + members/metadata），供格式化和 VOM payload 使用。
 * @param {Array} axNodes
 * @param {Map<number, object>} facts
 * @param {{minCoverage?: number, limit?: number, tolerance?: number}} options
 */
export function computeLayerBands(axNodes, facts, options = {}) {
  if (!facts || typeof facts.get !== 'function') return [];
  const viewport = rootViewport(axNodes, facts);
  const viewportArea = areaOf(viewport);
  if (!viewportArea) return [];
  const minCoverage = Math.min(Math.max(Number(options.minCoverage) || 0.2, 0.02), 1);
  const limit = Math.min(Math.max(Number(options.limit) || 3, 1), 6);
  const tolerance = Math.max(0, Number(options.tolerance) || 2);
  const axByBackend = new Map();
  for (const node of Array.isArray(axNodes) ? axNodes : []) {
    if (node && Number.isInteger(node.backendNodeId)) axByBackend.set(node.backendNodeId, node);
  }
  const candidates = [];
  for (const [backendId, fact] of facts) {
    if (!fact) continue;
    if (!isFactVisible(fact) || !fact.bounds) continue;
    const styles = fact.styles || {};
    if (isPointerTransparent(fact)) continue;
    const coverage = areaOf(fact.bounds) / viewportArea;
    if (!(coverage > 0)) continue;
    const ax = axByBackend.get(Number(backendId)) || {};
    const role = String(ax.role || '').toLowerCase();
    const modalRole = DIALOG_ROLES.has(role);
    const position = String(styles.position || '');
    const positioned = position === 'fixed' || position === 'sticky' || position === 'absolute';
    const spans = spansViewport(fact.bounds, viewport, tolerance);
    if (!modalRole && !(spans && positioned)) continue;
    if (coverage < minCoverage && !modalRole) continue;
    candidates.push({
      backendNodeId: Number(backendId),
      role: ax.role || null,
      name: String(ax.name || '').slice(0, 100),
      bounds: fact.bounds,
      coverage: Math.round(coverage * 1000) / 1000,
      paintOrder: Number.isFinite(fact.paintOrder) ? Number(fact.paintOrder) : 0,
      kind: modalRole ? 'modal' : 'mask',
      zIndex: styles['z-index'] == null || styles['z-index'] === '' ? null : styles['z-index'],
      topLayer: modalRole ? 'role-dialog' : null,
      spansViewport: spans,
      position,
    });
  }
  if (!candidates.length) return [];
  candidates.sort((a, b) => (b.coverage - a.coverage) || (b.paintOrder - a.paintOrder));
  const bands = [];
  for (const winner of candidates) {
    if (bands.length >= limit) break;
    const members = candidates.filter((item) => item.paintOrder >= winner.paintOrder).length;
    bands.push({
      level: 'L2',
      role: winner.role || (winner.kind === 'modal' ? 'dialog' : 'overlay'),
      name: winner.name,
      backendNodeId: winner.backendNodeId,
      bounds: winner.bounds,
      coverage: winner.coverage,
      kind: winner.kind,
      paintOrder: winner.paintOrder,
      members,
      spansViewport: winner.spansViewport,
    });
  }
  return enrichLayers(bands);
}
