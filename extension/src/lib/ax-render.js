// extension/src/lib/ax-render.js —— 用 AX 树 + DOMSnapshot 事实渲染兜底观察。
//
// 当 page-lib 观察失败（受限页、错误页、页面脚本异常等）时，CDP 的 AX 树仍然可用。
// 这里把 AX 节点渲染成与 VOM 相近的文本树，并附上 DOMSnapshot 几何，作为降级观察。
// 不分配 @eN ref（ref 必须来自页面侧），结果会标记 fallback:"ax"。

const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'listbox', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'textbox', 'treeitem',
]);

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

export function renderAxObservation(axNodes, facts, options = {}) {
  const maxNodes = clamp(options.maxNodes, 1, 400, 120);
  const maxChars = clamp(options.maxChars, 200, 20000, 4000);
  const lines = [];
  let chars = 0;
  for (const node of Array.isArray(axNodes) ? axNodes : []) {
    if (!node || typeof node.role !== 'string' || !node.role) continue;
    if (node.role === 'none' || node.role === 'generic') continue;
    if (node.role === 'InlineTextBox') continue;
    const depth = Math.min(Number.isInteger(node.depth) ? node.depth : 0, 8);
    const indent = '  '.repeat(depth);
    const name = String(node.name || '').replace(/\s+/g, ' ').trim();
    const bits = [];
    if (INTERACTIVE_ROLES.has(node.role)) bits.push('interactive');
    if (node.checked === true) bits.push('checked');
    if (node.selected === true) bits.push('selected');
    if (node.expanded === true) bits.push('expanded');
    if (node.disabled === true) bits.push('disabled');
    if (node.required === true) bits.push('required');
    const fact = facts && Number.isInteger(node.backendNodeId) ? facts.get(node.backendNodeId) : null;
    if (fact && fact.bounds && fact.visible !== false) {
      bits.push(`@${Math.round(fact.bounds.x)},${Math.round(fact.bounds.y)} ${Math.round(fact.bounds.width)}x${Math.round(fact.bounds.height)}`);
    }
    const value = node.value ? ` value=${JSON.stringify(String(node.value).slice(0, 60))}` : '';
    const line = `${indent}- ${node.role}${name ? ` ${JSON.stringify(name)}` : ''}${value}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    if (chars + line.length + 1 > maxChars) {
      lines.push('… (AX 观察已截断)');
      break;
    }
    lines.push(line);
    chars += line.length + 1;
    if (lines.length >= maxNodes) {
      lines.push('… (AX 观察已截断)');
      break;
    }
  }
  return lines.join('\n');
}
