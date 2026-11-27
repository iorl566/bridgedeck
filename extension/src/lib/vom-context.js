// lib/vom-context.js —— VOM 语义上下文/分组（landmark / 表单 / 表格，纯函数）。
//
// 语义图 v2（lib/vom-semantic.js）只回答“节点属于哪个强锚点组”；本模块补上下文层：
//   - 一次遍历给出每个节点的完整上下文链：表格 > 表单 > landmark（近 → 远），带父组关系；
//   - 三类分组各自带结构事实：landmark 的 groupKind/name、表单的控件成员、表格的表头/行数/题注；
//   - 组有 parent/children/depth，跨 frame 的节点按 `f<frameId>:` 前缀归到对应 frame。
//
// 输入全部是观测已产生的事实（payload entries + 页面图），不读 DOM，可单测。
// 与 lib/vom-semantic.js 的关系：语义图负责“保留哪些组”的预算决策，本模块负责“上下文是什么”。

export const VOM_CONTEXT_VERSION = 1;

/** landmark 类角色（含 form 之外的 ARIA landmark）。 */
export const LANDMARK_ROLES = Object.freeze([
  'banner', 'main', 'navigation', 'region', 'complementary', 'contentinfo', 'search', 'form',
]);

/** 常见 landmark 标签 → 隐式角色。 */
export const LANDMARK_BY_TAG = Object.freeze({
  header: 'banner',
  nav: 'navigation',
  main: 'main',
  footer: 'contentinfo',
  aside: 'complementary',
  section: 'region',
  form: 'form',
});

/** 表单分组：form 容器 + fieldset/group/radiogroup 等组合控件容器。 */
export const FORM_GROUP_ROLES = Object.freeze(['form', 'group', 'search', 'radiogroup', 'fieldset']);

/** 表格分组：table/grid/treegrid。 */
export const TABLE_GROUP_ROLES = Object.freeze(['table', 'grid', 'treegrid']);

/** 表格表头角色。 */
export const TABLE_HEADER_ROLES = Object.freeze(['columnheader', 'rowheader']);

const KIND_RANK = Object.freeze({ landmark: 0, form: 1, table: 2 });

export const CONTEXT_LIMITS = Object.freeze({
  groups: 200,
  contexts: 400,
  depth: 8,
  headers: 12,
  members: 600,
});

function limitOf(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function lower(value) {
  return String(value == null ? '' : value).toLowerCase();
}

function sanitize(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'root';
}

/** 从 DOM id 里解出 frameId（跨 frame 子图 id 形如 `f2:@e7`）；非帧命名返回 null。 */
export function frameIdOfContextNode(id) {
  const match = /^f(\d+):/.exec(String(id == null ? '' : id));
  return match ? Number(match[1]) : null;
}

/**
 * 判定一个祖先事实是否构成上下文锚点。
 * @param {{role?:string,tag?:string}|null} item
 * @returns {{kind:'landmark'|'form'|'table', groupKind:string, role:string|null, tag:string|null}|null}
 */
export function classifyContextAnchor(item) {
  if (!item || typeof item !== 'object') return null;
  const role = lower(item.role);
  const tag = lower(item.tag);
  if (!role && !tag) return null;
  if (TABLE_GROUP_ROLES.includes(role) || tag === 'table') {
    return { kind: 'table', groupKind: role || 'table', role: role || null, tag: tag || null };
  }
  if (role === 'form' || tag === 'form') {
    return { kind: 'form', groupKind: 'form', role: role || null, tag: tag || null };
  }
  if (FORM_GROUP_ROLES.includes(role) || tag === 'fieldset') {
    return { kind: 'form', groupKind: role || 'fieldset', role: role || null, tag: tag || null };
  }
  if (LANDMARK_ROLES.includes(role)) {
    return { kind: 'landmark', groupKind: role, role, tag: tag || null };
  }
  if (LANDMARK_BY_TAG[tag]) {
    return { kind: 'landmark', groupKind: LANDMARK_BY_TAG[tag], role: role || null, tag };
  }
  return null;
}

function tokenCost(node) {
  // 与 vom-weights.estimateVomTokens 同口径（name+role + 固定结构开销），这里只做分组汇总。
  const name = String((node && node.name) || '');
  const role = String((node && node.role) || '');
  return 8 + Math.ceil(name.length / 4) + Math.ceil(role.length / 4);
}

/**
 * @param {{entries?:Array, graph?:object|null, frames?:Array,
 *          limits?:{groups?:number,contexts?:number,headers?:number,depth?:number}}} [input]
 * @returns {{version:number, groups:object[], roots:string[], contexts:object[],
 *            frames:object[], stats:object}}
 */
export function buildVomContext(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries.filter((entry) => entry && entry.id) : [];
  const graph = input.graph && typeof input.graph === 'object' ? input.graph : null;
  const maxGroups = limitOf(input.limits && input.limits.groups, CONTEXT_LIMITS.groups, 2000);
  const maxContexts = limitOf(input.limits && input.limits.contexts, CONTEXT_LIMITS.contexts, 5000);
  const maxDepth = limitOf(input.limits && input.limits.depth, CONTEXT_LIMITS.depth, 32);
  const maxHeaders = limitOf(input.limits && input.limits.headers, CONTEXT_LIMITS.headers, 64);

  const nodeById = new Map();
  const domIdToId = new Map();
  const metaById = new Map();
  const childAdjacency = new Map();
  const parentAdjacency = new Map();
  if (graph) {
    for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
      if (!node || node.id == null) continue;
      const id = String(node.id);
      nodeById.set(id, node);
      if (node.domId) domIdToId.set(String(node.domId), id);
      metaById.set(id, {
        id,
        role: lower(node.role),
        tag: lower(node.tag),
        domId: node.domId ? String(node.domId) : null,
        name: node.name ? String(node.name) : null,
      });
    }
    for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
      if (!edge || edge.type !== 'child') continue;
      const from = String(edge.from == null ? '' : edge.from);
      const to = String(edge.to == null ? '' : edge.to);
      if (!from || !to) continue;
      const bucket = childAdjacency.get(from) || [];
      bucket.push(to);
      childAdjacency.set(from, bucket);
      if (!parentAdjacency.has(to)) parentAdjacency.set(to, from);
    }
  }

  // 祖先事实补名称：页面图节点不带名字时，用 entry.node.ancestors 上的 name 反填。
  const resolveAncestorId = (ancestor) => {
    if (!ancestor) return null;
    if (ancestor.id && domIdToId.has(String(ancestor.id))) return domIdToId.get(String(ancestor.id));
    if (ancestor.ref && nodeById.has(String(ancestor.ref))) return String(ancestor.ref);
    if (ancestor.id) return 'dom:' + String(ancestor.id);
    if (ancestor.ref) return String(ancestor.ref);
    return null;
  };
  for (const entry of entries) {
    const ancestors = Array.isArray(entry.node && entry.node.ancestors) ? entry.node.ancestors : [];
    for (const ancestor of ancestors) {
      const id = resolveAncestorId(ancestor);
      if (!id) continue;
      if (!metaById.has(id)) {
        metaById.set(id, {
          id,
          role: lower(ancestor.role),
          tag: lower(ancestor.tag),
          domId: ancestor.id ? String(ancestor.id) : null,
          name: ancestor.name ? String(ancestor.name) : null,
        });
      } else if (!metaById.get(id).name && ancestor.name) {
        metaById.get(id).name = String(ancestor.name);
      }
    }
  }

  const groups = new Map();
  const contextByNode = new Map();
  const tableFactsByAnchor = new Map();
  for (const entry of entries) {
    const facts = entry.node && entry.node.tableFacts;
    if (!facts || typeof facts !== 'object') continue;
    const own = String(entry.id);
    const resolved = metaById.has(own)
      ? own
      : (entry.node.id != null && domIdToId.has(String(entry.node.id)) ? domIdToId.get(String(entry.node.id)) : own);
    tableFactsByAnchor.set(resolved, facts);
  }
  let truncated = false;
  const groupFor = (kind, groupKind, anchorId, meta) => {
    const key = kind + ':' + anchorId;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: 'ctx:' + kind + ':' + sanitize(anchorId),
        key,
        kind,
        groupKind,
        anchorId,
        role: meta ? meta.role || null : null,
        tag: meta ? meta.tag || null : null,
        domId: meta ? meta.domId || null : null,
        name: meta ? meta.name || null : null,
        memberIds: [],
        members: 0,
        tokens: 0,
        roles: {},
        parentId: null,
        childIds: [],
        depth: 0,
        frameId: frameIdOfContextNode(anchorId),
      };
      if (groups.size < maxGroups) groups.set(key, group);
      else truncated = true;
    }
    return group;
  };
  const attach = (group, entry) => {
    if (!group || group.memberIds.length >= CONTEXT_LIMITS.members) return;
    if (group.memberIds.includes(String(entry.id))) return;
    group.memberIds.push(String(entry.id));
    group.members = group.memberIds.length;
    group.tokens += tokenCost(entry.node);
    const role = lower(entry.node && entry.node.role) || 'generic';
    group.roles[role] = (group.roles[role] || 0) + 1;
  };

  for (const entry of entries) {
    const chain = [];
    if (Array.isArray(entry.ancestorIds) && entry.ancestorIds.length) {
      for (const id of entry.ancestorIds) chain.push(String(id));
    } else {
      const ancestors = Array.isArray(entry.node && entry.node.ancestors) ? entry.node.ancestors : [];
      for (const ancestor of ancestors) {
        const id = resolveAncestorId(ancestor);
        if (id) chain.push(id);
      }
    }
    if (chain.length > maxDepth) chain.length = maxDepth;
    // 节点自身也可能是锚点（例如被观察到的 table/dialog 容器）。
    const candidates = [];
    const graphMeta = metaById.get(String(entry.id)) || null;
    const ownMeta = {
      id: String(entry.id),
      role: lower(entry.node && entry.node.role) || (graphMeta ? graphMeta.role : ''),
      tag: lower(entry.node && entry.node.tag) || (graphMeta ? graphMeta.tag : ''),
      domId: (entry.node && entry.node.id ? String(entry.node.id) : null) || (graphMeta ? graphMeta.domId : null),
      name: (entry.node && entry.node.name ? String(entry.node.name) : null) || (graphMeta ? graphMeta.name : null),
    };
    if (!metaById.has(String(entry.id))) metaById.set(String(entry.id), ownMeta);
    candidates.push({ id: String(entry.id), meta: ownMeta });
    for (const id of chain) candidates.push({ id, meta: metaById.get(id) || { id } });
    const nodeGroups = [];
    for (const candidate of candidates) {
      const classified = classifyContextAnchor(candidate.meta);
      if (!classified) continue;
      if (nodeGroups.some((item) => item.kind === classified.kind)) continue;
      const group = groupFor(classified.kind, classified.groupKind, candidate.id, candidate.meta);
      attach(group, entry);
      nodeGroups.push({ kind: classified.kind, group, anchorId: candidate.id });
    }
    // 近 → 远（table > form > landmark）生成上下文链。
    nodeGroups.sort((a, b) => (KIND_RANK[b.kind] ?? -1) - (KIND_RANK[a.kind] ?? -1));
    for (let index = 0; index < nodeGroups.length; index += 1) {
      const current = nodeGroups[index].group;
      const outer = nodeGroups.slice(index + 1).find((item) => (KIND_RANK[item.kind] ?? 9) < (KIND_RANK[nodeGroups[index].kind] ?? 9));
      if (!outer) continue;
      if (!current.parentId) {
        current.parentId = outer.group.id;
        if (!outer.group.childIds.includes(current.id)) outer.group.childIds.push(current.id);
      }
    }
    if (contextByNode.size < maxContexts) {
      contextByNode.set(String(entry.id), {
        node: String(entry.id),
        chain: nodeGroups.map((item) => item.group.id),
        kinds: nodeGroups.map((item) => item.kind),
        anchorIds: nodeGroups.map((item) => item.anchorId),
        frameId: frameIdOfContextNode(String(entry.id)),
      });
    } else {
      truncated = true;
    }
  }

  // 组深度：沿 parentId 向上数（有环保护）。
  const groupsById = new Map([...groups.values()].map((group) => [group.id, group]));
  for (const group of groups.values()) {
    let depth = 0;
    let current = group;
    const seen = new Set([group.id]);
    while (current && current.parentId && depth < maxDepth) {
      const parent = groupsById.get(current.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
      depth += 1;
    }
    group.depth = depth;
  }

  // 表格结构事实：表头单元格、行数、题注（都从页面图/入口事实推导，不重新遍历 DOM）。
  const isDescendantOf = (nodeId, anchorId) => {
    let current = nodeById.get(String(nodeId));
    let guard = 0;
    while (current && guard < maxDepth + 2) {
      const parentId = current.parentId != null ? current.parentId : parentAdjacency.get(String(current.id));
      if (parentId == null) return false;
      if (String(parentId) === String(anchorId)) return true;
      current = nodeById.get(String(parentId));
      guard += 1;
    }
    return false;
  };
  for (const group of groups.values()) {
    if (group.kind !== 'table') continue;
    const pageFacts = tableFactsByAnchor.get(group.anchorId) || null;
    if (pageFacts) {
      const headers = (Array.isArray(pageFacts.headers) ? pageFacts.headers : [])
        .slice(0, maxHeaders)
        .map((header) => ({
          id: header && header.id ? String(header.id) : null,
          role: (header && lower(header.role)) || 'columnheader',
          name: String((header && header.name) || '').slice(0, 80),
        }))
        .filter((header) => header.name);
      group.table = {
        headers,
        headerCount: headers.length,
        rowCount: Number(pageFacts.dataRows) || 0,
        caption: pageFacts.caption ? String(pageFacts.caption).slice(0, 120) : null,
        hasHeaderRow: headers.length > 0,
        source: 'page-facts',
      };
      continue;
    }
    const headers = [];
    let rows = 0;
    let caption = null;
    for (const node of nodeById.values()) {
      const role = lower(node.role);
      const tag = lower(node.tag);
      if (!isDescendantOf(node.id, group.anchorId)) continue;
      if (role === 'caption' || tag === 'caption') {
        if (caption == null && (node.name || node.domId)) caption = String(node.name || node.domId);
        continue;
      }
      if (TABLE_HEADER_ROLES.includes(role) || tag === 'th') {
        const label = node.name ? String(node.name) : (node.domId ? '#' + node.domId : String(node.id));
        if (headers.length < maxHeaders) headers.push({ id: String(node.id), role: role || 'columnheader', name: label.slice(0, 80) });
      } else if (role === 'row' || tag === 'tr') {
        rows += 1;
      }
    }
    group.table = {
      headers,
      headerCount: headers.length,
      rowCount: rows,
      caption: caption ? caption.slice(0, 120) : null,
      hasHeaderRow: headers.length > 0,
    };
  }

  const groupList = [...groups.values()];
  const roots = groupList.filter((group) => !group.parentId).map((group) => group.id);
  const byKind = {};
  const byGroupKind = {};
  for (const group of groupList) {
    byKind[group.kind] = (byKind[group.kind] || 0) + 1;
    byGroupKind[group.groupKind] = (byGroupKind[group.groupKind] || 0) + 1;
  }
  const frames = [];
  if (Array.isArray(input.frames)) {
    for (const frame of input.frames) {
      if (!frame || !Number.isInteger(Number(frame.frameId))) continue;
      const frameId = Number(frame.frameId);
      const members = groupList.filter((group) => group.frameId === frameId).map((group) => group.id);
      frames.push({
        frameId,
        url: frame.url != null ? String(frame.url).slice(0, 300) : null,
        parentFrameId: Number.isInteger(frame.parentFrameId) ? frame.parentFrameId : null,
        groups: members.length,
        groupIds: members,
        nodes: [...contextByNode.values()].filter((item) => item.frameId === frameId).length,
      });
    }
  }
  const contexts = [...contextByNode.values()];
  return {
    version: VOM_CONTEXT_VERSION,
    groups: groupList,
    roots,
    contexts,
    frames,
    stats: {
      groups: groupList.length,
      contexts: contexts.length,
      byKind,
      byGroupKind,
      landmarks: byKind.landmark || 0,
      forms: byKind.form || 0,
      tables: byKind.table || 0,
      parented: groupList.filter((group) => group.parentId != null).length,
      depth: groupList.reduce((max, group) => Math.max(max, group.depth), 0),
      framed: contexts.filter((context) => context.frameId != null).length,
      tableHeaders: groupList.reduce((sum, group) => sum + (group.table ? group.table.headerCount : 0), 0),
      truncated,
    },
  };
}
