/** Build the machine-readable VOM payload from observation nodes + layers + visual objects. */
import { buildVomGraph, fallbackNodeId } from './vom-graph.js';
import { mergeAxIntoGraph } from './ax-graph.js';
import { landmarkSection, rowAnchor, formAnchor } from './vom-section.js';
import { buildVomGroups } from './vom-groups.js';
import { buildVomSemanticGraph } from './vom-semantic.js';
import { buildVomRelationGraph } from './vom-relations.js';
import { buildVomContext } from './vom-context.js';
import { compressVomByRelations } from './vom-compress.js';
import { affordanceForNode } from './vom-affordance.js';
import { deriveLayers } from './vom-layers.js';
import { evaluateVisibility, resolveOcclusion, summarizeVisibilityGate, visibilityPayload } from './vom-visibility.js';
import { normalizeRowAnchor } from './vom-rows.js';

function relationsOf(node) {
  const relations = {};
  if (node.ariaControls) relations.controls = String(node.ariaControls).split(/\s+/).filter(Boolean);
  if (node.ariaLabelledBy) relations.labelledBy = String(node.ariaLabelledBy).split(/\s+/).filter(Boolean);
  if (node.ariaDescribedBy) relations.describedBy = String(node.ariaDescribedBy).split(/\s+/).filter(Boolean);
  if (node.ariaOwns) relations.owns = String(node.ariaOwns).split(/\s+/).filter(Boolean);
  if (node.ariaErrorMessage) relations.errorMessage = String(node.ariaErrorMessage).split(/\s+/).filter(Boolean);
  if (Array.isArray(node.labels) && node.labels.length) relations.labels = node.labels.slice(0, 8);
  if (Array.isArray(node.labelIds) && node.labelIds.length) relations.labelIds = node.labelIds.slice(0, 8).map(String);
  if (node.formId) relations.form = [String(node.formId)];
  return relations;
}

/** 旧路径（没有页面图）的边：ancestors[0] → 当前节点，父节点用 ref 或 tag#id 作为 key。 */
function legacyEdges(entries) {
  const edges = [];
  for (const { node, id } of entries) {
    const parent = Array.isArray(node.ancestors) ? node.ancestors[0] : null;
    if (!parent) continue;
    const parentKey = parent.ref || (parent.tag ? parent.tag + (parent.id ? '#' + parent.id : '') : null);
    if (id && parentKey) edges.push({ type: 'child', from: parentKey, to: id, child: id, parent: parentKey });
  }
  return edges;
}

function nodeViewOf(entry) {
  const node = entry.node || {};
  return {
    id: entry.id,
    ref: node.ref || null,
    role: node.role || null,
    tag: node.tag || null,
    bounds: node.bounds || node.rect || null,
    layerKind: node.layerKind || null,
    zIndex: node.zIndex,
    blocking: node.blocking === true || node.underBlockingLayer != null,
    paintOrder: Number.isInteger(node.paintOrder) ? node.paintOrder : null,
    underBlockingLayer: node.underBlockingLayer != null ? node.underBlockingLayer : null,
    inViewport: node.inViewport,
    pointerEvents: node.pointerEvents || null,
    hitTest: node.hitTest || null,
    clickable: node.clickable,
    visible: node.visible,
    paintVisible: node.paintVisible,
    hiddenReason: node.hiddenReason || null,
    display: node.display || (node.styles && node.styles.display) || null,
    styleVisibility: node.styleVisibility || null,
    styleOpacity: node.styleOpacity != null ? node.styleOpacity : (node.opacity != null ? node.opacity : null),
    detached: node.detached === true,
    clipped: node.clipped === true,
    clippedBy: node.clippedBy || null,
    ariaHidden: node.ariaHidden === true,
    anchor: normalizeRowAnchor(node.anchor),
    ancestorIds: entry.ancestorIds || [],
  };
}

export function buildVomPayload({ nodes = [], layers = [], visual = [], issues = [], documentId = null, revision = null, facts = null, graph = null, axNodes = null, capture = null, frames = null, compress = null, relationLimits = null, contextLimits = null } = {}) {
  // 节点必须能落到关系图/可见性模型里：有 ref/stableRef（可动作）、有布局、或页面图 key（语义关系端点）。
  // graphKey 让 label/img/table 等非交互语义节点也进入关系与上下文（否则 labels/alt/表格分组会缺端点）。
  const list = (Array.isArray(nodes) ? nodes : []).filter((node) => node
    && (node.ref || node.backendNodeId || node.bounds || node.rect || node.graphKey));
  const entries = list.map((node, index) => ({
    node,
    relations: relationsOf(node),
    index,
  }));
  const built = buildVomGraph({ graph, nodes: list });
  const graphInfo = built.info;
  for (const entry of entries) {
    const info = graphInfo.get(entry.node);
    entry.id = info ? info.id : fallbackNodeId(entry.node, entry.index);
    entry.parentId = info ? info.parentId : '';
    entry.ancestorIds = info ? info.ancestorIds : [];
  }
  const relationCount = entries.filter((item) => Object.keys(item.relations).length > 0).length;
  // AX 父子边并入图（仅在 --ax 时；没有 AX 树时保持原图）。
  const merged = built.available && Array.isArray(axNodes) && axNodes.length
    ? mergeAxIntoGraph(built.payload, { axNodes, nodes: list, info: graphInfo })
    : null;
  const graphPayload = merged ? merged.graph : (built.available ? built.payload : null);
  const edges = merged
    ? graphPayload.edges.map((edge) => (edge.type === 'child'
      ? { type: 'child', from: edge.from, to: edge.to, child: edge.to, parent: edge.from }
      : { type: edge.type, from: edge.from, to: edge.to }))
    : built.available
      ? built.payload.edges.map((edge) => (edge.type === 'child'
        ? { type: 'child', from: edge.from, to: edge.to, child: edge.to, parent: edge.from }
        : { type: edge.type, from: edge.from, to: edge.to }))
      : legacyEdges(entries);
  const vomGroups = buildVomGroups(entries);
  const semanticGraph = buildVomSemanticGraph(entries);
  // 有序层模型：base/fixed-sticky/floating/blocking/top-layer（payload 只暴露非 base 层）。
  const layerModel = deriveLayers(Array.isArray(layers) ? layers : []);
  const layerEntries = layerModel.layers
    .filter((layer) => layer.kind !== 'base')
    .map((layer) => ({
      level: layer.level,
      index: layer.index,
      kind: layer.kind,
      zIndex: layer.zIndex,
      blocking: layer.blocking === true,
      topLayer: layer.topLayer || null,
      role: layer.role,
      name: layer.name,
      backendNodeId: layer.backendNodeId,
      bounds: layer.rect,
      coverage: Number.isFinite(layer.coverage) ? layer.coverage : null,
    }));
  const groupEdges = vomGroups.sections.concat(vomGroups.rows, vomGroups.forms)
    .flatMap((group) => group.nodeIds.map((nodeId) => ({ type: 'group', group: group.id, node: nodeId })));
  // 关系图 v3：组图（v2）之上的关系层，带 confidence/source 与组上下文；跨 frame 时 frame 也是节点。
  const relations = buildVomRelationGraph({
    entries,
    graph: graphPayload,
    semantic: semanticGraph,
    frames,
    ...(relationLimits ? { limits: relationLimits } : {}),
  });
  // 语义上下文（landmark/form/table 分组 + 每节点上下文链）；关系图之上再给一层可查询结构。
  const context = buildVomContext({
    entries,
    graph: graphPayload,
    frames: frames ? (relations.frames && relations.frames.length ? relations.frames : undefined) : undefined,
    ...(contextLimits ? { limits: contextLimits } : {}),
  });
  // 统一 gate：paint-order + 层模型 + 几何求遮挡；每个节点只判一次。
  const views = entries.map(nodeViewOf);
  const occlusion = resolveOcclusion(views, { layers: layerEntries });
  const identityCount = list.filter((node) => node.stableRef).length;
  const layoutCount = list.filter((node) => node.bounds || node.rect).length;
  const interactCount = list.filter((node) => node.hitTest || node.clickable).length;
  const stages = [
    { stage: 'facts', ok: Number(facts && facts.nodes) > 0, count: Number(facts && facts.nodes) || 0 },
    { stage: 'identity', ok: identityCount > 0, count: identityCount },
    { stage: 'relations', ok: relationCount > 0, count: relationCount },
    { stage: 'layout', ok: layoutCount > 0, count: layoutCount },
    { stage: 'paint', ok: (Array.isArray(layers) ? layers.length : 0) > 0, count: Array.isArray(layers) ? layers.length : 0 },
    { stage: 'interact', ok: interactCount > 0, count: interactCount },
  ];
  const payload = {
    version: 1,
    documentId: documentId || null,
    revision: Number.isInteger(revision) ? revision : null,
    stages,
    ...(capture ? { capture } : {}),
    edges,
    graph: graphPayload,
    issues: (Array.isArray(issues) ? issues : []).map((issue) => ({
      stage: String(issue.stage || 'unknown'),
      reason: String(issue.reason || '').slice(0, 240),
    })),
    layers: layerEntries,
    groups: vomGroups,
    semantic: semanticGraph,
    relations,
    context,
    groupEdges,
    nodes: entries.map(({ node, relations: nodeRelations, id, parentId, ancestorIds }) => {
      const view = nodeViewOf({ node, id, ancestorIds });
      const anchor = normalizeRowAnchor(node.anchor);
      return {
        ...(landmarkSection(node.ancestors) ? { section: landmarkSection(node.ancestors) } : {}),
        ...(rowAnchor(node.ancestors) ? { row: rowAnchor(node.ancestors) } : {}),
        ...(formAnchor(node.ancestors) ? { form: formAnchor(node.ancestors) } : {}),
        id,
        parentId: parentId || null,
        ancestorIds,
        ref: node.ref || null,
        stableRef: node.stableRef || null,
        ...(Object.keys(nodeRelations).length ? { relations: nodeRelations } : {}),
        ...(Array.isArray(node.ancestors) && node.ancestors.length ? { ancestors: node.ancestors.slice(0, 4) } : {}),
        backendNodeId: Number.isInteger(node.backendNodeId) ? node.backendNodeId : null,
        tag: node.tag || null,
        role: node.role || null,
        name: node.name || null,
        bounds: node.bounds || node.rect || null,
        inViewport: node.inViewport === true,
        pointerEvents: node.pointerEvents || null,
        cursor: node.cursor || null,
        occludedBy: node.occludedBy || null,
        visible: node.visible !== false,
        hitTest: node.hitTest || null,
        clickable: node.clickable === true,
        paintOrder: Number.isInteger(node.paintOrder) ? node.paintOrder : null,
        underBlockingLayer: node.underBlockingLayer || null,
        disabled: node.disabled === true,
        focused: node.focused === true,
        selected: node.selected === true,
        invalid: node.invalid === true,
        ariaLive: node.ariaLive || null,
        ariaPressed: node.ariaPressed === true,
        ariaHasPopup: node.ariaHasPopup || null,
        ariaValueNow: Number.isFinite(node.ariaValueNow) ? node.ariaValueNow : null,
        ariaValueMin: Number.isFinite(node.ariaValueMin) ? node.ariaValueMin : null,
        ariaValueMax: Number.isFinite(node.ariaValueMax) ? node.ariaValueMax : null,
        ariaCurrent: node.ariaCurrent || null,
        ariaHidden: node.ariaHidden === true,
        contrast: Number.isFinite(node.contrast) ? node.contrast : null,
        lowContrast: node.lowContrast === true,
        headingLevel: /^h[1-6]$/i.test(String(node.tag || '')) ? Number(String(node.tag).slice(1)) : null,
        busy: node.busy === true,
        expanded: node.expanded === true,
        checked: node.checked === true,
        // 虚拟列表行事实（anchor 七字段 + role/tag），W2 fill/click 的 rowAnchor 直接消费。
        ...(anchor ? { anchor } : {}),
        // 统一 gate 判定：paint-order/可见性/遮挡/pointer-events 的原因只在这里产出。
        visibility: visibilityPayload(view, { occluder: occlusion.byId.get(String(id)) || null }),
        // 类型化 affordance：activate/type/toggle/select/drag/scroll/dismiss/hover/focus/upload。
        affordance: affordanceForNode(node),
        ...(Number.isInteger(node.vomScore) ? { vomScore: node.vomScore } : {}),
        ...(Array.isArray(node.vomFactors) ? { vomFactors: node.vomFactors } : {}),
      };
    }),
    visual: (Array.isArray(visual) ? visual : []).map((item) => ({ ...item })),
  };
  // 节点逐条判定已经算过 visibility；这里只做聚合，避免二次 evaluate。
  payload.visibility = summarizePayloadVisibility(payload);
  // 语义压缩（opt-in）：按 context/groups 折叠同类条目并给 report；不改变计费口径（name+role）。
  if (compress) {
    const options = compress === true ? {} : compress;
    payload.compression = compressVomByRelations({
      nodes: payload.nodes,
      relations: payload.relations,
      context: payload.context,
      groups: payload.groups,
      semantic: payload.semantic,
    }, options && typeof options === 'object' ? options : {});
  }
  return payload;
}

/** payload 构建后重新汇总 gate（节点已逐条判定，这里只统计，避免重复计算）。 */
export function summarizePayloadVisibility(payload) {
  const nodes = payload && Array.isArray(payload.nodes) ? payload.nodes : [];
  const byReason = {};
  let kept = 0;
  for (const node of nodes) {
    const visibility = node && node.visibility;
    if (!visibility) continue;
    if (visibility.interactive) kept += 1;
    for (const reason of Array.isArray(visibility.reasons) ? visibility.reasons : []) {
      byReason[reason] = (byReason[reason] || 0) + 1;
    }
  }
  return summarizeVisibilityGate({
    mode: 'interactable',
    counts: { input: nodes.length, kept, dropped: nodes.length - kept, byReason },
  });
}
