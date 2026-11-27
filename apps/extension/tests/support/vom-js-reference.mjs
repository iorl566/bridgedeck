// tests/support/vom-js-reference.mjs —— JS 侧参考投影（差分测试的对照实现，非产品代码）。
//
// 目的：把「同一组页面事实（facts JSON）」投影成 JS 版 `extension/src/lib/vom-*.js`
// 期望的输入形状（entries + 页面图 + frames + limits），然后由 JS 实现自己算
// affordance / relations / context。这样差分覆盖的是：
//   1) TS 投影（vom-facts.projectVomFacts）↔ JS 参考投影；
//   2) TS packages/vom 的判定 ↔ JS lib 的判定（同一投影下逐字段相等）。
//
// 这个文件刻意独立实现（不 import TS 代码），否则差分就变成自己和自己比。
// 语义依据：extension/src/lib/vom-payload.js 的 relationsOf/legacyEdges 约定，
// 以及 extension/src/lib/vom-graph.js 的公开图结构（id/domId/parentId + edge.type）。
//
// 若 TS 投影改了语义，这里必须同步；不同步会让 tests/vom-diff.test.ts 红，这正是差分门禁。

const DEFAULT_LIMITS = {
  nodes: 900,
  ancestors: 32,
  edges: 1500,
  frames: 16,
  relations: 600,
  groups: 200,
  contexts: 200,
  chainDepth: 3,
};

function positiveLimit(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

export function limitSetOfJs(input) {
  const limits = input && typeof input === 'object' ? input : {};
  return {
    nodes: positiveLimit(limits.nodes, DEFAULT_LIMITS.nodes, 5000),
    ancestors: positiveLimit(limits.ancestors, DEFAULT_LIMITS.ancestors, 128),
    edges: positiveLimit(limits.edges, DEFAULT_LIMITS.edges, 5000),
    frames: positiveLimit(limits.frames, DEFAULT_LIMITS.frames, 200),
    relations: positiveLimit(limits.relations, DEFAULT_LIMITS.relations, 5000),
    groups: positiveLimit(limits.groups, DEFAULT_LIMITS.groups, 2000),
    contexts: positiveLimit(limits.contexts, DEFAULT_LIMITS.contexts, 5000),
    chainDepth: positiveLimit(limits.chainDepth, DEFAULT_LIMITS.chainDepth, 6),
  };
}

function relationList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.length > 0).slice(0, 16)
    : [];
}

function relationsOfFactsJs(node) {
  const raw = (node && node.relations) || {};
  return {
    controls: relationList(raw.controls),
    labelledBy: relationList(raw.labelledBy),
    describedBy: relationList(raw.describedBy),
    owns: relationList(raw.owns),
    labelIds: relationList(raw.labelIds),
    form: relationList(raw.form),
    errorMessage: relationList(raw.errorMessage),
  };
}

function hasAnyRelation(relations) {
  return relations.controls.length > 0 || relations.labelledBy.length > 0
    || relations.describedBy.length > 0 || relations.owns.length > 0
    || relations.labelIds.length > 0 || relations.form.length > 0
    || relations.errorMessage.length > 0;
}

function ancestorIdsOfJs(node) {
  return Array.isArray(node && node.ancestorIds)
    ? node.ancestorIds.map((id) => String(id)).filter(Boolean)
    : [];
}

/** 与 TS projectVomFacts 等价的 JS 参考投影。 */
export function projectVomFactsJs(facts) {
  const nodes = Array.isArray(facts && facts.nodes) ? facts.nodes : [];
  const limits = limitSetOfJs(facts && facts.limits);
  const nodeById = new Map();
  const domIdToNodeId = new Map();
  for (const node of nodes) {
    if (!node || !node.id) continue;
    nodeById.set(String(node.id), node);
    if (node.domId) {
      const domId = String(node.domId);
      if (!domIdToNodeId.has(domId)) domIdToNodeId.set(domId, String(node.id));
    }
  }
  const resolve = (domId) => {
    const value = domId == null ? '' : String(domId);
    return value ? domIdToNodeId.get(value) || null : null;
  };
  const graphNodes = [];
  for (const node of nodes) {
    if (!node || !node.id) continue;
    const ancestorIds = ancestorIdsOfJs(node);
    graphNodes.push({
      id: String(node.id),
      domId: node.domId ?? null,
      role: node.role,
      tag: node.tag,
      name: node.name,
      parentId: ancestorIds.length ? String(ancestorIds[0]) : null,
    });
  }
  const frames = Array.isArray(facts && facts.frames) ? facts.frames.slice(0, limits.frames) : [];
  for (const frame of frames) {
    const frameId = Number(frame.frameId);
    if (!Number.isInteger(frameId)) continue;
    const frameNodeId = 'frame:' + String(frameId);
    if (!graphNodes.some((node) => node.id === frameNodeId)) {
      graphNodes.push({
        id: frameNodeId,
        domId: null,
        role: frameId === 0 ? 'document' : 'frame',
        tag: 'iframe',
        name: frame.url ?? '',
        parentId: frame.ownerNodeId ?? null,
      });
    }
  }
  const edges = [];
  const seen = new Set();
  let truncated = false;
  const add = (type, from, to) => {
    const left = from == null ? '' : String(from);
    const right = to == null ? '' : String(to);
    if (!left || !right || left === right) return false;
    const key = type + '\u0000' + left + '\u0000' + right;
    if (seen.has(key)) return false;
    if (edges.length >= limits.edges) {
      truncated = true;
      return false;
    }
    seen.add(key);
    edges.push({ type, from: left, to: right });
    return true;
  };
  for (const frame of frames) {
    const frameId = Number(frame.frameId);
    if (frame.ownerNodeId) add('frame', frame.ownerNodeId, 'frame:' + String(frameId));
  }
  for (const node of nodes) {
    if (!node || !node.id) continue;
    const id = String(node.id);
    const ancestorIds = ancestorIdsOfJs(node);
    const relations = relationsOfFactsJs(node);
    const parentId = ancestorIds.length ? String(ancestorIds[0]) : '';
    if (parentId && nodeById.has(parentId)) add('child', parentId, id);
    for (const target of relations.controls) {
      const to = resolve(target);
      if (!to) continue;
      add('controls', id, to);
      if (node.role === 'tab') add('tab-controls', id, to);
    }
    for (const target of relations.labelledBy) {
      const from = resolve(target);
      if (from) add('labelledby', from, id);
    }
    for (const target of relations.describedBy) {
      const from = resolve(target);
      if (from) add('describedby', from, id);
    }
    for (const target of relations.owns) {
      const to = resolve(target);
      if (to) add('owns', id, to);
    }
    for (const target of relations.errorMessage) {
      const from = resolve(target);
      if (from) add('errormessage', from, id);
    }
    for (const target of relations.labelIds) {
      const from = resolve(target);
      if (from) add('html-for', from, id);
    }
    for (const target of relations.form) {
      const from = resolve(target);
      if (from) add('form', from, id);
    }
    const ancestors = Array.isArray(node.ancestors) ? node.ancestors : [];
    const formAncestor = ancestors.find((ancestor) => ancestor.tag === 'form' || ancestor.role === 'form');
    if (formAncestor && formAncestor.id !== id) add('form', formAncestor.id, id);
  }
  const entries = nodes.map((node) => {
    const relations = relationsOfFactsJs(node);
    const ancestorIds = ancestorIdsOfJs(node);
    const ancestors = Array.isArray(node.ancestors) ? node.ancestors : [];
    const relationFacts = hasAnyRelation(relations)
      ? {
        ...(relations.controls.length ? { controls: relations.controls.slice() } : {}),
        ...(relations.labelledBy.length ? { labelledBy: relations.labelledBy.slice() } : {}),
        ...(relations.describedBy.length ? { describedBy: relations.describedBy.slice() } : {}),
        ...(relations.owns.length ? { owns: relations.owns.slice() } : {}),
        ...(relations.labelIds.length ? { labelIds: relations.labelIds.slice() } : {}),
        ...(relations.form.length ? { form: relations.form.slice() } : {}),
        ...(relations.errorMessage.length ? { errorMessage: relations.errorMessage.slice() } : {}),
      }
      : null;
    return {
      id: String(node.id),
      node: {
        ...(node.domId ? { id: node.domId } : {}),
        ...(node.role ? { role: node.role } : {}),
        ...(node.tag ? { tag: node.tag } : {}),
        ...(node.name ? { name: node.name } : {}),
        ...(node.alt ? { alt: node.alt } : {}),
        ...(node.title ? { title: node.title } : {}),
        ...(node.invalid ? { invalid: true } : {}),
        ancestors: ancestors.map((ancestor) => ({
          id: ancestor.domId,
          ref: ancestor.id,
          role: ancestor.role || undefined,
          tag: ancestor.tag || undefined,
          name: ancestor.name ?? undefined,
        })),
        ...(node.table
          ? {
            tableFacts: {
              headers: (Array.isArray(node.table.headers) ? node.table.headers : []).map((header) => ({
                id: header.id,
                role: header.role,
                name: header.name,
              })),
              dataRows: node.table.dataRows,
              caption: node.table.caption,
            },
          }
          : {}),
      },
      ...(relationFacts ? { relations: relationFacts } : {}),
      ...(ancestorIds.length ? { ancestorIds: ancestorIds.slice(0, 8) } : {}),
    };
  });
  const roots = graphNodes.filter((node) => !node.parentId).map((node) => String(node.id));
  const graph = {
    available: true,
    nodes: graphNodes,
    edges,
    roots,
    truncated,
  };
  const frameInputs = frames.length
    ? frames.map((frame) => {
      const frameId = Number(frame.frameId);
      const frameNodeId = 'frame:' + String(frameId);
      const minimalGraph = {
        available: true,
        nodes: [{
          id: frameNodeId,
          role: frameId === 0 ? 'document' : 'frame',
          url: frame.url ?? undefined,
          parentId: frame.ownerNodeId ?? null,
        }],
        edges: frame.ownerNodeId ? [{ type: 'frame', from: frame.ownerNodeId, to: frameNodeId }] : [],
        roots: [],
        truncated: false,
      };
      return {
        frameId,
        url: frame.url ?? undefined,
        parentFrameId: frame.parentFrameId ?? undefined,
        graph: frame.graph || minimalGraph,
      };
    })
    : null;
  return {
    entries,
    graph,
    frames: frameInputs,
    limits: {
      relations: limits.relations,
      groups: limits.groups,
      contexts: limits.contexts,
      chainDepth: limits.chainDepth,
    },
  };
}

/** JS 侧 affordance 输入：与 TS affordanceInputOf 等价（页面事实 → 节点事实）。 */
export function affordanceInputJs(node) {
  const ancestors = Array.isArray(node.ancestors) ? node.ancestors : [];
  return {
    role: node.role || undefined,
    tag: node.tag || undefined,
    name: node.name || undefined,
    inputType: node.inputType || undefined,
    contentEditable: node.contentEditable,
    draggable: node.draggable,
    dragHint: node.dragHint || undefined,
    overflowY: node.overflowY || undefined,
    scrollable: node.scrollable,
    ariaHasPopup: node.ariaHasPopup || undefined,
    hoverable: node.hoverable,
    href: node.href || undefined,
    clickable: node.clickable,
    cursor: node.cursor || undefined,
    tabIndex: node.tabIndex ?? undefined,
    ariaPressed: node.ariaPressed ?? undefined,
    expanded: node.expanded ?? undefined,
    ancestors: ancestors.map((ancestor) => ({ role: ancestor.role, tag: ancestor.tag })),
  };
}
