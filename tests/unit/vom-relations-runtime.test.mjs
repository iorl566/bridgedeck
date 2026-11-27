// 运行时消费证据：observe() / observeSmart() 真的把关系 v3 扩展、上下文、压缩、查询、跨 frame 关系
// 接到主路径上（chrome stub + 假页面库，不依赖真实浏览器）。防止新模块只在单测里自嗨。
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {} });

const mainNodes = [
  {
    ref: '@e1', vomId: 'v1', graphKey: 'n1', tag: 'button', id: 'save', role: 'button', name: '保存',
    clickable: true, hitTest: 'self', rect: { x: 10, y: 10, w: 80, h: 30 }, inViewport: true,
    pointerEvents: 'auto', paintOrder: 0, ancestors: [], labels: [], ariaLabelledBy: 'lbl', visible: true,
  },
  {
    ref: '@e2', vomId: 'v2', graphKey: 'n2', tag: 'tr', id: 'row-3', role: 'row', name: '第三行',
    clickable: false, hitTest: 'self', rect: { x: 0, y: 50, w: 100, h: 40 }, inViewport: true,
    pointerEvents: 'auto', paintOrder: 1, ancestors: [], labels: [], visible: true,
  },
  {
    ref: '@e3', vomId: 'v3', graphKey: 'n3', tag: 'span', id: 'lbl', role: null, name: '标签',
    clickable: false, hitTest: 'self', rect: { x: 0, y: 100, w: 60, h: 20 }, inViewport: true,
    pointerEvents: 'auto', paintOrder: 2, ancestors: [], labels: [], visible: true,
  },
];

const mainObserve = {
  url: 'https://example.test/page',
  title: '主页面',
  observation: '- button "保存" [@e1]\n- row "第三行" [@e2]',
  refs: 2,
  revision: 5,
  nodes: mainNodes,
  graph: {
    nodes: [
      { key: 'n1', ref: '@e1', tag: 'button', role: 'button', domId: 'save', parentKey: 'n9' },
      { key: 'n2', ref: '@e2', tag: 'tr', role: 'row', domId: 'row-3', parentKey: 'n9' },
      { key: 'n3', ref: '@e3', tag: 'span', role: null, domId: 'lbl', parentKey: 'n9' },
      { key: 'n9', ref: null, tag: 'form', role: 'form', domId: 'form1', parentKey: null },
      { key: 'n5', ref: null, tag: 'iframe', role: null, domId: 'child-frame', parentKey: null, frameIndex: 0, srcUrl: 'https://example.test/child' },
    ],
    edges: [
      { type: 'child', from: 'n9', to: 'n1' },
      { type: 'child', from: 'n9', to: 'n2' },
      { type: 'child', from: 'n9', to: 'n3' },
      { type: 'form', from: 'n9', to: 'n1' },
      { type: 'labelledby', from: 'n3', to: 'n1' },
    ],
    truncated: false,
  },
  stages: {
    visited: 20, hidden: 1, stealth: 0, skippedTag: 2, emitted: 3, refs: 2, tokens: 40,
    ms: { walk: 2.2, visibility: 1.1, stealth: 0 }, truncated: false, elapsedMs: 9,
  },
};

const childObserve = {
  url: 'https://example.test/child',
  title: '子页面',
  observation: '- button "子帧按钮" [@e1]',
  refs: 1,
  revision: 2,
  nodes: [
    {
      ref: '@e1', vomId: 'v1', graphKey: 'c1', tag: 'button', id: 'child-btn', role: 'button', name: '子帧按钮',
      clickable: true, hitTest: 'self', rect: { x: 5, y: 5, w: 60, h: 24 }, inViewport: true,
      pointerEvents: 'auto', paintOrder: 0, ancestors: [], labels: [], visible: true,
    },
  ],
  graph: {
    nodes: [
      { key: 'c1', ref: '@e1', tag: 'button', role: 'button', domId: 'child-btn', parentKey: 'c9' },
      { key: 'c9', ref: null, tag: 'body', role: null, domId: null, parentKey: null },
    ],
    edges: [{ type: 'child', from: 'c9', to: 'c1' }],
    truncated: false,
  },
  stages: {
    visited: 8, hidden: 0, stealth: 0, skippedTag: 2, emitted: 1, refs: 1, tokens: 12,
    ms: { walk: 0.5, visibility: 0.2, stealth: 0 }, truncated: false, elapsedMs: 3,
  },
};

function resultFor(frameId, name) {
  if (name === 'observe') return frameId === 0 ? mainObserve : childObserve;
  if (name === 'frame-meta') {
    return frameId === 0
      ? { url: 'https://example.test/page', parentFrameId: -1, hidden: false, children: [] }
      : { url: 'https://example.test/child', parentFrameId: 0, hidden: false, children: [] };
  }
  if (name === 'visual-scan') return { candidates: [], viewport: null, layers: [] };
  if (name === 'visual-refs') return { refs: [] };
  if (name === 'clear-vom-markers') return { ok: true };
  throw new Error('测试 stub 未提供页面命令：' + String(name));
}

const browserFrames = [
  { frameId: 0, parentFrameId: -1, url: 'https://example.test/page', documentId: 'doc-0' },
  { frameId: 1, parentFrameId: 0, url: 'https://example.test/child', documentId: 'doc-1' },
];

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
    get: async (tabId) => ({ id: tabId, url: 'https://example.test/page' }),
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
      const target = (options && options.target) || {};
      const frameIds = Array.isArray(target.frameIds) && target.frameIds.length
        ? target.frameIds
        : (target.allFrames ? [0, 1] : [0]);
      const injections = frameIds.map((frameId) => ({
        frameId,
        result: { ok: true, result: resultFor(frameId, name) },
      }));
      return target.allFrames ? injections : [injections[0]];
    },
  },
  webNavigation: { getAllFrames: async () => browserFrames },
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

const { observe, observeSmart } = await import('../../extension/src/tools/observation.js');

test('observe --vom：上下文/压缩/关系查询都从主路径返回', async () => {
  const result = await observe({
    tabId: 7,
    vom: true,
    vomBillingModel: 'cjk-heuristic-v2',
    vomCompress: true,
    vomRelationQuery: { kind: 'labels', role: 'button', limit: 5 },
    force: true,
  });
  // 关系 v3 扩展（kinds 含 invalidates）仍从 relations 顶层返回。
  assert.equal(result.relations.version, 3);
  assert.ok(result.relations.kinds.includes('invalidates'));
  assert.ok(result.relations.relations.length >= 1);
  // 语义上下文：form 组存在（n1/n2/n3 的祖先 n9 是 form）。
  assert.ok(result.context, '缺少 context');
  assert.equal(result.context.stats.forms >= 1, true, 'context 表单组未生成：' + JSON.stringify(result.context.stats));
  assert.equal(result.context.contexts.length >= 1, true);
  // 语义压缩：opt-in 时 payload 与顶层都带报告。
  assert.ok(result.vomCompression, '缺少 vomCompression');
  assert.equal(result.vomCompression.report.folds >= 1, true, '没有折叠任何组：' + JSON.stringify(result.vomCompression.report));
  assert.match(result.vomCompressionText, /nodes \d+→\d+/);
  assert.ok(result.vom.compression, 'payload 未带 compression');
  assert.equal(result.vom.compression.report.folds, result.vomCompression.report.folds);
  // 关系查询：按 kind+role 过滤并分页。
  assert.ok(result.relationQuery, '缺少 relationQuery');
  assert.equal(result.relationQuery.items.every((item) => item.type === 'labels'), true);
  assert.equal(result.relationQuery.items.every((item) => item.fromRole === 'button' || item.toRole === 'button'), true);
  assert.equal(result.relationQuery.page.limit, 5);
  assert.match(result.relationQueryText, /relations \d+-\d+\/\d+/);
  // 单 frame 路径不应出现跨 frame 字段。
  assert.equal(result.vomFrameRelations, undefined);
});

test('observeSmart --vom：多 frame 时产出 frame 作为节点的关系层', async () => {
  const result = await observeSmart({ tabId: 9, vom: true, vomBillingModel: 'cjk-heuristic-v2', force: true });
  assert.equal(result.frames.length, 2, 'frames=' + JSON.stringify(result.frames.map((frame) => ({ id: frame.frameId, url: frame.url, error: frame.error }))));
  for (const frame of result.frames) assert.ok(frame.vom && frame.vom.available === true, 'frame ' + frame.frameId + ' 缺少子图');
  const frameRelations = result.vomFrameRelations;
  assert.ok(frameRelations, '缺少 vomFrameRelations');
  assert.equal(frameRelations.frames.length, 2);
  const frameIds = frameRelations.frames.map((frame) => frame.frameId).sort();
  assert.deepEqual(frameIds, [0, 1]);
  assert.equal(frameRelations.stats.bySource['frame-edge'] >= 2, true, 'frame-edge=' + JSON.stringify(frameRelations.stats.bySource));
  assert.equal(frameRelations.stats.bySource['parent-frame'], 1);
  assert.equal(frameRelations.stats.bySource['frame-owner'], 1, 'iframe 元素 → 子帧节点关系缺失：' + JSON.stringify(frameRelations.relations));
  assert.equal(frameRelations.stats.crossFrame >= 1, true);
  assert.match(result.vomFrameRelationsText, /frames=2/);
  assert.match(result.vomFrameRelationsText, /relations=\d+/);
  // frame 关系里 frame 节点自己作为端点出现。
  const containsFrame = frameRelations.relations.find((relation) => relation.type === 'contains' && relation.from === 'frame:0');
  assert.ok(containsFrame, 'frame:0 未参与 contains 关系');
  assert.equal(containsFrame.frame, true);
  assert.equal(typeof containsFrame.confidence, 'number');
  assert.equal(typeof containsFrame.source, 'string');
});
