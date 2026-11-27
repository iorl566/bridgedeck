// observe() 端到端管线（chrome stub + 假页面库）：六阶段 funnel / 预算 / 统一 gate / row facts / 关系图 v3
// 全部从 observe 输出可读，证明新模块不是库内自嗨，而是被运行时主路径消费。
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {} });

function fakeRowAnchor(overrides = {}) {
  return {
    ariaRowIndex: 3,
    dataIndex: 3,
    transform: 'matrix(1, 0, 0, 1, 0, 0)',
    rowKey: 'row-3',
    rowText: '第三行文本',
    containerScrollTop: 0,
    recycled: false,
    role: 'row',
    tag: 'tr',
    ...overrides,
  };
}

const pageNodes = [
  {
    ref: '@e1', vomId: 'v1', graphKey: 'n1', tag: 'button', id: 'save', role: 'button', name: '保存',
    clickable: true, hitTest: 'self', rect: { x: 10, y: 10, w: 80, h: 30 }, inViewport: true,
    pointerEvents: 'auto', paintOrder: 0, ancestors: [], labels: [], visible: true, ariaHidden: false,
    anchor: fakeRowAnchor(),
  },
  {
    ref: '@e2', vomId: 'v2', graphKey: 'n2', tag: 'tr', id: 'row-3', role: 'row', name: '',
    clickable: false, hitTest: 'self', rect: { x: 0, y: 0, w: 100, h: 40 }, inViewport: true,
    pointerEvents: 'auto', paintOrder: 1, ancestors: [], labels: [], visible: true, ariaHidden: false,
    anchor: fakeRowAnchor(),
  },
  {
    ref: '@e3', vomId: 'v3', graphKey: 'n3', tag: 'button', id: 'hidden', role: 'button', name: '隐藏按钮',
    clickable: true, hitTest: 'self', rect: { x: 10, y: 60, w: 80, h: 30 }, inViewport: true,
    pointerEvents: 'auto', paintOrder: 2, ancestors: [], labels: [], visible: false, display: 'none',
    paintVisible: false, hiddenReason: 'display-none',
  },
  {
    ref: '@e4', vomId: 'v4', graphKey: 'n4', tag: 'button', id: 'behind', role: 'button', name: '被遮挡',
    clickable: false, hitTest: 'blocked', rect: { x: 10, y: 100, w: 80, h: 30 }, inViewport: true,
    pointerEvents: 'auto', paintOrder: 3, ancestors: [], labels: [], visible: true, ariaHidden: false,
  },
];

const baseObserve = {
  url: 'https://example.test/form',
  title: '表单页',
  observation: '- button "保存" [@e1]\n- row "第三行文本" [@e2]',
  refs: 2,
  revision: 5,
  nodes: pageNodes,
  graph: {
    nodes: [
      { key: 'n1', ref: '@e1', tag: 'button', role: 'button', domId: 'save', parentKey: 'n9' },
      { key: 'n2', ref: '@e2', tag: 'tr', role: 'row', domId: 'row-3', parentKey: 'n9' },
      { key: 'n9', ref: null, tag: 'form', role: 'form', domId: 'form1', parentKey: null },
    ],
    edges: [
      { type: 'child', from: 'n9', to: 'n1' },
      { type: 'form', from: 'n9', to: 'n1' },
    ],
    truncated: false,
  },
  stages: {
    visited: 10, hidden: 2, stealth: 0, skippedTag: 1, emitted: 4, refs: 2, tokens: 40,
    ms: { walk: 2.2, visibility: 1.1, stealth: 0 }, truncated: false, elapsedMs: 9,
  },
};

const deepObserve = {
  nodes: [
    {
      id: 'vom-deep:0', ref: '@e1', tag: 'button', role: 'button', name: '保存', interactive: true,
      rect: { x: 10, y: 10, width: 80, height: 30 }, anchor: fakeRowAnchor(),
    },
  ],
  lines: ['- button "保存" [interactive] @10,10'],
  stages: { collected: 4, skippedTag: 0, hidden: 1, stealth: 0, empty: 0, deduped: 0, emitted: 1, tokens: 20, truncated: false },
  revision: 5,
};

const results = {
  observe: baseObserve,
  'deep-vom': deepObserve,
  'visual-scan': { candidates: [], viewport: null, layers: [] },
  'visual-refs': { refs: [] },
  'clear-vom-markers': { ok: true },
};

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.1.2' }),
    onMessage: listener(),
    onConnect: listener(),
    sendMessage: async () => ({}),
    getURL: (path) => 'chrome-extension://stub/' + path,
    lastError: null,
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: listener(),
  },
  tabs: {
    onRemoved: listener(),
    onUpdated: listener(),
    get: async (tabId) => ({ id: tabId, url: 'https://example.test/form' }),
    query: async () => [],
  },
  debugger: {
    onEvent: listener(),
    onDetach: listener(),
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({}),
  },
  scripting: {
    executeScript: async (options) => {
      const args = Array.isArray(options && options.args) ? options.args : [];
      const name = args[0];
      if (!(name in results)) throw new Error('测试 stub 未提供页面命令：' + String(name));
      return [{ result: { ok: true, result: results[name] } }];
    },
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
  alarms: { create: async () => {}, onAlarm: listener() },
  windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1 }) },
  offscreen: { hasDocument: async () => false, createDocument: async () => {} },
  action: { openPopup: async () => {} },
  permissions: { contains: async () => true },
};
globalThis.WebSocket = class {
  constructor() { this.readyState = 0; }
  send() {}
  close() {}
};

const { observe } = await import('../../extension/src/tools/observation.js');

test('observe --vom：六阶段 funnel + 预算裁剪 + gate + row facts 全部进入输出', async () => {
  const result = await observe({
    tabId: 7,
    vom: true,
    vomBillingModel: 'cjk-heuristic-v2',
    vomExcludeHidden: true,
    vomSemanticMaxGroups: 2,
    vomMaxNodes: 2,
    force: true,
  });

  // 1) 六阶段捕获漏斗（扩展侧，真实计时）
  assert.ok(result.vomCapture, '缺少 vomCapture');
  assert.equal(result.vomCapture.stages.length, 6);
  assert.deepEqual(result.vomCapture.stages.map((stage) => stage.name), ['collect', 'resolve', 'filter', 'enrich', 'rank', 'emit']);
  for (const stage of result.vomCapture.stages) {
    assert.equal(typeof stage.input, 'number');
    assert.equal(typeof stage.output, 'number');
    assert.equal(typeof stage.dropped, 'number');
    assert.ok(Array.isArray(stage.dropReasons));
    assert.equal(typeof stage.ms, 'number');
  }
  assert.equal(result.vomCapture.stages[0].input, 10, 'collect 应取页面 collected/visited');
  assert.equal(result.vomCapture.stages[0].output, 4, 'collect output 应为页面返回节点数');
  assert.equal(result.vomCapture.stages[1].input, 4);
  assert.ok(result.vomCaptureText.includes('collect'), '缺少漏斗摘要文本');
  // 页面漏斗 + 扩展漏斗拼成同一条诊断链
  assert.ok(result.vomCaptureChain, '缺少 vomCaptureChain');
  assert.deepEqual(result.vomCaptureChain.segments, ['page', 'extension']);
  assert.equal(result.vomCaptureChain.page.collected, 10);
  // extension 段从页面 collected 起算（页面自身计数在 page 段，链只做拼接展示）。
  assert.equal(result.vomCaptureChain.extension.collected, 10);
  assert.equal(result.vomCaptureChain.extension.stages[0].output, 4);
  assert.ok(result.vomFunnel && result.vomFunnel.stages.length === 6, '既有 vomFunnel 未带六阶段');

  // 2) filter 阶段确实丢弃了 display:none 节点并给出原因
  const filterStage = result.vomCapture.stages.find((stage) => stage.name === 'filter');
  assert.ok(filterStage.input > filterStage.output, 'filter 未丢弃任何节点');
  const paintReason = filterStage.dropReasons.find((item) => item.reason === 'paint-hidden');
  assert.ok(paintReason && paintReason.count >= 1, 'filter 未记录 paint-hidden 原因');
  // 语义组预算路径被消费（组数上限 2）
  assert.ok(result.vomWeights.budgetPlan.semanticGroups !== null, 'semantic 组预算未执行');

  // 3) 预算强制与报告形状 {budget,used,trimmed,reason}
  assert.ok(result.vomBudget, '缺少 vomBudget');
  assert.deepEqual(result.vomBudget.budget, { nodes: 2, tokens: 0 });
  assert.equal(result.vomBudget.used.nodes, 2);
  assert.ok(result.vomBudget.trimmed.nodes >= 1);
  assert.equal(result.vomBudget.reason, 'node-limit');
  assert.equal(typeof result.vomBudget.trimmed.groups, 'number');
  assert.equal(result.nodes.length, 2, '输出节点数未按预算裁剪');
  assert.equal(result.vomWeights.budgetPlan.budgetReason, 'node-limit');

  // 4) 统一 visibility gate 汇总（final payload 节点 + 过滤 gate）
  assert.ok(result.vomVisibility, '缺少 vomVisibility');
  assert.equal(result.vomVisibility.input, result.nodes.length);
  assert.ok(result.vomVisibility.byReason, 'vomVisibility 缺少 byReason');
  assert.ok(result.visibilityGate, '缺少过滤阶段 visibilityGate');
  assert.equal(result.visibilityGate.mode, 'paintable');
  assert.ok(result.visibilityGate.byReason['paint-hidden'] >= 1);

  // 5) row facts 透传（页面 anchor → observe nodes / payload）
  assert.ok(result.rowAnchors, '缺少 rowAnchors 汇总');
  assert.ok(result.rowAnchors.anchored >= 1, 'rowAnchors.anchored=' + result.rowAnchors.anchored);
  assert.equal(result.rowAnchors.recycled, 0);
  const savedNode = result.nodes.find((node) => node.ref === '@e1');
  assert.ok(savedNode && savedNode.anchor, 'observe 节点缺少 anchor');
  assert.equal(savedNode.anchor.ariaRowIndex, 3);
  assert.equal(savedNode.anchor.rowKey, 'row-3');
  const payloadSaved = result.vom.nodes.find((node) => node.ref === '@e1');
  assert.ok(payloadSaved.anchor && payloadSaved.anchor.rowText === '第三行文本', 'payload 未透传 anchor');
  assert.ok(payloadSaved.visibility, 'payload 节点缺少 visibility');
  const hiddenPayload = result.vom.nodes.find((node) => node.ref === '@e3');
  assert.equal(hiddenPayload, undefined, '--vom-exclude-hidden 后隐藏节点仍出现在 payload');

  // 6) 关系图 v3（payload 与顶层输出）
  assert.equal(result.relations.version, 3);
  assert.ok(Array.isArray(result.relations.relations));
  assert.ok(result.relations.relations.length >= 1, '关系图为空');
  assert.ok(result.relations.relations.every((relation) => relation.confidence > 0 && typeof relation.source === 'string'));
  assert.equal(result.vom.relations.version, 3);
  assert.ok(result.vom.capture && result.vom.capture.stages.length === 6, 'payload 未带 capture 报告');
  // 既有输出字段不回退：nodeCount 仍是观察到的页面节点数（预算裁剪是 payload/nodes 层）。
  assert.equal(result.vom.stages.map((stage) => stage.stage).join(','), 'facts,identity,relations,layout,paint,interact');
  assert.equal(result.nodeCount, 4);
  assert.equal(result.vomWeights.version, 1);
});
