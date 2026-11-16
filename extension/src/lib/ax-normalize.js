// src/lib/ax-normalize.js —— 把 CDP Accessibility.getFullAXTree 的原始节点归一成渲染输入。
export function normalizeAxTree(tree) {
  const allNodes = tree && Array.isArray(tree.nodes) ? tree.nodes : [];
  const out = [];
  for (const node of allNodes) {
    if (!node || node.ignored === true) continue;
    const role = node.role && node.role.value ? String(node.role.value) : '';
    if (!role || role === 'none' || role === 'generic' || role === 'InlineTextBox') continue;
    const name = node.name && node.name.value !== undefined ? String(node.name.value) : '';
    const value = node.value && node.value.value !== undefined ? String(node.value.value) : '';
    const backend = Number.isInteger(node.backendDOMNodeId) ? node.backendDOMNodeId : null;
    out.push({ role, name, value, backendNodeId: backend, visible: true });
  }
  return out;
}
