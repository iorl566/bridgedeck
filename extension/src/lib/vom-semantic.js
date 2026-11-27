// 语义图（架构层）：把 VOM 元素节点组织成 section/form/row 组 + 成员边。
// 这是轻量语义图，不是兼容目标的逐行移植；后续算法可在此扩展。
import { landmarkSection, rowAnchor, formAnchor } from './vom-section.js';
import { estimateVomTokens } from './vom-weights.js';

function slug(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'root';
}

function anchorKey(anchor) {
  return [anchor.role || '', anchor.tag || '', anchor.id || '', anchor.ref || ''].join('|');
}

function roleAnchor(node, roles) {
  const chain = [node, ...(Array.isArray(node && node.ancestors) ? node.ancestors : [])];
  for (const item of chain) {
    if (!item) continue;
    const role = String(item.role || '').toLowerCase();
    if (roles.includes(role)) return item;
  }
  return null;
}

function collectAnchors(node) {
  const chain = [...(Array.isArray(node && node.ancestors) ? node.ancestors : []), node].filter(Boolean);
  const out = [];
  for (const item of chain) {
    const role = String(item.role || '').toLowerCase();
    const tag = String(item.tag || '').toLowerCase();
    let kind = null;
    if (role === 'dialog' || role === 'alertdialog') kind = 'dialog';
    else if (tag === 'form' || role === 'form') kind = 'form';
    else if (['table', 'grid', 'treegrid'].includes(role)) kind = 'table';
    else if (['list', 'tree', 'menu', 'listbox'].includes(role)) kind = 'list';
    else if (role === 'row') kind = 'row';
    else if (landmarkSection([item])) kind = 'section';
    if (kind) out.push({ kind, key: anchorKey(item), anchor: item });
  }
  return out;
}

function strongestAnchor(node) {
  const dialog = roleAnchor(node, ['dialog', 'alertdialog']);
  if (dialog) return { kind: 'dialog', anchor: dialog };
  const form = formAnchor(node && node.ancestors);
  if (form) return { kind: 'form', anchor: form };
  const table = roleAnchor(node, ['table', 'grid', 'treegrid']);
  if (table) return { kind: 'table', anchor: table };
  const list = roleAnchor(node, ['list', 'tree', 'menu', 'listbox']);
  if (list) return { kind: 'list', anchor: list };
  const row = rowAnchor(node && node.ancestors);
  if (row) return { kind: 'row', anchor: row };
  const section = landmarkSection(node && node.ancestors);
  if (section) return { kind: 'section', anchor: section };
  return null;
}

export function buildVomSemanticGraph(entries, { limit = 200 } = {}) {
  const groups = new Map();
  const nodes = [];
  const edges = [];
  const membership = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.id || !entry.node) continue;
    const picked = strongestAnchor(entry.node);
    if (!picked) continue;
    const pickedKey = picked.kind + '|' + anchorKey(picked.anchor);
    const chain = collectAnchors(entry.node);
    let group = groups.get(pickedKey);
    if (!group) {
      group = {
        id: 'g:' + picked.kind + ':' + slug(anchorKey(picked.anchor)),
        key: pickedKey,
        kind: picked.kind,
        anchor: picked.anchor,
        members: [],
        related: new Set(),
        tokens: 0,
      };
      groups.set(pickedKey, group);
    }
    for (const item of chain) {
      const key = item.kind + '|' + item.key;
      if (key !== pickedKey) group.related.add(key);
    }
    if (!group.members.includes(entry.id)) {
      group.members.push(entry.id);
      group.tokens += estimateVomTokens(entry.node);
    }
    membership.push({ group: group.id, node: entry.id });
  }
  const scoreById = new Map((Array.isArray(entries) ? entries : []).map((entry) => [entry.id, Number(entry.node && entry.node.vomScore) || 0]));
  for (const group of groups.values()) {
    group.score = group.members.reduce((sum, id) => sum + (scoreById.get(id) || 0), 0);
    group.averageScore = group.members.length ? group.score / group.members.length : 0;
    group.density = group.tokens && group.members.length ? group.tokens / group.members.length : 0;
  }
  const ordered = [...groups.values()].sort((a, b) => b.members.length - a.members.length).slice(0, Math.max(1, Number(limit) || 200));
  const rank = { dialog: 0, section: 0, table: 1, list: 1, form: 2, row: 3 };
  const byKey = new Map([...groups.values()].map((group) => [group.key, group]));
  const containsSeen = new Set();
  for (const group of ordered) {
    nodes.push({ id: group.id, kind: 'group', groupKind: group.kind, anchor: group.anchor, members: group.members.length, memberIds: group.members, tokens: group.tokens, score: group.score, averageScore: group.averageScore, density: group.density });
    for (const nodeId of group.members) edges.push({ type: 'member', from: group.id, to: nodeId, groupKind: group.kind });
    for (const key of group.related) {
      const parent = byKey.get(key);
      if (!parent || parent.id === group.id) continue;
      if (rank[parent.kind] > rank[group.kind]) continue;
      const edgeKey = parent.id + '>' + group.id;
      if (containsSeen.has(edgeKey)) continue;
      containsSeen.add(edgeKey);
      edges.push({ type: 'contains', from: parent.id, to: group.id, fromKind: parent.kind, toKind: group.kind });
    }
  }
  const memberIds = new Set(membership.map((item) => item.node));
  const byKind = {};
  for (const group of ordered) byKind[group.kind] = (byKind[group.kind] || 0) + 1;
  return {
    version: 2,
    nodes,
    edges,
    stats: {
      groups: ordered.length,
      members: memberIds.size,
      grouped: membership.length,
      ungrouped: 0,
      byKind,
      contains: edges.filter((edge) => edge.type === 'contains').length,
    },
  };
}

/** 用语义组做预算：保留得分最高的 N 组，或平均分低于阈值的组被丢弃；未分组节点保留。 */
export function filterSemanticGroups(entries, graph, { maxGroups = 0, minGroupScore = 0, maxGroupTokens = 0, includeContext = false } = {}) {
  const limit = Math.max(0, Number(maxGroups) || 0);
  const min = Math.max(0, Number(minGroupScore) || 0);
  const tokenLimit = Math.max(0, Number(maxGroupTokens) || 0);
  if (!limit && !min && !tokenLimit) return null;
  const byId = new Map((Array.isArray(entries) ? entries : []).map((entry) => [entry.id, entry]));
  const kindWeight = { dialog: 1.5, form: 1.3, table: 1.15, list: 1.1, row: 1, section: 1 };
  const groups = (graph && Array.isArray(graph.nodes) ? graph.nodes : []).map((group) => {
    const members = Array.isArray(group.memberIds) ? group.memberIds : [];
    const scores = members.map((id) => Number(byId.get(id) && byId.get(id).node && byId.get(id).node.vomScore) || 0);
    const raw = scores.reduce((sum, value) => sum + value, 0);
    const weight = kindWeight[group.groupKind] || 1;
    const total = raw * weight;
    return { id: group.id, members, total, average: members.length ? total / members.length : 0, tokens: Number(group.tokens) || 0 };
  });
  let selected = groups
    .filter((group) => !min || group.average >= min)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit || groups.length);
  let tokensUsed = 0;
  if (tokenLimit) {
    const bounded = [];
    for (const group of selected) {
      if (bounded.length && tokensUsed + group.tokens > tokenLimit) break;
      bounded.push(group);
      tokensUsed += group.tokens;
    }
    selected = bounded;
  }
  const selectedIds = new Set(selected.map((group) => group.id));
  let contextGroups = 0;
  if (includeContext) {
    const byGroupId = new Map(groups.map((group) => [group.id, group]));
    const contains = (graph && Array.isArray(graph.edges) ? graph.edges : []).filter((edge) => edge.type === 'contains');
    for (const edge of contains) {
      if (!selectedIds.has(edge.to)) continue;
      const parent = byGroupId.get(edge.from);
      if (!parent || selectedIds.has(parent.id)) continue;
      if (tokenLimit && tokensUsed + parent.tokens > tokenLimit) continue;
      selectedIds.add(parent.id);
      selected.push(parent);
      tokensUsed += parent.tokens;
      contextGroups += 1;
    }
  }
  const keep = new Set(selected.flatMap((group) => group.members));
  const grouped = new Set(groups.flatMap((group) => group.members));
  const ids = new Set((Array.isArray(entries) ? entries : []).filter((entry) => !grouped.has(entry.id) || keep.has(entry.id)).map((entry) => entry.id));
  return { ids, dropped: grouped.size - [...keep].length, groups: selected.length, contextGroups, tokensUsed };
}
