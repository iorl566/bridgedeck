// 真实 Chromium DOM 证据：关系图 v3 扩展 + 语义上下文 + 语义压缩 + 关系查询 + 跨 frame 关系。
// 夹具覆盖：aria-labelledby 链、<label for> 与隐式 label、组合控件（listbox/option）、
// tab-controls、aria-errormessage + aria-invalid、img alt 描述、title 自描述、表格 headers、
// landmark/form/table 分组、iframe 子帧（page-lib 在 srcdoc 里加载）。
// 成功 title = VOM_RELATIONS_OK:<断言数>，失败 title = VOM_RELATIONS_FAIL:<message>。
import { buildVomPayload } from '/extension/src/lib/vom-payload.js';
import { buildFrameVomGraphs } from '/extension/src/lib/frame-vom.js';
import { buildCrossFrameRelations, summarizeCrossFrameRelations } from '/extension/src/lib/vom-frame-relations.js';
import { buildVomRelationGraph, labelChainForNode } from '/extension/src/lib/vom-relations.js';
import { compressVomByRelations, summarizeVomCompression } from '/extension/src/lib/vom-compress.js';
import { queryVomRelations, summarizeRelationQuery } from '/extension/src/lib/vom-query.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const fail = (message) => { throw new Error(message); };
const expect = (value, message) => {
  if (!value) fail(message);
  passed += 1;
};

function pageLibOf(win) {
  const lib = win && win.__BB_PAGE__;
  if (!lib || typeof lib.handle !== 'function') fail('page-lib 未加载');
  return lib;
}

async function waitPageLib(win, label) {
  for (let index = 0; index < 300; index += 1) {
    if (win && win.__BB_PAGE__ && typeof win.__BB_PAGE__.handle === 'function') return pageLibOf(win);
    await sleep(20);
  }
  fail(label + ' 的 page-lib 未在超时内加载');
  return null;
}

async function call(lib, name, args) {
  const reply = await lib.handle(name, args || {});
  if (!reply || reply.ok !== true) {
    throw new Error(name + ' 失败：' + JSON.stringify((reply && reply.error) || reply));
  }
  return reply.result;
}

function findNode(nodes, role, name) {
  const list = Array.isArray(nodes) ? nodes : [];
  const node = list.find((item) => item && String(item.role || '').toLowerCase() === role
    && String(item.name || '') === name);
  if (!node) {
    const sample = list.filter((item) => item && item.role).slice(0, 20).map((item) => item.role + ':' + item.name);
    fail('观察结果缺少节点 ' + role + ' "' + name + '"；已有 ' + JSON.stringify(sample));
  }
  return node;
}

function firstNode(nodes, role) {
  const node = (Array.isArray(nodes) ? nodes : []).find((item) => item && String(item.role || '').toLowerCase() === role);
  if (!node) fail('观察结果缺少角色 ' + role);
  return node;
}

function graphNodeByDomId(graph, domId) {
  const node = (graph && Array.isArray(graph.nodes) ? graph.nodes : []).find((item) => item && item.domId === domId);
  if (!node) fail('页面图缺少 domId=' + domId + ' 的节点');
  return node;
}

function hasEdge(graph, type, fromKey, toKey) {
  return (graph && Array.isArray(graph.edges) ? graph.edges : []).some((edge) => edge
    && edge.type === type && edge.from === fromKey && edge.to === toKey);
}

function relationInto(payload, type, toId, source) {
  return (payload.relations.relations || []).find((relation) => relation
    && relation.type === type && relation.to === toId && (!source || relation.source === source));
}

function relationFrom(payload, type, fromId, source) {
  return (payload.relations.relations || []).find((relation) => relation
    && relation.type === type && relation.from === fromId && (!source || relation.source === source));
}

async function main() {
  const page = await waitPageLib(globalThis, '主文档');
  // 子帧：srcdoc 里加载同一份 page-lib（真实跨 frame DOM 证据）。
  const frameEl = document.getElementById('child-frame');
  frameEl.srcdoc = '<!doctype html><meta charset="utf-8"><title>child</title>'
    + '<body style="margin:0"><input id="child-input" type="text" aria-label="子帧输入">'
    + '<script src="/extension/injected/page-lib.js"><\/script></body>';
  const childWin = frameEl.contentWindow;
  const childPage = await waitPageLib(childWin, '子帧');

  // ---------- 1) 页面侧关系事实（图边） ----------
  const observed = await call(page, 'observe', { collectNodes: true, vom: true, force: true });
  expect(Array.isArray(observed.nodes) && observed.nodes.length > 0, 'observe 没有返回节点');
  expect(observed.graph && Array.isArray(observed.graph.edges), 'observe 没有返回页面关系图');
  const nameLabelKey = graphNodeByDomId(observed.graph, 'lbl-name').key;
  const nameInputKey = graphNodeByDomId(observed.graph, 'name-input').key;
  expect(hasEdge(observed.graph, 'html-for', nameLabelKey, nameInputKey), '页面图缺少 html-for 边（label[for]）');
  expect(hasEdge(observed.graph, 'label', graphNodeByDomId(observed.graph, 'lbl-email').key,
    graphNodeByDomId(observed.graph, 'email-input').key), '页面图缺少隐式 label 边');
  expect(hasEdge(observed.graph, 'tab-controls', graphNodeByDomId(observed.graph, 'tab-one').key,
    graphNodeByDomId(observed.graph, 'panel-one').key), '页面图缺少 tab-controls 边');
  expect(hasEdge(observed.graph, 'errormessage', graphNodeByDomId(observed.graph, 'err-invalid').key,
    graphNodeByDomId(observed.graph, 'invalid-input').key), '页面图缺少 errormessage 边（目标 → 控件）');
  const chainRootKey = graphNodeByDomId(observed.graph, 'chain-root').key;
  const chainMidKey = graphNodeByDomId(observed.graph, 'chain-mid').key;
  const chainInputKey = graphNodeByDomId(observed.graph, 'chain-input').key;
  expect(hasEdge(observed.graph, 'labelledby', chainMidKey, chainInputKey), '页面图缺少 labelledby 边（链第 1 跳）');
  expect(hasEdge(observed.graph, 'labelledby', chainRootKey, chainMidKey), '页面图缺少 labelledby 边（链第 2 跳）');

  // ---------- 2) payload：labels 链 / html-for / tab-controls / invalidates / describes ----------
  const payload = buildVomPayload({
    nodes: observed.nodes,
    graph: observed.graph,
    documentId: location.href,
    revision: observed.revision,
    compress: true,
  });
  expect(payload.relations.version === 3, '关系图版本=' + payload.relations.version);
  expect(payload.relations.kinds.includes('invalidates'), '关系类型缺少 invalidates');
  const nameInput = findNode(payload.nodes, 'textbox', '姓名');
  const emailInput = findNode(payload.nodes, 'textbox', '邮箱');
  const chainInput = findNode(payload.nodes, 'textbox', '昵称');
  const invalidInput = findNode(payload.nodes, 'textbox', '无效邮箱');
  const tabOne = findNode(payload.nodes, 'tab', '选项一');
  const logoLink = findNode(payload.nodes, 'link', '返回首页');
  const logoImg = findNode(payload.nodes, 'img', '返回首页');
  const titledBtn = findNode(payload.nodes, 'button', '保存');
  const errAlert = findNode(payload.nodes, 'alert', '请输入有效邮箱');
  const listbox = findNode(payload.nodes, 'listbox', '角色选项');
  const optionA = findNode(payload.nodes, 'option', '甲');
  const cellInput = findNode(payload.nodes, 'textbox', '单元格输入');

  const htmlFor = relationInto(payload, 'labels', nameInput.id, 'html-for');
  expect(Boolean(htmlFor), '缺少 <label for> 的 html-for labels 关系');
  expect(htmlFor.from !== htmlFor.to, 'html-for 关系端点不应相同');
  const implicit = relationInto(payload, 'labels', emailInput.id, 'label-for');
  expect(Boolean(implicit), '缺少隐式 label 的 label-for labels 关系');
  expect(implicit.sources.includes('label-for'), '隐式 label 来源=' + JSON.stringify(implicit.sources));
  const chainDirect = relationInto(payload, 'labels', chainInput.id, 'aria-labelledby');
  expect(Boolean(chainDirect), '缺少 aria-labelledby 直接关系');
  const chainRelation = relationInto(payload, 'labels', chainInput.id, 'aria-labelledby-chain');
  expect(Boolean(chainRelation), '缺少 aria-labelledby-chain 关系');
  expect(chainRelation.depth === 2, '链深度=' + chainRelation.depth);
  expect(chainRelation.confidence === 0.9, '链置信度=' + chainRelation.confidence);
  expect(Array.isArray(chainRelation.chain) && chainRelation.chain.length >= 2, '链证据缺少 chain 数组');
  const chainForNode = labelChainForNode(payload.relations, chainInput.id);
  expect(chainForNode.length === 2, 'labelChainForNode 长度=' + chainForNode.length);
  expect(chainForNode[1].depth === 2 && chainForNode[1].source === 'aria-labelledby-chain', 'labelChainForNode 链尾不对');

  const tabControls = relationFrom(payload, 'controls', tabOne.id, 'tab-controls');
  expect(Boolean(tabControls), '缺少 tab-controls controls 关系');
  expect(tabControls.confidence === 0.96, 'tab-controls 置信度=' + tabControls.confidence);
  const compositeOwning = relationFrom(payload, 'owns', listbox.id, 'composite-owner');
  expect(Boolean(compositeOwning), '缺少组合控件 owns 关系');
  expect(compositeOwning.to === optionA.id || (payload.relations.relations || []).some((relation) => relation.type === 'owns'
    && relation.source === 'composite-owner' && relation.from === listbox.id && relation.to === optionA.id), '组合控件 owns 未指向 option');
  expect(payload.relations.stats.compositeOwns >= 2, 'compositeOwns=' + payload.relations.stats.compositeOwns);

  const invalidates = relationInto(payload, 'invalidates', invalidInput.id, null);
  expect(Boolean(invalidates), '缺少 invalidates 关系');
  expect(invalidates.from === errAlert.id, 'invalidates 方向应为 错误消息 → 控件');
  expect(invalidates.sources.includes('aria-errormessage'), 'invalidates 来源=' + JSON.stringify(invalidates.sources));
  expect(invalidates.sources.includes('invalid-describedby'), 'invalid describedby 未合并：' + JSON.stringify(invalidates.sources));
  expect(invalidInput.invalid === true, 'payload 未标记 invalid 节点');
  expect(invalidates.confidence >= 0.9, 'invalidates 置信度=' + invalidates.confidence);

  const describedBy = relationInto(payload, 'describes', invalidInput.id, 'aria-describedby');
  expect(Boolean(describedBy), '缺少 aria-describedby describes 关系');
  expect(describedBy.from === errAlert.id, 'describes 方向应为 描述目标 → 被描述节点');
  const altText = relationFrom(payload, 'describes', logoImg.id, 'alt-text');
  expect(Boolean(altText), '缺少 alt-text describes 关系');
  expect(altText.to === logoLink.id, 'alt 应描述命名它的链接：' + altText.to + ' != ' + logoLink.id);
  expect(altText.text === '返回首页', 'alt 描述文本=' + altText.text);
  const titleSelf = relationFrom(payload, 'describes', titledBtn.id, 'title-attribute');
  expect(Boolean(titleSelf) && titleSelf.self === true && titleSelf.to === titledBtn.id, '缺少 title 自描述');
  expect(titleSelf.text === '保存当前草稿', 'title 描述文本=' + titleSelf.text);
  expect(payload.relations.stats.selfDescriptions >= 1, 'selfDescriptions=' + payload.relations.stats.selfDescriptions);
  expect(payload.relations.stats.invalidates >= 1, 'invalidates 统计=' + payload.relations.stats.invalidates);
  expect(payload.relations.relations.every((relation) => relation.confidence > 0 && relation.confidence <= 1), '关系置信度越界');
  expect(payload.relations.relations.every((relation) => typeof relation.source === 'string' && relation.source.length > 0), '关系缺少 source');
  expect(typeof payload.relations.relations[0].fromRole === 'string' || payload.relations.relations[0].fromRole === null, '关系缺少 fromRole');

  // ---------- 3) 语义上下文：landmark / 表单 / 表格分组 ----------
  const context = payload.context;
  expect(context && Array.isArray(context.groups), 'payload 缺少 context 分组');
  expect(context.stats.landmarks >= 1, 'landmark 分组数=' + context.stats.landmarks);
  expect(context.stats.forms >= 1, '表单分组数=' + context.stats.forms);
  expect(context.stats.tables >= 1, '表格分组数=' + context.stats.tables);
  const mainGroup = context.groups.find((group) => group.kind === 'landmark');
  const formGroup = context.groups.find((group) => group.kind === 'form');
  const tableGroup = context.groups.find((group) => group.kind === 'table');
  expect(mainGroup && mainGroup.name === '主区域', 'landmark 组名称=' + (mainGroup && mainGroup.name));
  expect(formGroup.members >= 2, '表单组成员数=' + formGroup.members);
  expect(tableGroup.table && tableGroup.table.headerCount === 2, '表格表头数=' + (tableGroup.table && tableGroup.table.headerCount));
  expect(tableGroup.table.headers.map((header) => header.name).join(',') === '名称,数量', '表头名称=' + JSON.stringify(tableGroup.table.headers));
  expect(tableGroup.table.caption === '订单表', '表格题注=' + tableGroup.table.caption);
  expect(tableGroup.table.rowCount === 1, '表格数据行=' + tableGroup.table.rowCount);
  expect(tableGroup.table.source === 'page-facts', '表格事实来源=' + tableGroup.table.source);
  const cellContext = context.contexts.find((item) => item.node === cellInput.id);
  expect(cellContext && cellContext.kinds.includes('table'), '单元格节点缺少表格上下文');
  const nameContext = context.contexts.find((item) => item.node === nameInput.id);
  expect(nameContext && nameContext.kinds.includes('form') && nameContext.kinds.includes('landmark'), '姓名输入上下文=' + JSON.stringify(nameContext && nameContext.kinds));
  expect(tableGroup.parentId != null || formGroup.parentId != null, '组之间缺少父组关系');
  expect(context.stats.depth >= 1, '上下文最大深度=' + context.stats.depth);

  // ---------- 4) 语义压缩：按组折叠 + report ----------
  const compression = payload.compression;
  expect(compression && compression.report, 'payload 缺少 compression 报告');
  expect(compression.folded.length >= 1, '没有折叠任何组');
  expect(compression.folded.every((fold) => fold.count >= 2), '折叠组应至少 2 个成员');
  const formFold = compression.folded.find((fold) => fold.groupKind === 'form');
  expect(Boolean(formFold), '表单组未折叠');
  expect(formFold.name.includes('×'), '折叠 summary 名称=' + formFold.name);
  expect(formFold.sampleNames.length >= 1, '折叠 summary 缺少样例名');
  expect(formFold.tokensSaved > 0, '折叠 token 节省=' + formFold.tokensSaved);
  expect(compression.report.after.nodes < compression.report.before.nodes, '压缩后节点数未下降');
  expect(compression.report.saved.tokens > 0, '压缩 token 节省=' + compression.report.saved.tokens);
  expect(/folds=\d+/.test(summarizeVomCompression(compression)), '压缩摘要格式不对');
  const direct = compressVomByRelations({ nodes: payload.nodes, relations: payload.relations, context: payload.context });
  expect(direct.report.folds === compression.report.folds, '直接调用与 payload 内压缩结果不一致');

  // ---------- 5) 关系查询：kind / role / name + 分页 + 摘要 ----------
  const byKind = queryVomRelations(payload.relations, { kind: 'labels', limit: 50 }, payload.nodes);
  expect(byKind.page.total >= 3, 'labels 关系数=' + byKind.page.total);
  expect(byKind.items.every((item) => item.type === 'labels'), 'kind 过滤混入其他类型');
  expect(byKind.summary.byType.labels >= 3, '摘要 byType.labels=' + byKind.summary.byType.labels);
  const byRole = queryVomRelations(payload.relations, { role: 'textbox', limit: 50 }, payload.nodes);
  expect(byRole.page.total >= 2, 'textbox 角色关系数=' + byRole.page.total);
  const byName = queryVomRelations(payload.relations, { name: '姓名', limit: 50 }, payload.nodes);
  expect(byName.page.total >= 1, 'name=姓名 关系数=' + byName.page.total);
  const paged = queryVomRelations(payload.relations, { limit: 2 }, payload.nodes);
  expect(paged.page.returned === 2 && paged.page.hasMore === true, '分页未生效：' + JSON.stringify(paged.page));
  expect(paged.page.nextOffset === 2, 'nextOffset=' + paged.page.nextOffset);
  expect(/relations 1-2\//.test(summarizeRelationQuery(paged)), '查询摘要格式不对：' + summarizeRelationQuery(paged));
  const crossQuery = queryVomRelations(payload.relations, { crossFrame: true }, payload.nodes);
  expect(crossQuery.page.total === 0, '单文档关系不应包含跨 frame 项');

  // ---------- 6) 跨 frame：frame 作为节点参与关系 ----------
  const childObserved = await call(childPage, 'observe', { collectNodes: true, vom: true, force: true });
  expect(Array.isArray(childObserved.nodes) && childObserved.nodes.length > 0, '子帧 observe 没有返回节点');
  const iframeGraphNode = (observed.graph.nodes || []).find((node) => node && node.tag === 'iframe' && Number.isInteger(node.frameIndex));
  expect(Boolean(iframeGraphNode), '主文档页面图缺少 iframe 节点（frameIndex）');
  const frameVom = buildFrameVomGraphs([
    {
      frameId: 0,
      url: observed.url || location.href,
      parentFrameId: null,
      graph: observed.graph,
      nodes: observed.nodes,
      iframeOwners: [{ frameIndex: iframeGraphNode.frameIndex, childFrameId: 1, childUrl: childObserved.url || 'about:srcdoc' }],
    },
    {
      frameId: 1,
      url: childObserved.url || 'about:srcdoc',
      parentFrameId: 0,
      graph: childObserved.graph,
      nodes: childObserved.nodes,
    },
  ], { childFrames: [{ frameId: 0, parentFrameId: null }, { frameId: 1, parentFrameId: 0, url: childObserved.url || 'about:srcdoc' }] });
  expect(frameVom.summary.count === 2, 'frame 子图数=' + frameVom.summary.count);
  // frame-vom 子图本身不带 parentFrameId（帧树信息在 frame 列表上），这里按真实帧树补回。
  const parentFrameIdOf = new Map([[0, null], [1, 0]]);
  const frameInputs = frameVom.graphs.map((graph) => ({
    frameId: graph.frameId,
    url: graph.url,
    parentFrameId: parentFrameIdOf.has(graph.frameId) ? parentFrameIdOf.get(graph.frameId) : null,
    vom: graph,
  }));
  const cross = buildCrossFrameRelations(frameInputs);
  expect(cross.frames.length >= 2, 'frame 节点数=' + cross.frames.length);
  const frameIds = cross.frames.map((frame) => frame.frameId);
  expect(frameIds.includes(0) && frameIds.includes(1), 'frame 节点缺少 0/1：' + JSON.stringify(frameIds));
  expect(cross.frames.find((frame) => frame.frameId === 1).parentFrameId === 0, '子帧 parentFrameId 不对');
  expect(cross.relations.length >= 3, '跨 frame 关系数=' + cross.relations.length);
  expect(cross.stats.bySource['frame-edge'] >= 1, '缺少 frame-edge 关系');
  expect(cross.stats.bySource['parent-frame'] === 1, '缺少 parent-frame 关系');
  expect(cross.stats.bySource['frame-owner'] >= 1, '缺少 frame-owner 关系');
  expect(cross.stats.crossFrame >= 3, 'crossFrame=' + cross.stats.crossFrame);
  expect(cross.relations.every((relation) => relation.frame === true && relation.confidence > 0), '跨 frame 关系形状不对');
  expect(/frames=2/.test(summarizeCrossFrameRelations(cross)), '跨 frame 摘要格式不对：' + summarizeCrossFrameRelations(cross));
  // 关系图 v3 也能直接吃 frames（frame 节点参与关系）。
  const frameRelationGraph = buildVomRelationGraph({ frames: frameInputs });
  expect(frameRelationGraph.frames.length >= 2, '关系图 frames 为空');
  expect(frameRelationGraph.stats.frameRelations === cross.relations.length, '关系图合并的跨 frame 关系数不一致');
  expect(frameRelationGraph.relations.some((relation) => relation.frame === true && relation.type === 'contains'), '关系图缺少 frame contains 关系');

  return passed;
}

main().then((count) => {
  document.title = 'VOM_RELATIONS_OK:' + count;
}).catch((error) => {
  const message = String((error && error.message) || error).replace(/\s+/g, ' ').slice(0, 160);
  document.title = 'VOM_RELATIONS_FAIL:' + message;
});
