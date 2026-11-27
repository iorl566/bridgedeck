// tools/longtail/gen/page.mjs —— 大页面夹具生成器（确定性）。
//
// 生成的是 VOM 的真实输入形状，不是"假 DOM"：
//   { main: { frameId:0, nodes:[{key,ref,tag,role,domId,parentKey,frameIndex,srcUrl,anchor,...}],
//              edges:[{type,from,to}] },
//     frames: [{frameId,parentFrameId,url,hidden,iframeOwners,graph:{nodes,edges}}], ... }
//
// 这些结构随后被真实模块消费：
//   - extension/src/lib/vom-graph.js        buildVomGraph（元素/边规范化 + 上限截断）
//   - extension/src/lib/frame-vom.js        buildFrameVomGraphs（多 iframe 子图 + frame 边）
//   - extension/src/lib/vom-frames-depth.js buildFrameDepthReport（帧树/归属链/缺口）
//   - extension/src/lib/vom-frame-relations.js buildCrossFrameRelations（跨帧关系）
//   - extension/src/lib/vom-relations.js    buildVomRelationGraph（语义关系边）
//   - extension/src/lib/vom-semantic.js     buildVomSemanticGraph（分组/上下文）
//   - extension/src/lib/vom-weights.js      rankVomNodes/selectVomNodes（元素预算）
//
// 规模契约（default profile）：refs ≥ 1000、嵌套深度 ≥ 12、iframe ≥ 8、边 ≥ 1.5×refs。
// 全部随机抽取来自 seed 派生的 PRNG，因此同一 seed 在不同进程里产出逐字节一致的夹具。

import { DEFAULT_SEED, rngFor, stableHash, deriveSeed } from '../lib/prng.mjs';

export const PAGE_FIXTURE_VERSION = 1;

/** 角色循环：覆盖 VOM 里会被加权/建关系的常见角色。 */
const ROLE_CYCLE = Object.freeze([
  'button', 'link', 'textbox', 'checkbox', 'combobox', 'option', 'heading', 'paragraph',
  'image', 'list', 'listitem', 'menuitem', 'tab', 'tabpanel', 'radio', 'switch',
  'tree', 'treeitem', 'grid', 'gridcell', 'row', 'searchbox', 'slider', 'region',
]);

/** 交互角色（会被 VOM 权重加分、被关系图当动作目标）。 */
const INTERACTIVE_ROLES = Object.freeze(new Set([
  'button', 'link', 'textbox', 'checkbox', 'combobox', 'option', 'menuitem', 'tab',
  'radio', 'switch', 'treeitem', 'gridcell', 'searchbox', 'slider',
]));

/** 组合控件角色：会产出 owns 关系。 */
const COMPOSITE_ROLES = Object.freeze(new Set(['combobox', 'listbox', 'menu', 'tree', 'tablist', 'radiogroup', 'grid']));

const ROLE_TAG = Object.freeze({
  button: 'button',
  link: 'a',
  textbox: 'input',
  searchbox: 'input',
  checkbox: 'input',
  radio: 'input',
  switch: 'button',
  combobox: 'div',
  option: 'div',
  heading: 'h2',
  paragraph: 'p',
  image: 'img',
  list: 'ul',
  listitem: 'li',
  menuitem: 'div',
  tab: 'button',
  tabpanel: 'div',
  tree: 'ul',
  treeitem: 'li',
  grid: 'table',
  gridcell: 'td',
  row: 'tr',
  slider: 'input',
  region: 'section',
  navigation: 'nav',
  main: 'main',
  form: 'form',
  table: 'table',
  document: 'body',
  group: 'div',
});

const INTERACTIVE_RATIO = 0.42;
const STABLE_REF_EVERY = 6;
const DOM_ID_EVERY = 5;
const ROW_ANCHOR_EVERY = 17;
const OFFSCREEN_RATIO = 0.02;
const POINTER_TRANSPARENT_RATIO = 0.02;
const OCCLUDED_RATIO = 0.03;
const HIDDEN_RATIO = 0.01;

function tagForRole(role) {
  return ROLE_TAG[role] || 'div';
}

function rectFor(index, role, rng) {
  const width = role === 'heading' ? 240 : (INTERACTIVE_ROLES.has(role) ? 96 : 320);
  const height = role === 'heading' ? 28 : (INTERACTIVE_ROLES.has(role) ? 32 : 20);
  return {
    x: 8 + (index % 48) * 24 + rng.int(0, 3),
    y: 8 + Math.floor(index / 48) * 22 + rng.int(0, 2),
    w: width,
    h: height,
  };
}

function nameFor(role, index) {
  const labels = {
    button: '按钮',
    link: '链接',
    textbox: '输入框',
    searchbox: '搜索',
    checkbox: '复选框',
    radio: '单选框',
    combobox: '下拉框',
    option: '选项',
    heading: '标题',
    paragraph: '说明',
    image: '图片',
    list: '列表',
    listitem: '列表项',
    menuitem: '菜单项',
    tab: '标签页',
    tabpanel: '面板',
    tree: '树',
    treeitem: '树节点',
    grid: '表格',
    gridcell: '单元格',
    row: '行',
    slider: '滑块',
    region: '区域',
  };
  return (labels[role] || '元素') + ' ' + String(index).padStart(4, '0');
}

/**
 * 生成一棵"深链 + 宽扇出"的节点树。
 * 返回的节点带 parentKey，ancestors 由 model 层按父链补（避免夹具里重复存祖先数组）。
 */
function buildNodeTree({ count, depth, rng, prefix, refPrefix, rolePool, landmarkRoles = null }) {
  const nodes = [];
  const chain = [];
  const add = (spec) => {
    const node = { key: prefix + nodes.length, ref: refPrefix + nodes.length, ...spec };
    nodes.push(node);
    return node;
  };
  const documentRole = landmarkRoles && landmarkRoles.root ? landmarkRoles.root : 'document';
  const root = add({
    tag: tagForRole(documentRole),
    role: documentRole,
    parentKey: null,
    depth: 0,
    interactive: false,
    name: '文档根',
    domId: 'doc-root',
    rect: { x: 0, y: 0, w: 1280, h: 720 },
    visible: true,
  });
  chain.push(root);

  // 1) 深链：depth 层嵌套，保证 VOM 的 ancestors/归属链有足够深度。
  for (let level = 1; level <= depth && nodes.length < count; level += 1) {
    const role = landmarkRoles && landmarkRoles.byLevel && landmarkRoles.byLevel[level]
      ? landmarkRoles.byLevel[level]
      : (level % 4 === 0 ? 'region' : 'group');
    const parent = chain[chain.length - 1];
    const node = add({
      tag: tagForRole(role),
      role,
      parentKey: parent.key,
      depth: level,
      interactive: false,
      name: nameFor(role === 'group' ? 'region' : role, level),
      domId: level % DOM_ID_EVERY === 0 ? 'el-' + level : null,
      rect: rectFor(level, role, rng),
      visible: true,
    });
    chain.push(node);
  }

  // 2) 宽度：剩余节点挂在链上（主要挂尾部，少量挂浅层），保证"深 + 宽"同时成立。
  let cursor = chain.length;
  while (nodes.length < count) {
    const index = nodes.length;
    const role = rolePool[rng.int(0, rolePool.length - 1)];
    const interactive = INTERACTIVE_ROLES.has(role) || rng.chance(INTERACTIVE_RATIO * 0.2);
    let parent;
    if (rng.chance(0.72)) parent = chain[chain.length - 1];
    else parent = chain[Math.max(0, chain.length - 1 - rng.int(0, Math.min(8, chain.length - 1)))];
    const visible = !rng.chance(HIDDEN_RATIO);
    const rect = rectFor(index, role, rng);
    if (rng.chance(OFFSCREEN_RATIO)) {
      rect.x = -20_000 - rng.int(0, 500);
      rect.y = -20_000;
    }
    const node = add({
      tag: tagForRole(role),
      role,
      parentKey: parent.key,
      depth: Number(parent.depth || 0) + 1,
      interactive,
      name: interactive || rng.chance(0.5) ? nameFor(role, index) : '',
      domId: index % DOM_ID_EVERY === 0 ? 'el-' + index : null,
      stableRef: index > 0 && index % STABLE_REF_EVERY === 0 ? 's-' + rng.hex(6) : null,
      rect,
      visible,
      ...(rng.chance(POINTER_TRANSPARENT_RATIO) ? { pointerEvents: 'none' } : {}),
      ...(rng.chance(OCCLUDED_RATIO) ? { hitTest: 'blocked', occludedBy: nodes.length > 0 ? nodes[nodes.length - 1].ref : null } : {}),
      ...(interactive ? { clickable: true } : {}),
      text: interactive ? nameFor(role, index) : (rng.chance(0.6) ? '文本 ' + index : ''),
      ...(index % ROW_ANCHOR_EVERY === 0
        ? { anchor: { ariaRowIndex: (index % 200) + 1, dataIndex: index, rowKey: 'row-' + index, rowText: '行 ' + index } }
        : {}),
    });
    cursor += 1;
    if (cursor > count * 2) break;
  }
  return nodes;
}

function buildEdges(nodes, rng, options = {}) {
  const edges = [];
  const push = (type, from, to) => {
    if (!from || !to || from === to) return;
    edges.push({ type, from, to });
  };
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const interactive = nodes.filter((node) => node.interactive);
  const textish = nodes.filter((node) => !node.interactive && (node.role === 'paragraph' || node.role === 'heading'));

  // child：每条父子边都进图（DOM 归属的事实来源）。
  for (const node of nodes) {
    if (node.parentKey && byKey.has(node.parentKey)) push('child', node.parentKey, node.key);
  }
  // labels：交互控件 ← 文本节点（模拟 label/aria-label 的显式关系）。
  for (let index = 0; index < interactive.length; index += 1) {
    if (!rng.chance(options.labelRatio ?? 0.62)) continue;
    const target = interactive[index];
    const source = textish.length ? textish[(index * 7 + rng.int(0, textish.length - 1)) % textish.length] : nodes[rng.int(0, nodes.length - 1)];
    push('label', source.key, target.key);
  }
  // html-for：一部分控件用 <label for> 语义。
  for (let index = 0; index < interactive.length; index += 9) {
    const target = interactive[index];
    const source = textish[(index + 3) % Math.max(1, textish.length)];
    if (source) push('html-for', source.key, target.key);
  }
  // aria-labelledby：少量链式标签（关系图会降低置信度）。
  for (let index = 4; index < interactive.length; index += 23) {
    const target = interactive[index];
    const source = textish[(index + 5) % Math.max(1, textish.length)];
    if (source) push('labelledby', source.key, target.key);
  }
  // controls：tab → panel。
  const tabs = nodes.filter((node) => node.role === 'tab');
  const panels = nodes.filter((node) => node.role === 'tabpanel');
  for (let index = 0; index < tabs.length; index += 1) {
    const panel = panels[index % Math.max(1, panels.length)];
    if (panel) push('tab-controls', tabs[index].key, panel.key);
  }
  // owns：组合控件 → 子项。
  const composites = nodes.filter((node) => COMPOSITE_ROLES.has(node.role));
  const ownedRoles = new Set(['option', 'menuitem', 'treeitem', 'tab', 'gridcell', 'row', 'listitem', 'radio']);
  const owned = nodes.filter((node) => ownedRoles.has(node.role));
  for (let index = 0; index < composites.length; index += 1) {
    const owner = composites[index];
    const child = owned[(index * 5) % Math.max(1, owned.length)];
    if (child) push('owns', owner.key, child.key);
  }
  // describedby + errormessage：给部分输入框挂描述/错误，喂 invalidates 关系。
  const inputs = nodes.filter((node) => node.role === 'textbox' || node.role === 'searchbox');
  for (let index = 0; index < inputs.length; index += 1) {
    if (rng.chance(options.describedbyRatio ?? 0.4)) {
      const source = textish[(index * 3 + 1) % Math.max(1, textish.length)];
      if (source) push('describedby', inputs[index].key, source.key);
    }
    if (index % 7 === 0) {
      const source = textish[(index * 3 + 2) % Math.max(1, textish.length)];
      if (source) push('errormessage', source.key, inputs[index].key);
    }
  }
  // form：表单控件归属（form 锚点关系）。
  const forms = nodes.filter((node) => node.role === 'form' || node.tag === 'form');
  for (let index = 0; index < Math.min(inputs.length, 40); index += 1) {
    const form = forms[index % Math.max(1, forms.length)];
    if (form) push('form', form.key, inputs[index].key);
  }
  return edges;
}

/** 生成一个 iframe 子图（子帧自己的页面图，规模小于主文档）。 */
function buildSubgraph(frameId, { count, rng, url }) {
  const nodes = buildNodeTree({
    count: Math.max(8, count),
    depth: Math.min(5, Math.max(2, Math.floor(count / 8))),
    rng,
    prefix: 'f' + frameId + 'k',
    refPrefix: '@f' + frameId + 'e',
    rolePool: ['button', 'link', 'textbox', 'paragraph', 'heading', 'listitem', 'region'],
    landmarkRoles: { root: 'document', byLevel: { 1: 'main', 2: 'navigation', 3: 'form' } },
  });
  const edges = buildEdges(nodes, rng, { labelRatio: 0.5, describedbyRatio: 0.25 });
  for (const node of nodes) {
    if (node.parentKey) {
      const parent = nodes.find((item) => item.key === node.parentKey);
      node.depth = parent ? Number(parent.depth || 0) + 1 : 1;
    }
  }
  return { frameId, url, nodes, edges };
}

/**
 * 生成大页面夹具。
 * @param {{refs?:number, depth?:number, frames?:number, subgraphNodes?:number, seed?:string|number,
 *          profile?:string, documentUrl?:string}} [options]
 */
export function buildPageFixture(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const refs = Math.max(16, Math.floor(Number(opts.refs) || 1200));
  const depth = Math.max(2, Math.floor(Number(opts.depth) || 16));
  const frameCount = Math.max(0, Math.floor(Number(opts.frames) || 12));
  const subgraphNodes = Math.max(8, Math.floor(Number(opts.subgraphNodes) || 48));
  const seed = opts.seed == null ? DEFAULT_SEED : opts.seed;
  const profile = String(opts.profile || 'default');
  const baseUrl = String(opts.documentUrl || 'https://longtail.test/');

  // 每帧一条独立随机流：帧数变化不会扰动主文档内容（便于对比不同规模的指纹）。
  const rng = rngFor(seed, 'page', 'main');
  const nodes = buildNodeTree({
    count: refs,
    depth,
    rng,
    prefix: 'k',
    refPrefix: '@e',
    rolePool: ROLE_CYCLE,
    landmarkRoles: { root: 'document', byLevel: { 1: 'main', 2: 'navigation', 4: 'form', 8: 'table', 12: 'region' } },
  });
  const edges = buildEdges(nodes, rng);

  // 主文档里补 iframe 元素：number of child frames，父图中每个 iframe 一个节点。
  const frames = [];
  const urlFor = (frameId) => baseUrl + 'frame/' + frameId + '?seed=' + deriveSeed(seed, 'frame-url', frameId).toString(16);
  for (let frameId = 1; frameId <= frameCount; frameId += 1) {
    const frameRng = rngFor(seed, 'page', 'frame', frameId);
    let parentFrameId = 0;
    if (frameCount >= 3 && frameId === frameCount - 1) parentFrameId = Math.max(0, frameCount - 2);
    else if (frameCount >= 3 && frameId === frameCount) parentFrameId = frameCount - 1;
    const sub = buildSubgraph(frameId, { count: subgraphNodes, rng: frameRng, url: urlFor(frameId) });
    frames.push({
      frameId,
      parentFrameId,
      frameIndex: frameId,
      url: sub.url,
      title: '子帧 ' + frameId,
      hidden: frameId === frameCount && frameCount > 4,
      iframeOwners: [],
      graph: { nodes: sub.nodes, edges: sub.edges },
    });
  }

  // 把 iframe 元素挂到父图：主文档或上一级子帧；同时记录 iframeOwners（frame-vom 用）。
  const mainNodes = nodes;
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  for (const frame of frames) {
    const parentGraph = frame.parentFrameId === 0
      ? { nodes: mainNodes, edges }
      : frameById.get(frame.parentFrameId).graph;
    const iframeNode = {
      key: 'if' + frame.frameId,
      ref: '@if' + frame.frameId,
      tag: 'iframe',
      role: 'frame',
      domId: 'iframe-' + frame.frameId,
      name: '子帧 ' + frame.frameId,
      parentKey: parentGraph.nodes.length ? parentGraph.nodes[0].key : null,
      depth: 1,
      interactive: false,
      frameIndex: frame.frameId,
      srcUrl: frame.url,
      rect: { x: 0, y: 200 + frame.frameId * 32, w: 640, h: 400 },
      visible: frame.hidden !== true,
    };
    parentGraph.nodes.push(iframeNode);
    parentGraph.edges.push({ type: 'child', from: iframeNode.parentKey, to: iframeNode.key });
    const parentFrame = frame.parentFrameId === 0 ? null : frameById.get(frame.parentFrameId);
    if (parentFrame) {
      parentFrame.iframeOwners.push({ frameIndex: iframeNode.frameIndex, childFrameId: frame.frameId, childUrl: frame.url });
    }
  }
  // 主文档帧（frame 0）的 iframeOwners 由 frames 里 parentFrameId=0 的子帧决定；
  // 这里统一整理成 frame-vom 期望的结构：每条 entry 自己的 owner 列表。
  const mainOwners = frames
    .filter((frame) => frame.parentFrameId === 0)
    .map((frame) => ({ frameIndex: frame.frameIndex, childFrameId: frame.frameId, childUrl: frame.url }));

  const entries = [{
    frameId: 0,
    parentFrameId: null,
    frameIndex: 0,
    url: baseUrl,
    title: '主文档',
    hidden: false,
    iframeOwners: mainOwners,
    graph: { nodes: mainNodes, edges },
  }].concat(frames.map((frame) => ({
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId,
    frameIndex: frame.frameIndex,
    url: frame.url,
    title: frame.title,
    hidden: frame.hidden,
    iframeOwners: frame.iframeOwners.filter((owner) => owner && Number.isInteger(owner.childFrameId)),
    graph: frame.graph,
  })));

  const stats = computeFixtureStats(entries);
  const fingerprint = stableHash({
    version: PAGE_FIXTURE_VERSION,
    seed: String(seed),
    profile,
    refs: stats.refs,
    depth: stats.maxDepth,
    frames: stats.frames,
    nodes: stats.nodes,
    edges: stats.edges,
    byType: stats.byType,
    iframes: stats.iframeNodes,
  });

  return {
    version: PAGE_FIXTURE_VERSION,
    kind: 'page',
    seed: String(seed),
    profile,
    document: {
      documentId: 'doc-' + deriveSeed(seed, 'page', 'document').toString(16).padStart(8, '0'),
      url: baseUrl,
      title: '长尾压力页 seed=' + String(seed),
      revision: 1,
    },
    main: entries[0].graph,
    entries,
    frames: entries.slice(1).map((entry) => ({
      frameId: entry.frameId,
      parentFrameId: entry.parentFrameId,
      url: entry.url,
      title: entry.title,
      hidden: entry.hidden,
    })),
    stats,
    fingerprint,
  };
}

/** 统计夹具规模（生成器自检 + 预算断言共用）。 */
export function computeFixtureStats(entries) {
  const byType = {};
  let nodes = 0;
  let edges = 0;
  let refs = 0;
  let maxDepth = 0;
  let iframeNodes = 0;
  let interactive = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const graph = entry && entry.graph ? entry.graph : { nodes: [], edges: [] };
    nodes += graph.nodes.length;
    edges += graph.edges.length;
    for (const node of graph.nodes) {
      if (node.ref) refs += 1;
      if (node.interactive) interactive += 1;
      if (node.tag === 'iframe') iframeNodes += 1;
      if (Number(node.depth) > maxDepth) maxDepth = Number(node.depth);
    }
    for (const edge of graph.edges) byType[edge.type] = (byType[edge.type] || 0) + 1;
  }
  return {
    frames: Math.max(0, (Array.isArray(entries) ? entries : []).length - 1),
    entries: (Array.isArray(entries) ? entries : []).length,
    nodes,
    edges,
    refs,
    interactive,
    iframeNodes,
    maxDepth,
    byType,
  };
}

/** 把夹具里所有节点摊平成 [{node, ancestors:[...]}]（model 层建 observed entries 用）。 */
export function flattenPageNodes(fixture) {
  const out = [];
  const entries = fixture && Array.isArray(fixture.entries) ? fixture.entries : [];
  for (const entry of entries) {
    const nodes = entry && entry.graph ? entry.graph.nodes : [];
    const byKey = new Map(nodes.map((node) => [node.key, node]));
    for (const node of nodes) {
      const ancestors = [];
      let current = node;
      let guard = 0;
      while (current && current.parentKey && guard < 64) {
        const parent = byKey.get(current.parentKey);
        if (!parent) break;
        ancestors.push(parent);
        current = parent;
        guard += 1;
      }
      out.push({ frameId: entry.frameId, entry, node, ancestors });
    }
  }
  return out;
}

/** 摘要（报告用的一行）。 */
export function summarizePageFixture(fixture) {
  const stats = (fixture && fixture.stats) || computeFixtureStats(fixture && fixture.entries);
  return {
    version: PAGE_FIXTURE_VERSION,
    seed: fixture ? fixture.seed : null,
    refs: stats.refs,
    nodes: stats.nodes,
    edges: stats.edges,
    iframes: stats.iframeNodes,
    maxDepth: stats.maxDepth,
    frames: stats.frames,
    fingerprint: fixture ? fixture.fingerprint : null,
  };
}
