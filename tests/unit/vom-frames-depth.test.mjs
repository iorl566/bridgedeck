// VOM 跨帧深度：frame 归属链 / iframe→子帧 frame 边 / 缺口与截断。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_DEPTH_LIMITS,
  VOM_FRAMES_DEPTH_VERSION,
  buildFrameDepthReport,
  describeFrameDepth,
  frameChainOf,
  summarizeFrameDepth,
} from '../../extension/src/lib/vom-frames-depth.js';

function frameGraph(frameId, edges = [], extraNodes = []) {
  const root = { id: 'f' + frameId + ':root', ref: null, tag: 'body', role: 'document' };
  const nodes = [root, ...extraNodes];
  return {
    frameId,
    available: true,
    frameNodeId: 'frame:' + frameId,
    nodes,
    edges,
    roots: ['f' + frameId + ':root'],
    counts: { nodes: nodes.length, edges: edges.length, byType: { child: extraNodes.length } },
    truncated: false,
  };
}

function frameOf(frameId, overrides = {}) {
  return { frameId, parentFrameId: frameId === 0 ? undefined : 0, url: 'https://example.test/f' + frameId, hidden: false, vom: frameGraph(frameId), ...overrides };
}

test('frameChainOf：父链到根、缺父与环检测', () => {
  const parents = new Map([[0, undefined], [1, 0], [2, 1]]);
  assert.deepEqual(frameChainOf(2, parents), { frameId: 2, path: [2, 1, 0], depth: 2, cycle: false, missingParent: false });
  assert.deepEqual(frameChainOf(0, parents).path, [0]);
  const missing = frameChainOf(9, new Map([[9, 5]]));
  assert.equal(missing.missingParent, true);
  const cycle = frameChainOf(0, new Map([[0, 1], [1, 0]]));
  assert.equal(cycle.cycle, true);
  assert.deepEqual(cycle.path, [0, 1]);
});

test('buildFrameDepthReport：iframe 元素 → 子帧 frame 边，归属链与统计', () => {
  const frames = [
    frameOf(0, {
      vom: frameGraph(0, [
        { type: 'frame', from: 'f0:iframe1', to: 'frame:1' },
        { type: 'frame', from: 'f0:iframe2', to: 'frame:2' },
      ], [{ id: 'f0:iframe1', tag: 'iframe' }, { id: 'f0:iframe2', tag: 'iframe' }]),
    }),
    frameOf(1, { parentFrameId: 0 }),
    frameOf(2, { parentFrameId: 0 }),
  ];
  const report = buildFrameDepthReport({ frames });
  assert.equal(report.version, VOM_FRAMES_DEPTH_VERSION);
  assert.equal(report.available, true);
  assert.equal(report.stats.frames, 3);
  assert.equal(report.stats.graphed, 3);
  assert.equal(report.stats.links, 2);
  assert.equal(report.stats.unlinked, 0);
  assert.equal(report.stats.maxDepth, 1);
  assert.deepEqual(report.links.map((link) => link.toFrameId).sort(), [1, 2]);
  assert.deepEqual(report.frames.find((frame) => frame.frameId === 1).chain.path, [1, 0]);
  assert.ok(report.frames.find((frame) => frame.frameId === 1).owner, '子帧应带 owner');
  assert.equal(report.gaps.length, 0);
  // 上游 vomFrames 摘要一并透传
  const withSummary = buildFrameDepthReport({ frames, vomFrames: { count: 3, nodes: 9, edges: 5, links: [1, 2], unlinked: 0, truncated: false } });
  assert.equal(withSummary.summary.links, 2);
});

test('buildFrameDepthReport：未关联子帧 / hidden / 无图 / 缺父 / 环全部进 gaps', () => {
  const frames = [
    frameOf(0),
    frameOf(1, { parentFrameId: 0 }), // 父图没有 frame 边 → unlinked
    frameOf(2, { hidden: true, vom: null }),
    frameOf(3, { parentFrameId: 99 }), // 父帧缺失 + 未关联
    frameOf(4, { parentFrameId: 0, vom: null }),
  ];
  const report = buildFrameDepthReport({ frames });
  const reasons = report.gaps.map((gap) => gap.reason);
  assert.ok(reasons.includes('frame-edge-missing'));
  assert.ok(reasons.includes('hidden-frame'));
  assert.ok(reasons.includes('no-graph'));
  assert.ok(reasons.includes('parent-frame-missing'));
  assert.equal(report.stats.unlinked, 4, '4 个子帧都没有父图的 frame 边');
  assert.equal(report.stats.hidden, 1);
  assert.equal(report.stats.graphed, 3);
  assert.ok(report.gaps.find((gap) => gap.frameId === 2).evidence);

  const cycleFrames = [
    { frameId: 0, parentFrameId: 1, url: '', hidden: false, vom: frameGraph(0) },
    { frameId: 1, parentFrameId: 0, url: '', hidden: false, vom: frameGraph(1) },
  ];
  const cyclic = buildFrameDepthReport({ frames: cycleFrames });
  assert.ok(cyclic.gaps.some((gap) => gap.reason === 'frame-chain-cycle'));
});

test('buildFrameDepthReport：truncated / graph-unavailable / 上限', () => {
  const frames = [frameOf(0)];
  frames[0].vom = { ...frameGraph(0), available: false, truncated: true, counts: { nodes: 1, edges: 0, byType: {} } };
  const report = buildFrameDepthReport({ frames });
  assert.equal(report.stats.truncated, true);
  assert.ok(report.gaps.some((gap) => gap.reason === 'graph-unavailable'));
  assert.equal(report.stats.graphed, 0);
  const many = [];
  for (let index = 0; index < 5; index += 1) many.push(frameOf(index, { parentFrameId: index === 0 ? undefined : 0 }));
  const limited = buildFrameDepthReport({ frames: many, limits: { frames: 2 } });
  assert.equal(limited.frames.length, 2);
  assert.equal(limited.stats.truncated, true);
  assert.ok(FRAME_DEPTH_LIMITS.frames >= 2);
});

test('summarizeFrameDepth / describeFrameDepth：限量、JSON 安全、一行文本', () => {
  const frames = [
    frameOf(0, {
      vom: frameGraph(0, [{ type: 'frame', from: 'f0:iframe1', to: 'frame:1' }], [{ id: 'f0:iframe1', tag: 'iframe' }]),
    }),
    frameOf(1),
    frameOf(2, { vom: null }),
  ];
  const report = buildFrameDepthReport({ frames, frameGaps: { gaps: ['hidden_frame'], counts: { hidden_frame: 1 } } });
  const summary = summarizeFrameDepth(report, { frames: 2, gaps: 1 });
  assert.equal(summary.version, VOM_FRAMES_DEPTH_VERSION);
  assert.equal(summary.available, true);
  assert.equal(summary.counts.frames, 3);
  assert.equal(summary.counts.graphed, 2);
  assert.equal(summary.counts.links, 1);
  assert.ok(summary.counts.gaps >= 1);
  assert.equal(summary.frames.length, 2);
  assert.equal(summary.links.length, 1);
  assert.ok(summary.gaps.length <= 1);
  assert.deepEqual(summary.gapsFromUpstream, { gaps: ['hidden_frame'], counts: { hidden_frame: 1 } });
  const roundTrip = JSON.parse(JSON.stringify(summary));
  assert.deepEqual(roundTrip.counts, summary.counts);
  const text = describeFrameDepth(summary);
  assert.match(text, /frames=3/);
  assert.match(text, /graphed=2/);
  assert.match(text, /gaps=/);
});
