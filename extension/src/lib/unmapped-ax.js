// extension/src/lib/unmapped-ax.js —— AX 树中未映射到 VOM ref 的可交互元素。
//
// page-lib 的语义树只覆盖它遍历到的节点；AX/DOMSnapshot 可能看到额外的按钮/链接
//（例如 Shadow DOM 深层、虚拟列表、page-lib 漏掉的已渲染节点）。这里把它们列为
// “仅供定位”的补充信息：带 role/name/backendNodeId 与 DOMSnapshot 几何，但没有 @eN
//（ref 必须来自页面侧），避免调用方误用。

const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'listbox', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'textbox', 'treeitem',
]);

/** BridgeDeck 自己接管浮层上的按钮文案：它们属于扩展 UI，不应被当成页面元素列出。 */
const OWN_OVERLAY_LABELS = new Set([
  '暂停 Agent', '停止任务', 'Pause Agent', 'Stop task', '正在停止任务…', 'Stopping…',
  '收起', '展开', 'Collapse', 'Expand', '–', '—', '-',
]);

export function isInteractiveAxRole(role) {
  return INTERACTIVE_ROLES.has(String(role || ''));
}

/**
 * @param {Array} axNodes collectAxNodes 的输出
 * @param {Set<number>|number[]} matchedBackendIds 已映射到 VOM ref 的 backendNodeId
 * @param {Map<number, {bounds?: object, visible?: boolean}>|null} facts DOMSnapshot 事实
 * @param {{limit?: number}} options
 */
export function collectUnmappedAx(axNodes, matchedBackendIds, facts, options = {}) {
  const matched = matchedBackendIds instanceof Set
    ? matchedBackendIds
    : new Set(Array.isArray(matchedBackendIds) ? matchedBackendIds : []);
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50);
  const out = [];
  for (const node of Array.isArray(axNodes) ? axNodes : []) {
    if (!node || !isInteractiveAxRole(node.role)) continue;
    const backend = Number.isInteger(node.backendNodeId) ? node.backendNodeId : null;
    if (!backend || matched.has(backend)) continue;
    const fact = facts && facts.get ? facts.get(backend) : null;
    if (fact && fact.visible === false) continue;
    const name = String(node.name || '').trim();
    if (OWN_OVERLAY_LABELS.has(name)) continue;
    out.push({
      role: node.role,
      name: name.slice(0, 100),
      value: String(node.value || '').slice(0, 80),
      backendNodeId: backend,
      bounds: fact && fact.bounds ? fact.bounds : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function renderUnmappedAx(list) {
  const lines = [];
  for (const item of Array.isArray(list) ? list : []) {
    const geometry = item.bounds
      ? ` (@${Math.round(item.bounds.x)},${Math.round(item.bounds.y)} ${Math.round(item.bounds.width)}x${Math.round(item.bounds.height)})`
      : '';
    const name = item.name ? ` ${JSON.stringify(item.name)}` : '';
    lines.push(`- ${item.role}${name}${geometry}  [仅供定位，无 ref]`);
  }
  return lines.join('\n');
}
