// extension/src/lib/ax-pipeline.js —— AX + DOMSnapshot 备用采集器的节点构建（纯函数）。
//
// 输出与 page-lib 的 --vom 节点尽量同形（role/name/value/bounds/visible/table），
// 但没有 @eN ref：它用于采集器替换前的对照与 page-lib 不可用时的降级观察。

import { isInteractiveAxRole } from './unmapped-ax.js';

const SKIP_ROLES = new Set(['none', 'generic', 'inlinetextbox']);

export function buildAxNodes(axNodes, facts, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
  const out = [];
  for (const node of Array.isArray(axNodes) ? axNodes : []) {
    if (!node || typeof node.role !== 'string' || !node.role) continue;
    if (SKIP_ROLES.has(node.role.toLowerCase())) continue;
    const backend = Number.isInteger(node.backendNodeId) ? node.backendNodeId : null;
    const fact = backend !== null && facts && facts.get ? facts.get(backend) : null;
    if (fact && fact.visible === false) continue;
    out.push({
      role: node.role,
      name: String(node.name || '').slice(0, 120),
      value: String(node.value || '').slice(0, 120),
      backendNodeId: backend,
      bounds: fact && fact.bounds ? fact.bounds : null,
      visible: fact ? fact.visible : true,
      clickable: fact ? fact.clickable === true : null,
      interactive: isInteractiveAxRole(node.role),
    });
    if (out.length >= limit) break;
  }
  return out;
}
