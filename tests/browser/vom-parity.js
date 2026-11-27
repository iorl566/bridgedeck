// 真实 Chromium DOM 证据：page-lib row facts + 六阶段漏斗 + 统一可见性 gate + token 预算 + 关系图 v3。
// 成功 title = VOM_PARITY_OK:<断言数>，失败 title = VOM_PARITY_FAIL:<message>。
import {
  ROW_ANCHOR_FIELDS,
  normalizeRowAnchor,
  rowAnchorChanged,
  summarizeRowAnchors,
} from '/extension/src/lib/vom-rows.js';
import {
  VOM_CAPTURE_STAGES,
  buildCaptureReport,
  captureStagesFromPageStages,
  summarizeCaptureReport,
} from '/extension/src/lib/vom-capture.js';
import { buildVomBudgetReport, summarizeVomBudget } from '/extension/src/lib/vom-budget.js';
import { applyVisibilityGate, evaluateVisibility, resolveOcclusion, summarizeVisibilityGate } from '/extension/src/lib/vom-visibility.js';
import { buildVomPayload } from '/extension/src/lib/vom-payload.js';
import { classifyVirtualRow } from '/extension/src/lib/virtual-row-guard.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const fail = (message) => { throw new Error(message); };
const expect = (value, message) => {
  if (!value) fail(message);
  passed += 1;
};

function pageLib() {
  const lib = globalThis.__BB_PAGE__;
  if (!lib || typeof lib.handle !== 'function') fail('page-lib 未加载');
  return lib;
}

async function call(name, args) {
  const reply = await pageLib().handle(name, args || {});
  if (!reply || reply.ok !== true) {
    throw new Error(name + ' 失败：' + JSON.stringify((reply && reply.error) || reply));
  }
  return reply.result;
}

function findNode(nodes, domId) {
  const node = (Array.isArray(nodes) ? nodes : []).find((item) => item && item.id === domId);
  if (!node) {
    const ids = (Array.isArray(nodes) ? nodes : []).map((item) => item && item.id).filter(Boolean).slice(0, 12);
    fail('观察结果缺少节点 #' + domId + '；已有 id=' + JSON.stringify(ids));
  }
  return node;
}

/** 用真实 computed style 造一份页面侧事实（display/opacity 的元素不会被树观察收进 nodes）。 */
function styleFacts(domId, extra = {}) {
  const el = document.getElementById(domId);
  if (!el) fail('夹具缺少元素 #' + domId);
  const style = getComputedStyle(el);
  return {
    display: style.display,
    styleVisibility: style.visibility,
    styleOpacity: style.opacity,
    pointerEvents: style.pointerEvents,
    ...extra,
  };
}

async function main() {
  for (let index = 0; index < 200; index += 1) {
    if (globalThis.__BB_PAGE__ && typeof globalThis.__BB_PAGE__.handle === 'function') break;
    await sleep(20);
  }
  pageLib();
  const vlist = document.getElementById('vlist');

  // ---------- 1) observe 产出 row facts（页面侧 anchor → payload 透传契约） ----------
  const observed = await call('observe', { collectNodes: true, vom: true, force: true });
  const nodes = Array.isArray(observed.nodes) ? observed.nodes : [];
  expect(nodes.length > 0, 'observe 没有返回节点');
  expect(observed.graph && Array.isArray(observed.graph.edges), 'observe 没有返回页面关系图');
  const input12 = findNode(nodes, 'vr-input-12');
  const rawAnchor = normalizeRowAnchor(input12.anchor);
  expect(rawAnchor, '虚拟行节点缺少 anchor');
  for (const field of ROW_ANCHOR_FIELDS) expect(field in rawAnchor, 'anchor 缺少契约字段 ' + field);
  expect(rawAnchor.ariaRowIndex === 12, 'ariaRowIndex=' + rawAnchor.ariaRowIndex);
  expect(rawAnchor.dataIndex === 12, 'dataIndex=' + rawAnchor.dataIndex);
  expect(rawAnchor.rowKey === 'row-12', 'rowKey=' + rawAnchor.rowKey);
  expect(/第 12 行文本/.test(String(rawAnchor.rowText)), 'rowText=' + rawAnchor.rowText);
  expect(rawAnchor.containerScrollTop === 0, 'containerScrollTop=' + rawAnchor.containerScrollTop);
  expect(/matrix|translate/.test(String(rawAnchor.transform)), 'transform=' + rawAnchor.transform);
  expect(rawAnchor.recycled === false, '首次观察 recycled 应为 false');
  expect(rawAnchor.role === 'row', 'anchor.role=' + rawAnchor.role);
  expect(rawAnchor.tag === 'div', 'anchor.tag=' + rawAnchor.tag);
  expect(typeof input12.anchor.recycled === 'boolean', '节点 anchor.recycled 不是布尔');

  // ---------- 2) row-anchor 只读命令（W2 消费契约） ----------
  const probe12 = await call('row-anchor', { ref: input12.ref });
  expect(probe12.anchor && probe12.anchor.ariaRowIndex === 12, 'row-anchor(ref) 未返回行事实');
  expect(probe12.anchor.rowKey === 'row-12', 'row-anchor rowKey 不一致');
  const probe11 = await call('row-anchor', { selector: '#vr-input-11' });
  expect(probe11.anchor && probe11.anchor.ariaRowIndex === 11, 'row-anchor(selector) 未返回行事实');
  const staticProbe = await call('row-anchor', { selector: '#static-input' });
  expect(staticProbe.anchor === null, '静态行不应产出 anchor（payload 体积保护）');
  const noRowProbe = await call('row-anchor', { selector: '#hid-btn' });
  expect(noRowProbe.anchor === null, '非行元素应返回 anchor:null');
  expect(typeof noRowProbe.revision === 'number', 'row-anchor 应带 revision');

  // ---------- 3) 六阶段捕获漏斗（页面计数器 → 统一阶段） ----------
  const pageReport = buildCaptureReport(captureStagesFromPageStages(observed.stages || {}));
  expect(pageReport.stages.map((stage) => stage.name).join(',') === VOM_CAPTURE_STAGES.join(','), '阶段名/顺序不对');
  expect(pageReport.stages.length === 6, '阶段数=' + pageReport.stages.length);
  expect(pageReport.totals.collected > 0, '页面 collected=0');
  expect(pageReport.totals.emitted > 0, '页面 emitted=0');
  expect(pageReport.stages.every((stage) => Number.isFinite(stage.ms) && stage.ms >= 0), '阶段耗时缺失');
  expect(pageReport.stages[1].output <= pageReport.stages[1].input, 'resolve output 大于 input');
  expect(pageReport.stages[5].output <= pageReport.stages[5].input, 'emit output 大于 input');
  const hiddenReason = pageReport.stages[1].dropReasons.find((item) => item.reason === 'hidden');
  expect(hiddenReason && hiddenReason.count >= 1, 'display:none 元素应计入 hidden 丢弃原因');
  expect(/collect \d+→\d+/.test(summarizeCaptureReport(pageReport)), '漏斗摘要格式不对');

  // ---------- 4) 统一可见性/遮挡 gate（真实页面事实） ----------
  const peNode = findNode(nodes, 'pe-btn');
  expect(peNode.pointerEvents === 'none', '页面节点未带 pointerEvents=none');
  const peVerdict = evaluateVisibility(peNode);
  expect(peVerdict.paintable === true && peVerdict.interactive === false, 'pointer-events:none 判定不对');
  expect(peVerdict.reason === 'pointer-events-none', 'pointer-events 原因=' + peVerdict.reason);
  const offNode = findNode(nodes, 'off-btn');
  const offVerdict = evaluateVisibility(offNode);
  expect(offVerdict.visible === false, '屏外元素被判可见');
  expect(offVerdict.reason === 'offscreen', '屏外原因=' + offVerdict.reason);
  const clipNode = findNode(nodes, 'clip-btn');
  expect(clipNode.clipped === true, '页面侧未标记 overflow 裁剪');
  const clipVerdict = evaluateVisibility(clipNode);
  expect(clipVerdict.visible === false && clipVerdict.reason === 'clipped', '裁剪判定=' + clipVerdict.reason);
  const hidFacts = styleFacts('hid-btn');
  expect(hidFacts.display === 'none', '夹具 display:none 失效');
  expect(evaluateVisibility(hidFacts).paintable === false, 'display:none 未判不可绘制');
  expect(evaluateVisibility(hidFacts).reason === 'paint-hidden', 'display:none 原因不对');
  const opaFacts = styleFacts('opa-btn');
  expect(Number(opaFacts.styleOpacity) === 0, '夹具 opacity:0 失效');
  expect(evaluateVisibility(opaFacts).reason === 'paint-hidden', 'opacity:0 原因不对');
  const behindNode = findNode(nodes, 'behind-btn');
  expect(behindNode.hitTest === 'blocked', '遮挡层未让页面 hit-test 判 blocked，hitTest=' + behindNode.hitTest);
  const occlusion = resolveOcclusion(
    nodes.map((node) => ({ id: node.id, ref: node.ref, role: node.role, tag: node.tag, bounds: node.rect, paintOrder: node.paintOrder, hitTest: node.hitTest })),
    { layers: [{ role: 'dialog', blocking: true, layerKind: 'top-layer', bounds: { x: 0, y: 0, width: 900, height: 700 } }] },
  );
  expect(Boolean(occlusion.byId.get('behind-btn')), '几何遮挡未识别对话框覆盖');
  const behindVerdict = evaluateVisibility(behindNode, { occluder: occlusion.byId.get('behind-btn') || null });
  expect(behindVerdict.interactive === false && behindVerdict.occluded === true, '遮挡节点仍被判可交互');
  const gate = applyVisibilityGate(nodes, { mode: 'interactable' });
  expect(gate.counts.input === nodes.length, 'gate input 不等于节点数');
  expect(gate.kept < gate.counts.input, 'interactable gate 未丢弃任何节点');
  expect(gate.dropped.every((item) => typeof item.reason === 'string'), 'gate 丢弃项缺少原因');
  const gateSummary = summarizeVisibilityGate(gate);
  expect(gateSummary.mode === 'interactable' && gateSummary.byReason.occluded >= 1, 'gate 汇总缺少 occluded');

  // ---------- 5) token 预算强制与裁剪报告 ----------
  const budget = buildVomBudgetReport({ nodes, nodeBudget: { maxNodes: 6 }, top: 4 });
  expect(budget.used.nodes === 4, 'budget used.nodes=' + budget.used.nodes);
  expect(budget.trimmed.nodes > 0, 'budget 未记录裁剪节点');
  expect(budget.reason === 'node-limit', 'budget reason=' + budget.reason);
  expect(typeof budget.trimmed.groups === 'number', 'budget trimmed.groups 缺失');
  expect(budget.budget.nodes === 6, 'budget nodes=' + budget.budget.nodes);
  expect(/budget nodes=6/.test(summarizeVomBudget(budget)), '预算摘要格式不对');
  expect(budget.nodes.length === 4, 'budget 输出节点数不对');

  // ---------- 6) 语义关系图 v3 + 组上下文 ----------
  const payload = buildVomPayload({
    nodes,
    layers: [{ level: 'L2', role: 'dialog', name: '遮挡对话框', coverage: 0.8, bounds: { x: 0, y: 0, width: 900, height: 700 } }],
    visual: [],
    issues: [],
    documentId: location.href,
    revision: observed.revision,
    graph: observed.graph,
  });
  expect(payload.relations.version === 3, '关系图版本=' + payload.relations.version);
  expect(payload.relations.relations.length > 0, '关系图为空');
  expect(payload.relations.relations.every((relation) => relation.confidence > 0 && relation.confidence <= 1), '关系 confidence 越界');
  expect(payload.relations.relations.every((relation) => typeof relation.source === 'string' && relation.source.length > 0), '关系缺少来源');
  const relationTypes = new Set(payload.relations.relations.map((relation) => relation.type));
  expect(relationTypes.has('labels'), '关系图缺少 labels 边');
  expect(relationTypes.has('controls'), '关系图缺少 controls 边');
  expect(payload.relations.groups.length >= 2, '关系图组数=' + payload.relations.groups.length);
  expect(payload.relations.contexts.length >= 1, '关系图缺少组上下文');
  expect(payload.relations.stats.contextGroups >= 1, 'contextGroups=0');
  expect(payload.relations.stats.averageConfidence > 0, 'averageConfidence=0');

  // ---------- 7) payload 节点：anchor 与 visibility 单点判定 ----------
  const payloadNode = payload.nodes.find((node) => node.ref === input12.ref);
  expect(payloadNode && payloadNode.anchor, 'payload 节点缺少 anchor');
  for (const field of ROW_ANCHOR_FIELDS) expect(field in payloadNode.anchor, 'payload anchor 缺少 ' + field);
  expect(payloadNode.anchor.ariaRowIndex === 12, 'payload anchor 行号错');
  expect(payloadNode.visibility && typeof payloadNode.visibility.interactive === 'boolean', 'payload 缺少 visibility');
  expect(payload.visibility.input === payload.nodes.length, 'payload.visibility 汇总 input 错');
  expect(payload.stages.map((stage) => stage.stage).join(',') === 'facts,identity,relations,layout,paint,interact', 'payload.stages 既有字段被破坏');
  const anchorSummary = summarizeRowAnchors(nodes);
  expect(anchorSummary.anchored >= 2, 'rowAnchors 汇总 anchored=' + anchorSummary.anchored);
  expect(anchorSummary.withRowKey >= 2, 'rowAnchors 汇总 withRowKey=' + anchorSummary.withRowKey);

  // ---------- 8) 滚动位移：动作前 row-anchor 与观察 anchor 比对（fail-closed） ----------
  vlist.scrollTop = 40;
  expect(vlist.scrollTop > 0, '夹具虚拟列表不可滚动');
  const scrolled = await call('row-anchor', { ref: input12.ref });
  expect(scrolled.anchor && scrolled.anchor.containerScrollTop === 40, 'scrollTop=' + (scrolled.anchor && scrolled.anchor.containerScrollTop));
  expect(rowAnchorChanged(rawAnchor, scrolled.anchor) === true, '滚动位移未判为行事实变化');
  const scrolledClass = classifyVirtualRow({ ...scrolled.anchor, previousScrollTop: rawAnchor.containerScrollTop });
  expect(scrolledClass.reason === 'scroll-shifted', '滚动位移分类=' + scrolledClass.reason);
  vlist.scrollTop = 0;

  // ---------- 9) 行回收：同 ref 行文本变化 → recycled + 守卫拒绝 ----------
  const row12 = document.getElementById('vr-12');
  row12.appendChild(document.createTextNode('（已更新）'));
  const recycledProbe = await call('row-anchor', { ref: input12.ref });
  expect(recycledProbe.anchor && recycledProbe.anchor.recycled === true, '行文本变化后 row-anchor 未标 recycled');
  expect(/已更新/.test(String(recycledProbe.anchor.rowText)), 'row-anchor 未读到新行文本');
  const recycledClass = classifyVirtualRow(recycledProbe.anchor);
  expect(recycledClass.stable === false, '回收行被判稳定');
  expect(recycledClass.reason === 'row-recycled', '回收原因=' + recycledClass.reason);

  const observed2 = await call('observe', { collectNodes: true, vom: true, force: true });
  const input12b = findNode(observed2.nodes, 'vr-input-12');
  expect(input12b.anchor && input12b.anchor.recycled === true, '重新观察后节点 anchor 未标 recycled');
  expect(/已更新/.test(String(input12b.anchor.rowText)), '重新观察后 rowText 未更新');
  const payload2 = buildVomPayload({ nodes: observed2.nodes, graph: observed2.graph, documentId: location.href, revision: observed2.revision });
  const payloadNode2 = payload2.nodes.find((node) => node.ref === input12b.ref);
  expect(payloadNode2 && payloadNode2.visibility.reasons.includes('recycled-row'), 'payload 未把回收行判为 recycled-row');
  expect(payloadNode2.visibility.interactive === false, 'payload 把回收行判为可交互');
  const afterObserve = await call('row-anchor', { ref: input12b.ref });
  expect(afterObserve.anchor && afterObserve.anchor.recycled === false, '观察后同一行不应持续标 recycled');

  return passed;
}

main().then((count) => {
  document.title = 'VOM_PARITY_OK:' + count;
}).catch((error) => {
  const message = String((error && error.message) || error).replace(/\s+/g, ' ').slice(0, 120);
  document.title = 'VOM_PARITY_FAIL:' + message;
});
