// observe / observe --frames 的真实管线消费证明：第九批 VOM 深度字段确实从运行时主路径产出，
// 且默认字段（vom.version / stages / capture / nodeCount / refs / frames）不回退。
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {} });

function rowAnchor(index) {
  return {
    ariaRowIndex: index, dataIndex: index, transform: 'matrix(1, 0, 0, 1, 0, 0)', rowKey: 'row-' + index,
    rowText: '行' + index, containerScrollTop: 0, recycled: false, role: 'row', tag: 'tr',
  };
}

const stages = {
  visited: 12, hidden: 2, stealth: 0, skippedTag: 1, emitted: 3, refs: 2, tokens: 40,
  ms: { walk: 2.2, visibility: 1.1, stealth: 0 }, truncated: false, elapsedMs: 9,
};

// 单 frame 页面：一个普通按钮 + 一个 top-layer dialog（供 z-order/遮挡链消费）。
function singlePageResult() {
  return {
    url: 'https://example.test/form',
    title: '表单页',
    observation: '- button "保存" [@e1]\n- dialog "确认" [@e2]',
    refs: 2,
    revision: 5,
    blocking: { role: 'dialog', label: '确认', coverage: 0.5 },
    nodes: [
      {
        ref: '@e1', vomId: 'v1', graphKey: 'n1', tag: 'button', id: 'save', role: 'button', name: '保存',
        clickable: true, hitTest: 'self', rect: { x: 10, y: 10, w: 80, h: 30 }, inViewport: true,
        pointerEvents: 'auto', paintOrder: 0, ancestors: [], labels: [], visible: true, ariaHidden: false,
        anchor: rowAnchor(1),
      },
      {
        ref: '@e2', vomId: 'v2', graphKey: 'n2', tag: 'div', id: 'confirm', role: 'dialog', name: '确认',
        clickable: false, hitTest: 'self', rect: { x: 0, y: 0, w: 400, h: 300 }, inViewport: true,
        pointerEvents: 'auto', paintOrder: 1, layerKind: 'top-layer', ancestors: [], labels: [], visible: true,
      },
    ],
    graph: {
      nodes: [
        { key: 'n1', ref: '@e1', tag: 'button', role: 'button', domId: 'save', parentKey: 'n9' },
        { key: 'n2', ref: '@e2', tag: 'div', role: 'dialog', domId: 'confirm', parentKey: 'n9' },
        { key: 'n9', ref: null, tag: 'div', role: 'dialog', domId: 'dialog-root', parentKey: null },
      ],
      edges: [
        { type: 'child', from: 'n9', to: 'n1' },
        { type: 'child', from: 'n9', to: 'n2' },
        { type: 'controls', from: 'n1', to: 'n2' },
      ],
      truncated: false,
    },
    stages,
  };
}

function deepPageResult() {
  return {
    nodes: [
      { id: 'vom-deep:0', ref: '@e1', tag: 'button', role: 'button', name: '保存', interactive: true, rect: { x: 10, y: 10, width: 80, height: 30 }, anchor: rowAnchor(1) },
      { id: 'vom-deep:1', ref: '@e2', tag: 'div', role: 'dialog', name: '确认', rect: { x: 0, y: 0, width: 400, height: 300 } },
    ],
    lines: ['- button "保存" [interactive] @10,10', '- dialog "确认" @0,0'],
    stages: { collected: 12, skippedTag: 0, hidden: 2, stealth: 0, empty: 0, deduped: 0, emitted: 2, tokens: 20, truncated: false },
    revision: 5,
  };
}

// 父 frame：按钮 + iframe 元素；子 frame：链接。供 observe --frames 的归属链消费。
function parentFrameResult() {
  const result = singlePageResult();
  result.observation = '- button "保存" [@e1]\n- iframe [@e2]';
  result.nodes[1] = {
    ref: '@e2', vomId: 'v2', graphKey: 'n2', tag: 'iframe', id: 'child-frame', role: 'frame', name: '',
    clickable: false, hitTest: 'self', rect: { x: 0, y: 0, w: 400, h: 300 }, inViewport: true,
    pointerEvents: 'auto', paintOrder: 1, frameIndex: 0, srcUrl: 'https://child.test/', ancestors: [], visible: true,
  };
  result.graph.nodes[1] = { key: 'n2', ref: '@e2', tag: 'iframe', role: 'frame', domId: 'child-frame', parentKey: 'n9', frameIndex: 0, srcUrl: 'https://child.test/' };
  result.graph.edges = [{ type: 'child', from: 'n9', to: 'n1' }, { type: 'child', from: 'n9', to: 'n2' }];
  return result;
}

function childFrameResult() {
  return {
    url: 'https://child.test/',
    title: '子页面',
    observation: '- link "更多" [@e1]',
    refs: 1,
    revision: 1,
    nodes: [{
      ref: '@e1', vomId: 'c1', graphKey: 'c1', tag: 'a', role: 'link', name: '更多',
      clickable: true, hitTest: 'self', rect: { x: 5, y: 5, w: 50, h: 20 }, inViewport: true,
      pointerEvents: 'auto', paintOrder: 0, ancestors: [], visible: true,
    }],
    graph: {
      nodes: [{ key: 'c1', ref: '@e1', tag: 'a', role: 'link', domId: 'more', parentKey: null }],
      edges: [],
      truncated: false,
    },
    stages,
  };
}

const byFrame = {
  observe: { 0: singlePageResult(), 1: childFrameResult() },
  'deep-vom': { 0: deepPageResult() },
  'visual-scan': { 0: { candidates: [{ index: 0, tag: 'canvas', id: 'chart', rect: { x: 200, y: 200, width: 300, height: 150 } }], viewport: null, layers: [] } },
  'visual-refs': { 0: { refs: [{ ref: '@e1', role: 'button', name: '保存', x: 10, y: 10, width: 80, height: 30 }] } },
  'clear-vom-markers': { 0: { ok: true } },
};

let frameMenuForTab = () => [{ frameId: 0, parentFrameId: -1, url: 'https://example.test/form', documentId: 'doc-0' }];

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '0.3.0' }),
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
    get: async (tabId) => ({ id: tabId, url: 'https://example.test/form', title: '表单页' }),
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
      const name = Array.isArray(options && options.args) ? options.args[0] : '';
      const table = byFrame[name];
      if (!table) throw new Error('测试 stub 未提供页面命令：' + String(name));
      const target = options && options.target ? options.target : {};
      const frameIds = Array.isArray(target.frameIds) && target.frameIds.length
        ? target.frameIds
        : (Number(target.tabId) === 9 ? [0, 1] : [0]);
      return frameIds.map((frameId) => {
        const value = table[frameId] !== undefined ? table[frameId] : table[0];
        return { frameId, result: { ok: true, result: value } };
      });
    },
  },
  webNavigation: { getAllFrames: async ({ tabId }) => frameMenuForTab(tabId) },
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

const { observe, observeFrames, clearObservationCache } = await import('../../extension/src/tools/observation.js');

test('observe --vom：z-order / 关系全链 / 视觉身份 / 证据报告从主路径产出并进入 payload', async () => {
  const result = await observe({ tabId: 7, vom: true, vomBillingModel: 'cjk-heuristic-v2', force: true });

  // 1) 既有输出不回退
  assert.equal(result.vom.version, 1);
  assert.equal(result.vom.stages.map((stage) => stage.stage).join(','), 'facts,identity,relations,layout,paint,interact');
  assert.equal(result.vom.capture.stages.length, 6);
  assert.equal(result.nodeCount, 2);
  assert.equal(result.vomWeights.version, 1);
  assert.ok(Array.isArray(result.nodes) && result.nodes.length >= 1);

  // 2) 绘制栈/遮挡链：dialog 在按钮之后画，构成按钮的遮挡链
  assert.ok(result.vomZOrder, '缺少 vomZOrder');
  assert.equal(result.vomZOrder.version, 1);
  assert.ok(result.vomZOrder.counts.stack >= 2);
  assert.ok(result.vomZOrder.counts.chains >= 1, 'zorder 遮挡链为空：' + JSON.stringify(result.vomZOrder.counts));
  const occluded = result.vomZOrder.occluded.find((item) => item.id === '@e1');
  assert.ok(occluded, '按钮应被 dialog 遮挡：' + JSON.stringify(result.vomZOrder.occluded));
  assert.equal(occluded.top, '@e2');
  assert.match(result.vomZOrderText, /zorder stack=/);
  assert.ok(result.vom.zorder, 'payload 未带 zorder');
  assert.deepEqual(result.vom.zorder.counts, result.vomZOrder.counts);

  // 3) 关系全链：containment + controls 能从 payload.relations 聚合出来
  assert.ok(result.vomRelationChains, '缺少 vomRelationChains');
  assert.equal(result.vomRelationChains.version, 1);
  assert.ok(result.vomRelationChains.counts.links >= 2);
  assert.ok(result.vomRelationChains.integrity, '缺少关系完整性');
  const chainNode = result.vomRelationChains.chains.find((entry) => entry.id === '@e1' || entry.id === '@e2');
  assert.ok(chainNode, '关系链里应有观察节点');
  assert.match(result.vomRelationChainsText, /chains nodes=/);
  assert.ok(result.vom.relationChains, 'payload 未带 relationChains');

  // 4) visualObjects 稳定身份 + 动作闭环
  assert.ok(result.vomVisualIdentity, '缺少 vomVisualIdentity');
  assert.equal(result.vomVisualIdentity.version, 1);
  assert.equal(result.vomVisualIdentity.counts.objects, 2);
  const refObject = result.visualObjects.find((item) => item.kind === 'ref');
  assert.ok(refObject.voId, '视觉对象缺 voId');
  assert.match(refObject.voId, /^vs-/);
  assert.ok(refObject.identity && refObject.identity.change === 'added');
  const refClosure = result.vomVisualIdentity.objects.find((item) => item.kind === 'ref');
  assert.equal(refClosure.actionable, true);
  assert.ok(refClosure.targets.some((target) => target.method === 'click' && target.ref === '@e1'));
  // DPR 未知时 region 只给 screenshot 一步，不伪造图像坐标
  const regionClosure = result.vomVisualIdentity.objects.find((item) => item.kind === 'region');
  assert.equal(regionClosure.actionable, false);
  assert.equal(regionClosure.blockedReason, 'dpr-unknown');
  assert.deepEqual(regionClosure.targets.map((target) => target.method), ['screenshot']);
  assert.match(result.vomVisualIdentityText, /visual objects=2/);
  assert.ok(result.vom.visualIdentity, 'payload 未带 visualIdentity');

  // 5) 证据/降级报告：capture/budget/relations/layers/geometry 可用，预算条目真实
  assert.ok(result.vomEvidence, '缺少 vomEvidence');
  assert.equal(result.vomEvidence.version, 1);
  assert.equal(result.vomEvidence.evidence.capture.available, true);
  assert.equal(result.vomEvidence.evidence.relations.available, true);
  assert.equal(result.vomEvidence.evidence.layers.available, true);
  assert.ok(result.vomEvidence.budgets.some((entry) => entry.kind === 'nodes'));
  assert.ok(result.vomEvidence.counts.evidence >= 5);
  assert.match(result.vomEvidenceText, /evidence \d+\/10/);
  assert.ok(result.vom.evidence, 'payload 未带 evidence');
});

test('视觉对象跨 observe 稳定身份：第二轮保留 voId 并标 stable', async () => {
  clearObservationCache(8);
  const first = await observe({ tabId: 8, vom: true, vomBillingModel: 'cjk-heuristic-v2', force: true });
  const firstIds = first.visualObjects.map((item) => item.voId).sort();
  assert.equal(firstIds.length, 2);
  assert.equal(first.vomVisualIdentity.changes.added, 2);
  const second = await observe({ tabId: 8, vom: true, vomBillingModel: 'cjk-heuristic-v2', force: true });
  const secondIds = second.visualObjects.map((item) => item.voId).sort();
  assert.deepEqual(secondIds, firstIds, '第二轮应复用同一批 voId');
  assert.equal(second.vomVisualIdentity.counts.matched, 2);
  assert.equal(second.vomVisualIdentity.changes.stable, 2);
  assert.equal(second.vomVisualIdentity.changes.added, 0);
});

test('关系路径查询：沿用 --vom-relation-query 参数，结果作为可选字段返回', async () => {
  const result = await observe({
    tabId: 7,
    vom: true,
    vomBillingModel: 'cjk-heuristic-v2',
    force: true,
    vomRelationQuery: JSON.stringify({ path: { from: '@e1', to: 'vom:n9' } }),
  });
  assert.ok(result.vomRelationPaths, '缺少 vomRelationPaths');
  assert.equal(result.vomRelationPaths.from, '@e1');
  assert.equal(result.vomRelationPaths.to, 'vom:n9');
  assert.ok(result.vomRelationPaths.paths.length >= 1, '按钮到 dialog 容器应有 contains 路径');
  assert.equal(result.vomRelationPaths.paths[0].steps[0].type, 'contains');
  assert.match(result.vomRelationPathsText, /relation paths from=@e1 to=vom:n9/);
  // 未请求 path 时既有 relationQuery 语义不变
  const plain = await observe({ tabId: 7, vom: true, vomBillingModel: 'cjk-heuristic-v2', force: true, vomRelationQuery: '{"type":"controls"}' });
  assert.equal(plain.vomRelationPaths, undefined);
  assert.ok(plain.relationQuery, '既有 relationQuery 不应消失');
});

test('默认 observe（无 --vom）不产生深度字段：默认输出不变', async () => {
  const result = await observe({ tabId: 10, force: true });
  for (const key of ['vomZOrder', 'vomRelationChains', 'vomVisualIdentity', 'vomEvidence', 'vomFrameDepth']) {
    assert.equal(result[key], undefined, key + ' 不应在默认输出出现');
  }
  assert.equal(result.observation.includes('button'), true);
  assert.equal(result.refs, 2);
});

test('observe --frames --vom：跨帧归属链 / frame 边 / 隐藏缺口从 wrapper 产出', async () => {
  frameMenuForTab = (tabId) => (Number(tabId) === 9
    ? [
      { frameId: 0, parentFrameId: -1, url: 'https://example.test/form', documentId: 'doc-0' },
      { frameId: 1, parentFrameId: 0, url: 'https://child.test/', documentId: 'doc-1' },
    ]
    : [{ frameId: 0, parentFrameId: -1, url: 'https://example.test/form', documentId: 'doc-0' }]);
  byFrame.observe[0] = parentFrameResult();
  const result = await observeFrames({ tabId: 9, vom: true, force: true });
  // 既有字段
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[0].frameId, 0);
  assert.equal(result.frames[1].frameId, 1);
  assert.ok(Array.isArray(result.aliases));
  assert.equal(typeof result.refs, 'number');
  assert.ok(result.vomFrames, '既有 vomFrames 摘要应保留');
  assert.ok(result.frames[0].vom && result.frames[0].vom.available === true);
  // 深度字段
  assert.ok(result.vomFrameDepth, '缺少 vomFrameDepth');
  assert.equal(result.vomFrameDepth.counts.frames, 2);
  assert.equal(result.vomFrameDepth.counts.graphed, 2);
  assert.equal(result.vomFrameDepth.counts.links, 1, 'iframe 元素 → 子帧应生成一条归属边');
  const child = result.vomFrameDepth.frames.find((frame) => frame.frameId === 1);
  assert.ok(child);
  assert.deepEqual(child.chain, [1, 0]);
  assert.ok(child.owner, '子帧应有 owner（iframe 元素）');
  assert.match(result.vomFrameDepthText, /frames=2/);
  // 自动路径（observe → observeSmart）：多 frame 页面走 smart 合并时同样带深度字段。
  const smart = await observe({ tabId: 9, vom: true, vomBillingModel: 'cjk-heuristic-v2', delta: true });
  assert.ok(smart.vomFrameDepth, 'observeSmart 路径未透出 vomFrameDepth');
});
