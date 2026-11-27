// 按语义组裁剪：每个 section/row/form 组只保留分数最高的 N 个节点。
import { landmarkSection, rowAnchor, formAnchor } from './vom-section.js';
import { estimateVomTokens } from './vom-weights.js';

function groupAnchor(node) {
  return formAnchor(node && node.ancestors) || rowAnchor(node && node.ancestors) || landmarkSection(node && node.ancestors);
}

function groupKey(anchor) {
  if (!anchor) return '';
  return [anchor.role || '', anchor.tag || '', anchor.id || '', anchor.ref || ''].join('|');
}

export function compactVomNodes(nodes, { perGroup = 0, maxGroupTokens = 0 } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const limit = Math.max(0, Math.min(Number(perGroup) || 0, 50));
  const tokenLimit = Math.max(0, Number(maxGroupTokens) || 0);
  if (!limit && !tokenLimit) return { nodes: list, groups: 0, dropped: 0 };
  const groups = new Map();
  for (const node of list) {
    const key = groupKey(groupAnchor(node));
    if (!key) continue;
    const bucket = groups.get(key) || [];
    bucket.push(node);
    groups.set(key, bucket);
  }
  const keep = new Set();
  for (const bucket of groups.values()) {
    const sorted = bucket.slice().sort((a, b) => Number(b.vomScore || 0) - Number(a.vomScore || 0));
    let kept = 0;
    let tokens = 0;
    for (const node of sorted) {
      if (limit && kept >= limit) break;
      const cost = estimateVomTokens(node);
      if (tokenLimit && tokens + cost > tokenLimit) break;
      keep.add(node);
      kept += 1;
      tokens += cost;
    }
  }
  const kept = list.filter((node) => {
    const key = groupKey(groupAnchor(node));
    return !key || keep.has(node);
  });
  return { nodes: kept, groups: groups.size, dropped: list.length - kept.length };
}
