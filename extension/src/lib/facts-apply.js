// extension/src/lib/facts-apply.js —— 把 DOMSnapshot 事实合并进 VOM 节点（纯函数）。
//
// 语义约定：
// * bounds/visible/paintOrder 以 DOMSnapshot 为权威；
// * clickable 以 page-lib（命中测试）为主，DOMSnapshot 的 isClickable 作为 domClickable 参考；
// * visible=false 与 page-lib hitTest=self 矛盾时标 visibilityStale；
// * 表单值差异标 formStateStale（密码 ******** 不比较）；
// * 节点落在阻挡层矩形内时标 underBlockingLayer。

function inside(bounds, layer) {
  if (!bounds || !layer) return false;
  return bounds.x >= layer.x
    && bounds.y >= layer.y
    && bounds.x + bounds.width <= layer.x + layer.width
    && bounds.y + bounds.height <= layer.y + layer.height;
}

export function applyFactToNode(node, fact) {
  if (!node || !fact) return false;
  node.bounds = fact.bounds;
  node.visible = fact.visible;
  if (fact.visible === false && node.hitTest === 'self') node.visibilityStale = true;
  if (fact.clickable !== undefined) {
    if (node.clickable === undefined) node.clickable = fact.clickable;
    else node.domClickable = fact.clickable;
  }
  if (fact.paintOrder !== undefined) node.domPaintOrder = fact.paintOrder;
  if (fact.value !== undefined) {
    node.domValue = fact.value;
    if (fact.value !== '********' && typeof node.value === 'string' && node.value !== fact.value) {
      node.formStateStale = true;
    }
  }
  if (fact.checked !== undefined) {
    node.domChecked = fact.checked;
    if (typeof node.checked === 'boolean' && node.checked !== fact.checked) node.formStateStale = true;
  }
  if (fact.selected !== undefined) node.domSelected = fact.selected;
  return true;
}

/** 给落在阻挡层内的节点打标（阻挡层来自 computeBlockingLayers）。 */
export function applyBlockingLayers(nodes, layers) {
  const list = Array.isArray(layers) ? layers : [];
  if (!list.length) return;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || !node.bounds) continue;
    const layer = list.find((item) => item
      && inside(node.bounds, item.bounds)
      && !(Number.isInteger(item.backendNodeId) && item.backendNodeId === node.backendNodeId));
    if (layer) {
      node.underBlockingLayer = {
        role: layer.role,
        name: layer.name,
        coverage: layer.coverage,
      };
    }
  }
}
