// ARIA 快照：把 VOM 节点渲染成精简的角色/名称树，供代理快速阅读。
export function renderAriaSnapshot(nodes, { maxChars = 4000 } = {}) {
  const lines = [];
  let used = 0;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node) continue;
    const role = String(node.role || node.tag || '').trim();
    const name = String(node.name || '').replace(/\s+/g, ' ').trim();
    if (!role && !name) continue;
    const depth = Math.max(0, Math.min(12, Number(node.depth) || 0));
    const line = `${'  '.repeat(depth)}- ${role || 'generic'}${name ? ' "' + name.slice(0, 120) + '"' : ''}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
