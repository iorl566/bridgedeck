// 跨 frame 关系：frame 作为节点参与 contains/owns；输入三种形态、深度、上限与摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_RELATION_CONFIDENCE,
  FRAME_RELATION_LIMITS,
  VOM_FRAME_RELATIONS_VERSION,
  buildCrossFrameRelations,
  collectFrameGraphs,
  frameNodeIdOf,
  summarizeCrossFrameRelations,
} from '../../extension/src/lib/vom-frame-relations.js';

function frameFixture() {
  return [
    {
      frameId: 0,
      url: 'https://example.test/',
      vom: {
        available: true,
        frameNodeId: 'frame:0',
        nodes: [
          { id: 'frame:0', tag: 'document', role: 'document', frame: true, frameId: 0 },
          { id: 'f0:@e1', tag: 'iframe', role: null, parentId: 'frame:0' },
          { id: 'f0:@e2', tag: 'div', role: null },
        ],
        edges: [
          { type: 'frame', from: 'frame:0', to: 'f0:@e2' },
          { type: 'frame', from: 'f0:@e1', to: 'frame:1' },
        ],
        roots: ['f0:@e2'],
      },
    },
    {
      frameId: 1,
      parentFrameId: 0,
      url: 'https://example.test/child',
      vom: {
        available: true,
        frameNodeId: 'frame:1',
        nodes: [{ id: 'frame:1', tag: 'iframe', role: 'frame', frame: true, frameId: 1 }],
        edges: [],
        roots: [],
      },
    },
  ];
}

test('frame 关系契约：来源置信度与上限常量', () => {
  assert.equal(VOM_FRAME_RELATIONS_VERSION, 1);
  assert.equal(FRAME_RELATION_CONFIDENCE['frame-edge'], 0.95);
  assert.equal(FRAME_RELATION_CONFIDENCE['frame-owner'], 0.9);
  assert.equal(FRAME_RELATION_CONFIDENCE['parent-frame'], 0.9);
  assert.ok(Number.isInteger(FRAME_RELATION_LIMITS.frames) && FRAME_RELATION_LIMITS.frames > 0);
  assert.equal(frameNodeIdOf(0), 'frame:0');
  assert.equal(frameNodeIdOf(7), 'frame:7');
});

test('frame 节点参与关系：roots contains、iframe owns 子帧、parent-frame 树', () => {
  const result = buildCrossFrameRelations(frameFixture());
  assert.equal(result.version, 1);
  assert.equal(result.frames.length, 2);
  const relations = result.relations;
  assert.equal(relations.length, 3, JSON.stringify(relations));
  const frameEdge = relations.find((relation) => relation.source === 'frame-edge');
  assert.ok(frameEdge);
  assert.equal(frameEdge.type, 'contains');
  assert.equal(frameEdge.from, 'frame:0');
  assert.equal(frameEdge.to, 'f0:@e2');
  assert.equal(frameEdge.confidence, 0.95);
  const frameOwner = relations.find((relation) => relation.source === 'frame-owner');
  assert.ok(frameOwner);
  assert.equal(frameOwner.type, 'owns');
  assert.equal(frameOwner.from, 'f0:@e1');
  assert.equal(frameOwner.to, 'frame:1');
  assert.equal(frameOwner.childFrameId, 1);
  const parentFrame = relations.find((relation) => relation.source === 'parent-frame');
  assert.ok(parentFrame);
  assert.equal(parentFrame.type, 'contains');
  assert.equal(parentFrame.from, 'frame:0');
  assert.equal(parentFrame.to, 'frame:1');
  assert.equal(parentFrame.parentFrameId, 0);
  assert.deepEqual(result.stats.bySource, { 'frame-edge': 1, 'frame-owner': 1, 'parent-frame': 1 });
});

test('frame 元数据：url/owner/depth/roots/节点数', () => {
  const result = buildCrossFrameRelations(frameFixture());
  const root = result.frames.find((frame) => frame.frameId === 0);
  const child = result.frames.find((frame) => frame.frameId === 1);
  assert.equal(root.role, 'document');
  assert.equal(root.url, 'https://example.test/');
  assert.equal(root.depth, 0);
  assert.equal(root.roots, 1);
  assert.equal(root.nodeCount, 3);
  assert.equal(child.role, 'frame');
  assert.equal(child.url, 'https://example.test/child');
  assert.equal(child.depth, 1);
  assert.equal(child.parentFrameId, 0);
  assert.equal(child.ownerNodeId, 'f0:@e1');
  assert.equal(result.stats.frames, 2);
  assert.equal(result.stats.linked, 1);
  assert.equal(result.stats.orphan, 0);
  assert.equal(result.stats.crossFrame, 3);
});

test('输入形态：frame-vom 整包 / 松散 graph 数组 / 单项 .graph', () => {
  const graphsInput = {
    graphs: frameFixture().map((frame) => ({
      frameId: frame.frameId,
      url: frame.url,
      parentFrameId: frame.parentFrameId,
      ...frame.vom,
    })),
    summary: { count: 2 },
    limits: { frames: 16 },
  };
  const fromGraphs = buildCrossFrameRelations(graphsInput);
  assert.equal(fromGraphs.frames.length, 2);
  assert.equal(fromGraphs.relations.length, 3);
  const loose = buildCrossFrameRelations([
    { frameId: 0, url: 'about:blank', graph: { nodes: [{ id: 'frame:0' }], edges: [], roots: [] } },
  ]);
  assert.equal(loose.frames.length, 1);
  assert.equal(loose.relations.length, 0);
  const collected = collectFrameGraphs(frameFixture());
  assert.deepEqual(collected.map((frame) => frame.frameId), [0, 1]);
  assert.deepEqual(collectFrameGraphs(null), []);
  assert.deepEqual(collectFrameGraphs({ graphs: null }), []);
});

test('缺失的父 frame 用占位节点连树（不丢关系）', () => {
  const result = buildCrossFrameRelations([
    {
      frameId: 2,
      parentFrameId: 7,
      url: 'https://example.test/deep',
      graph: { nodes: [{ id: 'frame:2' }], edges: [], roots: [] },
    },
  ]);
  assert.equal(result.frames.length, 2);
  const parent = result.frames.find((frame) => frame.frameId === 7);
  assert.ok(parent, '缺失父 frame 应生成占位节点');
  assert.equal(parent.available, false);
  const relation = result.relations.find((item) => item.source === 'parent-frame');
  assert.ok(relation);
  assert.equal(relation.from, 'frame:7');
  assert.equal(relation.to, 'frame:2');
  assert.equal(result.frames.find((frame) => frame.frameId === 2).depth, 1);
});

test('上限与非法输入：frames 限制触发 truncated，非法 frameId 跳过', () => {
  const limited = buildCrossFrameRelations(frameFixture(), { limits: { frames: 1 } });
  // 输入帧被裁到 1 个；父图里引用到的子帧节点仍保留（关系端点不能悬空），并标记 truncated。
  assert.ok(limited.frames.length >= 1);
  assert.equal(limited.stats.truncated, true);
  assert.equal(limited.limits.frames, 1);
  const invalid = buildCrossFrameRelations([
    null,
    { frameId: 'x', graph: { nodes: [], edges: [] } },
    { frameId: 0, graph: null },
  ]);
  assert.equal(invalid.frames.length, 0);
  assert.deepEqual(invalid.relations, []);
  assert.equal(buildCrossFrameRelations().relations.length, 0);
});

test('同一关系多来源时合并并保留最大置信度', () => {
  const result = buildCrossFrameRelations([
    {
      frameId: 0,
      graph: {
        nodes: [{ id: 'frame:0' }, { id: 'f0:@root' }],
        edges: [
          { type: 'frame', from: 'frame:0', to: 'f0:@root' },
          { type: 'frame', from: 'frame:0', to: 'f0:@root' },
        ],
        roots: ['f0:@root'],
      },
    },
  ]);
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].sources.length, 1);
  assert.equal(result.relations[0].confidence, 0.95);
});

test('summarizeCrossFrameRelations：frames/linked/relations/cross-frame/来源', () => {
  const result = buildCrossFrameRelations(frameFixture());
  const text = summarizeCrossFrameRelations(result);
  assert.match(text, /frames=2/);
  assert.match(text, /linked=1/);
  assert.match(text, /relations=3/);
  assert.match(text, /cross-frame=3/);
  assert.match(text, /by-source\[/);
  assert.equal(summarizeCrossFrameRelations(null), 'frames=0 linked=0 relations=0 cross-frame=0');
});
