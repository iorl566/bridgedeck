// extension/src/lib/blocking-layers.js —— 从 AX + DOMSnapshot 识别阻挡层（对话框/弹窗）。
//
// page-lib 的 blocking 检测基于页面内可见性/命中测试；这里用 AX 的角色与 DOMSnapshot 的
// 几何做一次独立交叉检查：role=dialog/alertdialog、可见、面积达到视口一定比例即视为阻挡层。
// 只读事实，不改变动作策略。

const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);

function areaOf(rect) {
  return rect && Number.isFinite(rect.width) && Number.isFinite(rect.height) ? rect.width * rect.height : 0;
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
    if (!fact || fact.visible !== true || !fact.bounds) continue;
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
  return layers;
}
