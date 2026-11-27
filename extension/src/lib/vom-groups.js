// VOM 语义分组：把节点按最近 landmark/row/form 聚成轻量组。
import { landmarkSection, rowAnchor, formAnchor } from './vom-section.js';
import { estimateVomTokens } from './vom-weights.js';

function groupKey(kind, anchor) {
  return [kind, anchor.role || '', anchor.tag || '', anchor.id || '', anchor.ref || ''].join('|');
}

export function buildVomGroups(entries, { limit = 100 } = {}) {
  const groups = new Map();
  const add = (kind, anchor, id, node) => {
    if (!anchor || !id) return;
    const key = groupKey(kind, anchor);
    const found = groups.get(key) || { id: key, kind, anchor, nodeIds: [], tokens: 0 };
    found.nodeIds.push(id);
    found.tokens += estimateVomTokens(node);
    groups.set(key, found);
  };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.id || !entry.node) continue;
    add('section', landmarkSection(entry.node.ancestors), entry.id, entry.node);
    add('row', rowAnchor(entry.node.ancestors), entry.id, entry.node);
    add('form', formAnchor(entry.node.ancestors), entry.id, entry.node);
  }
  const list = [...groups.values()].filter((group) => group.nodeIds.length > 0);
  const ordered = list.sort((a, b) => b.nodeIds.length - a.nodeIds.length).slice(0, Math.max(1, Number(limit) || 100));
  return {
    sections: ordered.filter((group) => group.kind === 'section'),
    rows: ordered.filter((group) => group.kind === 'row'),
    forms: ordered.filter((group) => group.kind === 'form'),
    total: list.length,
    shown: ordered.length,
  };
}
