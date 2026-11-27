// packages/vom/src/relations.ts —— 语义关系图 v3（relations + confidence + source + group/context）。
//
// 源：extension/src/lib/vom-relations.js（行为逐字段等价的基线，差分测试对拍）。
//
// 组图（lib/vom-semantic.js）是 v2，保持既有字段/版本兼容；本模块在它之上补“关系层”：
//   - 关系类型（RELATION_KINDS）：contains / labels / controls / owns / describes / invalidates；
//     RELATION_TYPES 保留 v3 基线五种（既有导出契约），invalidates 是扩展的第六种；
//   - labels：aria-labelledby（含跨元素链，链上每一跳单独成边并降置信度）、<label for>、
//     隐式包裹 label；
//   - controls：aria-controls，以及 role=tab 的 tab-controls；
//   - owns：aria-owns / form 锚点 / 组合控件（listbox→option、menu→menuitem、tree→treeitem 等）；
//   - describes：aria-describedby 与 alt/title 的“自描述”证据；
//   - invalidates：aria-errormessage、invalid 控件 + describedby 错误文案、无目标时 aria-invalid
//     自身的 invalid-flag 自关系。
//
// 每条关系带 confidence（0..1）与 source（哪条证据产生），同一条关系多来源时合并取最大置信度。
// 每组给出 context（父组、祖先上下文链、深度），contexts 数组给出“父组包含子组”的关系。
// 跨 frame 时把 frames 交给 src/frame-relations.ts，frame 节点作为关系端点参与 contains/owns。
//
// 输入全部是观测已产生的事实（payload entries + 页面图 edges + 语义组图），不读 DOM。

import { buildCrossFrameRelations } from './frame-relations.ts';
import type { FrameRelationsReport } from './relation-types.ts';
import type {
  BuildVomRelationGraphInput,
  GraphEdgeType,
  LabelChainHop,
  LabelledByChainHopFact,
  NodeRelationView,
  RelationAncestorFact,
  RelationExtra,
  RelationKind,
  RelationNodeFacts,
  RelationSource,
  RelationType,
  SemanticGroupEdgeFacts,
  SemanticGroupNodeFacts,
  SemanticGraphFacts,
  SelfRelationKind,
  VomEntryInput,
  VomGraphEdgeFacts,
  VomGraphFacts,
  VomGraphNodeFacts,
  VomGroupContextRelation,
  VomRelationGroup,
  VomRelationGraph,
  VomRelationRecord,
  VomRelationsStats,
} from './relation-types.ts';

/** 语义关系图版本。 */
export const VOM_RELATIONS_VERSION = 3;

/** v3 基线关系类型（既有导出，保持五元组不变）。 */
export const RELATION_TYPES: readonly RelationType[] = Object.freeze([
  'contains', 'labels', 'controls', 'owns', 'describes',
]);

/** 扩展新增的关系类型：错误/校验消息使控件处于 invalid 状态。 */
export const RELATION_INVALIDATES = 'invalidates' as const;

/** 关系图实际支持的全部类型（v3 基线 + invalidates）。 */
export const RELATION_KINDS: readonly RelationKind[] = Object.freeze([
  ...RELATION_TYPES,
  RELATION_INVALIDATES,
]);

/** 允许“节点指向自己”的关系类型：描述与 invalid 状态是节点自身的属性。 */
export const SELF_RELATION_TYPES: readonly SelfRelationKind[] = Object.freeze(['describes', 'invalidates']);

/** 关系来源 → 置信度。页面显式 ARIA 关系最可信，DOM 父子/组图推导次之。 */
export const RELATION_CONFIDENCE: Readonly<Record<RelationSource, number>> = Object.freeze({
  'aria-controls': 0.95,
  'aria-labelledby': 0.95,
  'aria-labelledby-chain': 0.9,
  'aria-describedby': 0.9,
  'aria-owns': 0.9,
  'aria-errormessage': 0.95,
  'label-for': 0.9,
  'html-for': 0.92,
  'tab-controls': 0.96,
  'form-anchor': 0.85,
  'invalid-describedby': 0.85,
  'invalid-flag': 0.8,
  'composite-owner': 0.8,
  'semantic-group': 0.8,
  'alt-text': 0.78,
  'node-relations': 0.75,
  'graph-edge': 0.7,
  'dom-parent': 0.65,
  'title-attribute': 0.6,
  'frame-edge': 0.95,
  'frame-owner': 0.9,
  'parent-frame': 0.9,
});

/** 页面图 edge.type → 关系类型。unknown 的边（frame 等）不进入关系图。 */
export const GRAPH_EDGE_RELATION: Readonly<Record<GraphEdgeType, RelationKind>> = Object.freeze({
  controls: 'controls',
  'tab-controls': 'controls',
  label: 'labels',
  'html-for': 'labels',
  labelledby: 'labels',
  describedby: 'describes',
  owns: 'owns',
  form: 'owns',
  child: 'contains',
  errormessage: 'invalidates',
  frame: 'contains',
});

/** 页面图 edge.type → 关系来源（比 type 更具体，决定置信度）。 */
export const EDGE_SOURCE: Readonly<Record<GraphEdgeType, RelationSource>> = Object.freeze({
  child: 'dom-parent',
  label: 'label-for',
  'html-for': 'html-for',
  labelledby: 'aria-labelledby',
  describedby: 'aria-describedby',
  controls: 'aria-controls',
  'tab-controls': 'tab-controls',
  owns: 'aria-owns',
  form: 'form-anchor',
  errormessage: 'aria-errormessage',
  frame: 'frame-edge',
});

/** 组合控件角色：它们通过 owns 关系把子项纳入自己的交互模型。 */
export const COMPOSITE_ROLES: readonly string[] = Object.freeze([
  'combobox', 'listbox', 'menu', 'menubar', 'radiogroup', 'tree', 'grid', 'treegrid', 'tablist', 'toolbar',
]);

/** 组合控件的被拥有子项角色。 */
export const COMPOSITE_OWNED_ROLES: readonly string[] = Object.freeze([
  'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'radio', 'row',
  'rowgroup', 'tab', 'gridcell', 'columnheader', 'rowheader', 'listitem',
]);

/** 关系图各项上限（与 JS 基线一致）。 */
export const RELATION_LIMITS: Readonly<{
  relations: number;
  groups: number;
  contexts: number;
  contains: number;
  chainDepth: number;
  chainedLabels: number;
  compositeOwns: number;
  descriptions: number;
  invalidates: number;
  frames: number;
}> = Object.freeze({
  relations: 600,
  groups: 200,
  contexts: 200,
  contains: 180,
  chainDepth: 3,
  chainedLabels: 160,
  compositeOwns: 160,
  descriptions: 160,
  invalidates: 120,
  frames: 16,
});

const LIMITS = RELATION_LIMITS;

/** 上限归一：非有限/非正回落到 fallback，向下取整后夹到 max。 */
function limitOf(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

/** 置信度归一：非有限为 0，夹到 [0,1] 并保留两位小数。 */
function confidenceOf(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, Math.round(number * 100) / 100));
}

/** 关系三元组主键（\u0000 分隔，避免 id 里含分隔符时串键）。 */
function relationKey(type: string, from: string, to: string): string {
  return type + '\u0000' + from + '\u0000' + to;
}

/** 节点 id 归一：null/undefined → null，空串 → null。 */
function nodeIdOf(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  return text ? text : null;
}

/** 数组/单值归一成去空白字符串列表（跳过空项）。 */
function asList(value: unknown): string[] {
  if (value == null) return [];
  const array: readonly unknown[] = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of array) {
    const text = String(item == null ? '' : item).trim();
    if (text) out.push(text);
  }
  return out;
}

/** 小写归一（null/undefined → ''）。 */
function lower(value: unknown): string {
  return String(value == null ? '' : value).toLowerCase();
}

/** 数组归一（只接受真数组，其它返回空）。 */
function arrayOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

/** 关系类型是否允许自指。 */
function isSelfRelationType(type: RelationKind): type is SelfRelationKind {
  return type === 'describes' || type === 'invalidates';
}

/** 对象归一：非对象（含数组）返回 null。 */
function objectOf<T>(value: unknown): T | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
}

/**
 * 构建语义关系图 v3。
 * 处理顺序（与 JS 基线一致，保证同输入同插入顺序）：
 * 1) 页面图边 → 关系；2) 组合控件 owns 推导；3) entry 自身 ARIA 关系（含 labelledby 链、
 * invalidates）；4) alt/title 描述证据；5) 语义组图 contains；6) 跨 frame 关系合并；
 * 7) 组上下文扩展 + 统计。
 */
export function buildVomRelationGraph(input: BuildVomRelationGraphInput = {}): VomRelationGraph {
  const entries = Array.isArray(input.entries)
    ? (input.entries as readonly VomEntryInput[]).filter((entry) => entry && entry.id)
    : [];
  const graph = objectOf<VomGraphFacts>(input.graph);
  const semantic = objectOf<SemanticGraphFacts>(input.semantic);
  const maxRelations = limitOf(input.limits && input.limits.relations, LIMITS.relations, 5000);
  const maxGroups = limitOf(input.limits && input.limits.groups, LIMITS.groups, 1000);
  const maxContexts = limitOf(input.limits && input.limits.contexts, LIMITS.contexts, 1000);
  const maxChainDepth = limitOf(input.limits && input.limits.chainDepth, LIMITS.chainDepth, 6);

  const entryById = new Map<string, VomEntryInput>();
  const domIdToId = new Map<string, string>();
  const graphNodeById = new Map<string, VomGraphNodeFacts>();
  for (const entry of entries) {
    entryById.set(String(entry.id), entry);
    const domId = entry.node && entry.node.id != null ? String(entry.node.id) : '';
    if (domId) domIdToId.set(domId, String(entry.id));
  }
  const graphIds = new Set<string>();
  if (graph && Array.isArray(graph.nodes)) {
    for (const node of arrayOf<VomGraphNodeFacts>(graph.nodes)) {
      if (!node || node.id == null) continue;
      graphIds.add(String(node.id));
      graphNodeById.set(String(node.id), node);
      if (node.domId) domIdToId.set(String(node.domId), String(node.id));
    }
  }

  // 跨 frame 关系先构建：frame 节点本身也是关系图端点。
  let frameReport: FrameRelationsReport | null = null;
  const frameNodeIds = new Set<string>();
  if (input.frames) {
    frameReport = buildCrossFrameRelations(input.frames as never, { limits: { frames: LIMITS.frames } });
    for (const frameNode of frameReport.frames) frameNodeIds.add(String(frameNode.id));
  }
  const knownNode = (id: unknown): boolean => Boolean(id)
    && (entryById.has(String(id)) || graphIds.has(String(id)) || frameNodeIds.has(String(id)));

  const roleOf = (id: unknown): string => {
    const text = String(id);
    const entry = entryById.get(text);
    const graphNode = graphNodeById.get(text);
    const role = (entry && entry.node && entry.node.role) || (graphNode && graphNode.role) || '';
    return lower(role);
  };
  const nameOf = (id: unknown): string => {
    const text = String(id);
    const entry = entryById.get(text);
    if (entry && entry.node && entry.node.name) return String(entry.node.name).slice(0, 160);
    const graphNode = graphNodeById.get(text);
    if (graphNode && graphNode.name) return String(graphNode.name).slice(0, 160);
    return '';
  };
  const textEvidenceOf = (id: unknown): { text: string; via: string } => {
    const entry = entryById.get(String(id));
    const node: RelationNodeFacts = entry && entry.node ? entry.node : {};
    if (node.name) return { text: String(node.name).slice(0, 160), via: 'name' };
    if (node.alt) return { text: String(node.alt).slice(0, 160), via: 'alt' };
    if (node.title) return { text: String(node.title).slice(0, 160), via: 'title' };
    return { text: nameOf(id), via: 'graph' };
  };

  // 父子索引：child 边 + 图节点 parentId + entry.ancestorIds，供 describes(alt)/frames 使用。
  const parentOf = new Map<string, string[]>();
  const pushParent = (child: unknown, parent: unknown): void => {
    const key = String(child);
    const bucket = parentOf.get(key) || [];
    if (parent != null && !bucket.includes(String(parent))) bucket.push(String(parent));
    parentOf.set(key, bucket);
  };
  const labelledByAdj = new Map<string, string[]>();
  const pushAdj = (from: unknown, to: unknown): void => {
    const key = String(from);
    const bucket = labelledByAdj.get(key) || [];
    if (!bucket.includes(String(to))) bucket.push(String(to));
    labelledByAdj.set(key, bucket);
  };
  if (graph && Array.isArray(graph.edges)) {
    for (const edge of arrayOf<VomGraphEdgeFacts>(graph.edges)) {
      if (!edge || edge.from == null || edge.to == null) continue;
      if (edge.type === 'child') pushParent(edge.to, edge.from);
      // 页面图的 labelledby 边是“目标标签 → 元素”（与关系方向一致），链邻接表却要“元素 → 它的标签”。
      if (edge.type === 'labelledby') pushAdj(edge.to, edge.from);
    }
    for (const node of graphNodeById.values()) {
      if (node && node.parentId != null) pushParent(node.id, node.parentId);
    }
  }
  for (const entry of entries) {
    if (Array.isArray(entry.ancestorIds)) {
      for (const ancestorId of (entry.ancestorIds as readonly unknown[]).slice(0, 4)) pushParent(entry.id, ancestorId);
    }
    const node: RelationNodeFacts = entry.node || {};
    if (Array.isArray(node.ancestors)) {
      for (const ancestor of arrayOf<RelationAncestorFact>(node.ancestors)) {
        const resolved = ancestor && ancestor.id != null ? domIdToId.get(String(ancestor.id)) : null;
        if (resolved) pushParent(entry.id, resolved);
      }
    }
  }

  const relations: VomRelationRecord[] = [];
  const index = new Map<string, VomRelationRecord>();
  const add = (
    type: RelationKind,
    from: unknown,
    to: unknown,
    source: RelationSource,
    confidence: unknown,
    extra: RelationExtra = {},
  ): VomRelationRecord | null => {
    if (!RELATION_KINDS.includes(type)) return null;
    const left = nodeIdOf(from);
    const right = nodeIdOf(to);
    if (!left || !right) return null;
    const self = left === right;
    if (self && !(isSelfRelationType(type) && extra && extra.self === true)) return null;
    const key = relationKey(type, left, right);
    if (relations.length >= maxRelations && !index.has(key)) return null;
    const existing = index.get(key);
    const value = confidenceOf(confidence);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (value > existing.confidence) {
        existing.confidence = value;
        existing.source = source;
      }
      if (extra && typeof extra === 'object') {
        for (const [field, fieldValue] of Object.entries(extra)) {
          if (field === 'source' || field === 'sources' || field === 'confidence') continue;
          if (existing[field] == null || field === 'depth') existing[field] = fieldValue;
        }
      }
      return existing;
    }
    const relation: VomRelationRecord = {
      type,
      from: left,
      to: right,
      confidence: value,
      source,
      sources: [source],
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
    index.set(key, relation);
    relations.push(relation);
    return relation;
  };

  // 1) 页面图边 → 关系（显式 ARIA 关系 + DOM 包含）。
  let containsFromGraph = 0;
  if (graph && Array.isArray(graph.edges)) {
    for (const edge of arrayOf<VomGraphEdgeFacts>(graph.edges)) {
      if (!edge || !edge.type) continue;
      const edgeType = String(edge.type) as GraphEdgeType;
      const type = GRAPH_EDGE_RELATION[edgeType];
      if (!type) continue;
      if (edgeType === 'frame' && !frameReport) continue;
      if (!knownNode(edge.from) || !knownNode(edge.to)) continue;
      if (type === 'contains' && containsFromGraph >= LIMITS.contains) continue;
      const source = EDGE_SOURCE[edgeType] || 'graph-edge';
      // 页面图边已经按关系方向记录（标签 → 元素 / 错误消息 → 控件），这里直接映射。
      const relation = add(
        type,
        edge.from,
        edge.to,
        source,
        RELATION_CONFIDENCE[source] || RELATION_CONFIDENCE['graph-edge'],
        type === 'invalidates'
          ? { text: textEvidenceOf(edge.from).text, via: 'aria-errormessage' }
          : {},
      );
      if (relation && type === 'contains') containsFromGraph += 1;
    }
  }

  // 2) 组合控件 owns 推导：父角色是组合控件、子角色是被拥有项时补 composite-owner 边。
  let compositeOwns = 0;
  if (graph && Array.isArray(graph.edges)) {
    for (const edge of arrayOf<VomGraphEdgeFacts>(graph.edges)) {
      if (!edge || edge.type !== 'child') continue;
      if (compositeOwns >= LIMITS.compositeOwns) break;
      if (!knownNode(edge.from) || !knownNode(edge.to)) continue;
      const parentRole = roleOf(edge.from);
      const childRole = roleOf(edge.to);
      if (!COMPOSITE_ROLES.includes(parentRole) || !COMPOSITE_OWNED_ROLES.includes(childRole)) continue;
      if (add('owns', edge.from, edge.to, 'composite-owner', RELATION_CONFIDENCE['composite-owner'], { composite: parentRole })) {
        compositeOwns += 1;
      }
    }
  }

  // 3) entry 自身的 ARIA 关系（值是 DOM id/名字，用 domId→id 解析成节点 id）。
  // 先补 labelledby 邻接表（entry 侧的 aria-labelledby 也能构成链）。
  for (const entry of entries) {
    const relationsOfNode = objectOf<NonNullable<VomEntryInput['relations']>>(entry.relations);
    if (!relationsOfNode) continue;
    for (const target of asList(relationsOfNode.labelledBy)) {
      const resolved = domIdToId.get(target);
      if (resolved) pushAdj(entry.id, resolved);
    }
  }
  let chainedLabels = 0;
  let invalidates = 0;
  for (const entry of entries) {
    const relationsOfNode = objectOf<NonNullable<VomEntryInput['relations']>>(entry.relations);
    if (!relationsOfNode) continue;
    const resolve = (value: unknown): string | null => domIdToId.get(String(value)) || null;
    const entryRole = roleOf(entry.id);
    const directLabelled: string[] = [];
    const describedFroms: string[] = [];
    const errorFroms: string[] = [];
    for (const target of asList(relationsOfNode.controls)) {
      const to = resolve(target);
      if (!to) continue;
      add('controls', entry.id, to, 'aria-controls', RELATION_CONFIDENCE['aria-controls']);
      if (entryRole === 'tab') add('controls', entry.id, to, 'tab-controls', RELATION_CONFIDENCE['tab-controls']);
    }
    for (const target of asList(relationsOfNode.labelledBy)) {
      const from = resolve(target);
      if (!from) continue;
      directLabelled.push(from);
      add('labels', from, entry.id, 'aria-labelledby', RELATION_CONFIDENCE['aria-labelledby']);
    }
    for (const target of asList(relationsOfNode.describedBy)) {
      const from = resolve(target);
      if (!from) continue;
      describedFroms.push(from);
      const evidence = textEvidenceOf(from);
      add('describes', from, entry.id, 'aria-describedby', RELATION_CONFIDENCE['aria-describedby'], {
        text: evidence.text || null,
        via: evidence.via,
      });
    }
    for (const target of asList(relationsOfNode.labelIds)) {
      const from = resolve(target);
      if (!from) continue;
      // labelIds 只是 `<label>` 关联（显式/隐式未区分），显式 html-for 由页面图边给出更高置信度。
      add('labels', from, entry.id, 'label-for', RELATION_CONFIDENCE['label-for'], { via: 'labelIds' });
    }
    for (const target of asList(relationsOfNode.owns)) {
      const to = resolve(target);
      if (to) add('owns', entry.id, to, 'aria-owns', RELATION_CONFIDENCE['aria-owns']);
    }
    for (const target of asList(relationsOfNode.form)) {
      const from = resolve(target);
      if (from) add('owns', from, entry.id, 'form-anchor', RELATION_CONFIDENCE['form-anchor']);
    }
    for (const target of asList(relationsOfNode.errorMessage)) {
      const from = resolve(target);
      if (!from) continue;
      errorFroms.push(from);
      const relation = add('invalidates', from, entry.id, 'aria-errormessage', RELATION_CONFIDENCE['aria-errormessage'], {
        text: textEvidenceOf(from).text || null,
        via: 'aria-errormessage',
      });
      if (relation) invalidates += 1;
    }
    // labelledby 链：页面侧已展开的 chain 事实优先；否则用图/entry 邻接表推导。
    const chainHops = Array.isArray(entry.node && entry.node.labelledByChain)
      ? arrayOf<LabelledByChainHopFact>(entry.node && entry.node.labelledByChain)
      : [];
    if (chainHops.length) {
      for (const hop of chainHops) {
        if (chainedLabels >= LIMITS.chainedLabels) break;
        const to = hop && hop.id != null ? resolve(hop.id) : null;
        if (!to || to === String(entry.id)) continue;
        const depth = Math.max(1, Math.floor(Number(hop.depth) || 1));
        if (depth <= 1) continue;
        const confidence = Math.max(0.5, RELATION_CONFIDENCE['aria-labelledby-chain'] - 0.05 * (depth - 2));
        const rawChain: readonly unknown[] = Array.isArray(hop.chain)
          ? hop.chain
          : (hop.from ? [String(hop.from), String(hop.id)] : [String(hop.id)]);
        // chain 里的 DOM id 尽量解析成关系图节点 id，便于调用方直接遍历。
        const chain = rawChain.map((item) => domIdToId.get(String(item)) || String(item));
        const relation = add('labels', to, entry.id, 'aria-labelledby-chain', confidence, {
          depth,
          chain,
          via: hop.from != null ? String(hop.from) : null,
        });
        if (relation) chainedLabels += 1;
      }
    } else {
      for (const start of directLabelled) {
        let frontier = [start];
        const seen = new Set<string>([start, String(entry.id)]);
        for (let depth = 2; depth <= maxChainDepth + 1; depth += 1) {
          const next: string[] = [];
          for (const id of frontier) {
            for (const target of labelledByAdj.get(id) || []) {
              if (seen.has(target)) continue;
              seen.add(target);
              next.push(target);
            }
          }
          if (!next.length) break;
          for (const target of next) {
            if (chainedLabels >= LIMITS.chainedLabels) break;
            const confidence = Math.max(0.5, RELATION_CONFIDENCE['aria-labelledby-chain'] - 0.05 * (depth - 2));
            const relation = add('labels', target, entry.id, 'aria-labelledby-chain', confidence, {
              depth,
              chain: [...directLabelled, target],
            });
            if (relation) chainedLabels += 1;
          }
          frontier = next;
        }
      }
    }
    // invalidates：invalid 控件 + describedby 错误文案；没有任何目标时退化为自身状态关系。
    if (entry.node && entry.node.invalid === true) {
      const targets = [...new Set([...errorFroms, ...describedFroms])].filter((id) => id !== String(entry.id));
      if (targets.length) {
        for (const from of targets) {
          if (invalidates >= LIMITS.invalidates) break;
          const relation = add('invalidates', from, entry.id, 'invalid-describedby', RELATION_CONFIDENCE['invalid-describedby'], {
            text: textEvidenceOf(from).text || null,
            role: roleOf(from) || null,
            state: 'invalid',
          });
          if (relation) invalidates += 1;
        }
      } else if (invalidates < LIMITS.invalidates) {
        const relation = add('invalidates', entry.id, entry.id, 'invalid-flag', RELATION_CONFIDENCE['invalid-flag'], {
          self: true,
          state: 'invalid',
        });
        if (relation) invalidates += 1;
      }
    }
    // 组合控件 owns：entry 自身是被拥有子项且祖先是组合控件时（页面图没建子边的兜底）。
    if (compositeOwns < LIMITS.compositeOwns && COMPOSITE_OWNED_ROLES.includes(entryRole)) {
      const ancestors = Array.isArray(entry.node && entry.node.ancestors)
        ? arrayOf<RelationAncestorFact>(entry.node && entry.node.ancestors)
        : [];
      for (const ancestor of ancestors.slice(0, 4)) {
        const parentRole = lower(ancestor && ancestor.role);
        if (!COMPOSITE_ROLES.includes(parentRole)) continue;
        const parentId = ancestor.id != null ? domIdToId.get(String(ancestor.id)) : null;
        if (!parentId) continue;
        if (add('owns', parentId, entry.id, 'composite-owner', RELATION_CONFIDENCE['composite-owner'], { composite: parentRole })) {
          compositeOwns += 1;
        }
        break;
      }
    }
  }

  // 4) describes：alt/title 的描述证据（self=节点自身描述；img alt 命名外部控件时连到控件）。
  let selfDescriptions = 0;
  for (const entry of entries) {
    if (selfDescriptions >= LIMITS.descriptions) break;
    const node: RelationNodeFacts = entry.node || {};
    const title = String(node.title || '').trim();
    const alt = String(node.alt || '').trim();
    const tag = lower(node.tag);
    const role = lower(node.role);
    if (title && selfDescriptions < LIMITS.descriptions) {
      const relation = add('describes', entry.id, entry.id, 'title-attribute', RELATION_CONFIDENCE['title-attribute'], {
        self: true,
        text: title.slice(0, 160),
        via: 'title',
      });
      if (relation) selfDescriptions += 1;
    }
    if (alt && (tag === 'img' || role === 'img') && selfDescriptions < LIMITS.descriptions) {
      const parents = parentOf.get(String(entry.id)) || [];
      let linked = false;
      for (const parent of parents) {
        const parentRole = roleOf(parent);
        if (parentRole !== 'link' && parentRole !== 'button') continue;
        const parentName = nameOf(parent);
        if (!parentName) continue;
        if (parentName === alt || parentName.toLowerCase().includes(alt.toLowerCase())) {
          add('describes', entry.id, parent, 'alt-text', RELATION_CONFIDENCE['alt-text'], {
            text: alt.slice(0, 160),
            via: 'alt',
          });
          linked = true;
          break;
        }
      }
      if (!linked) {
        const relation = add('describes', entry.id, entry.id, 'alt-text', 0.7, {
          self: true,
          text: alt.slice(0, 160),
          via: 'alt',
        });
        if (relation) selfDescriptions += 1;
      }
    }
  }

  // 5) 语义组图的 contains 边 → 组级关系（来源 semantic-group）。
  const groupById = new Map<string, SemanticGroupNodeFacts>();
  if (semantic && Array.isArray(semantic.nodes)) {
    for (const group of arrayOf<SemanticGroupNodeFacts>(semantic.nodes)) {
      if (!group || group.id == null) continue;
      groupById.set(String(group.id), group);
    }
    if (Array.isArray(semantic.edges)) {
      for (const edge of arrayOf<SemanticGroupEdgeFacts>(semantic.edges)) {
        if (!edge || edge.type !== 'contains') continue;
        add('contains', edge.from, edge.to, 'semantic-group', RELATION_CONFIDENCE['semantic-group'], {
          fromKind: edge.fromKind || null,
          toKind: edge.toKind || null,
        });
      }
    }
  }

  // 6) 跨 frame 关系合并（frame 作为节点参与关系）。frame 子图已由 frame-relations 校验过端点。
  if (frameReport) {
    for (const relation of frameReport.relations) {
      // 与 JS 的 `{...rest}` 解构等价：除主键（type/from/to/confidence/source/sources）外全部透传。
      const extra: RelationExtra = {};
      for (const [key, value] of Object.entries(relation)) {
        if (key === 'type' || key === 'from' || key === 'to'
          || key === 'confidence' || key === 'source' || key === 'sources') continue;
        extra[key] = value;
      }
      add(relation.type, relation.from, relation.to, relation.source, relation.confidence, { ...extra, frame: true });
    }
  }

  // 端点角色补充到关系记录上：查询/摘要不用再回表。
  for (const relation of relations) {
    relation.fromRole = roleOf(relation.from) || null;
    relation.toRole = roleOf(relation.to) || null;
  }

  // 7) 组 + 上下文扩展：父组、上下文链、深度。
  const parentOfGroup = new Map<string, string>();
  for (const relation of relations) {
    if (relation.type !== 'contains') continue;
    if (!groupById.has(relation.from) || !groupById.has(relation.to)) continue;
    if (!parentOfGroup.has(relation.to)) parentOfGroup.set(relation.to, relation.from);
  }
  const groups: VomRelationGroup[] = [];
  const orderedGroups = [...groupById.values()].slice(0, maxGroups);
  for (const group of orderedGroups) {
    const id = String(group.id);
    const chain: string[] = [];
    let parent: string | null = parentOfGroup.get(id) || null;
    let guard = 0;
    while (parent && guard < 8) {
      chain.push(parent);
      parent = parentOfGroup.get(parent) || null;
      guard += 1;
    }
    const head = chain[0] ?? null;
    const parentGroup = head ? groupById.get(head) : null;
    groups.push({
      id,
      kind: group.groupKind || null,
      members: Number(group.members) || 0,
      tokens: Number(group.tokens) || 0,
      score: Number(group.score) || 0,
      context: {
        parent: head,
        parentKind: parentGroup ? parentGroup.groupKind || null : null,
        depth: chain.length,
        chain,
      },
    });
  }
  const contexts: VomGroupContextRelation[] = [];
  for (const relation of relations) {
    if (contexts.length >= maxContexts) break;
    if (relation.type !== 'contains') continue;
    if (!groupById.has(relation.from) || !groupById.has(relation.to)) continue;
    const parentGroup = groupById.get(relation.from);
    const childGroup = groupById.get(relation.to);
    contexts.push({
      id: relation.from + '>' + relation.to,
      parent: relation.from,
      child: relation.to,
      parentKind: (parentGroup && parentGroup.groupKind) || null,
      childKind: (childGroup && childGroup.groupKind) || null,
      confidence: relation.confidence,
      source: relation.source,
    });
  }

  const byType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let confidenceSum = 0;
  let selfRelations = 0;
  for (const relation of relations) {
    byType[relation.type] = (byType[relation.type] || 0) + 1;
    for (const source of relation.sources) bySource[source] = (bySource[source] || 0) + 1;
    confidenceSum += relation.confidence;
    if (relation.self === true) selfRelations += 1;
  }
  const lowConfidence = relations.filter((relation) => relation.confidence < 0.75).length;
  const stats: VomRelationsStats = {
    relations: relations.length,
    nodes: entryById.size,
    byType,
    bySource,
    lowConfidence,
    averageConfidence: relations.length ? Math.round((confidenceSum / relations.length) * 1000) / 1000 : 0,
    groups: groups.length,
    contextGroups: groups.filter((group) => group.context.parent != null).length,
    contexts: contexts.length,
    truncated: relations.length >= maxRelations || orderedGroups.length >= maxGroups,
    selfRelations,
    selfDescriptions,
    chainedLabels,
    invalidates,
    compositeOwns,
    frameRelations: frameReport ? frameReport.relations.length : 0,
  };
  return {
    version: VOM_RELATIONS_VERSION,
    // relationTypes 是 v3 既有导出契约（五元组，消费方按它做枚举）；kinds 含 invalidates。
    relationTypes: RELATION_TYPES.slice(),
    kinds: RELATION_KINDS.slice(),
    relations,
    groups,
    contexts,
    frames: frameReport ? frameReport.frames : [],
    frameStats: frameReport ? frameReport.stats : null,
    stats,
  };
}

/** 某节点参与的关系（诊断/单节点解释用）。 */
export function relationsForNode(
  graph: { readonly relations?: readonly VomRelationRecord[] } | null | undefined,
  nodeId: unknown,
): NodeRelationView[] {
  const wanted = nodeIdOf(nodeId);
  if (!wanted || !graph || !Array.isArray(graph.relations)) return [];
  return graph.relations
    .filter((relation) => relation.from === wanted || relation.to === wanted)
    .map((relation) => ({
      type: relation.type,
      direction: (relation.from === wanted ? 'out' : 'in') as 'out' | 'in',
      from: relation.from,
      to: relation.to,
      confidence: relation.confidence,
      sources: Array.isArray(relation.sources) ? relation.sources.slice() : [relation.source],
      ...(relation.self === true ? { self: true as const } : {}),
      ...(Number.isFinite(Number(relation.depth)) ? { depth: Number(relation.depth) } : {}),
    }));
}

/** 某节点的 labels 链（按 aria-labelledby 深度排序；aria-labelledby 在前，链尾在后）。 */
export function labelChainForNode(
  graph: { readonly relations?: readonly VomRelationRecord[] } | null | undefined,
  nodeId: unknown,
): LabelChainHop[] {
  const wanted = nodeIdOf(nodeId);
  if (!wanted || !graph || !Array.isArray(graph.relations)) return [];
  return graph.relations
    .filter((relation) => relation.type === 'labels' && relation.to === wanted)
    .map((relation) => ({
      from: relation.from,
      confidence: relation.confidence,
      source: relation.source,
      depth: Number.isFinite(Number(relation.depth)) ? Number(relation.depth) : 1,
      ...(relation.chain ? { chain: relation.chain.slice() } : {}),
    }))
    .sort((a, b) => a.depth - b.depth);
}

/** 按置信度阈值过滤（诊断/发布前自检用）；返回新图，不修改原对象。 */
export function filterRelationsByConfidence(
  graph: VomRelationGraph | null | undefined,
  minConfidence: unknown = 0.7,
): VomRelationGraph | null | undefined {
  if (!graph || !Array.isArray(graph.relations)) return graph;
  const floor = confidenceOf(minConfidence);
  const relations = graph.relations.filter((relation) => relation.confidence >= floor);
  const byType: Record<string, number> = {};
  for (const relation of relations) byType[relation.type] = (byType[relation.type] || 0) + 1;
  return {
    ...graph,
    relations,
    stats: {
      ...graph.stats,
      relations: relations.length,
      byType,
      filteredBelow: floor,
    },
  };
}
