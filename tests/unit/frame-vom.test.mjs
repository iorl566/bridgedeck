import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrameVomGraphs, FRAME_VOM_LIMITS } from '../../extension/src/lib/frame-vom.js';

function rawGraph(id) {
  return {
    nodes: [
      { key: 'n1', ref: null, tag: 'html', domId: null, role: null, parentKey: null },
      { key: 'n2', ref: '@e1', tag: 'button', domId: id || null, role: null, parentKey: 'n1' },
    ],
    edges: [{ type: 'child', from: 'n1', to: 'n2' }],
    truncated: false,
  };
}

function entries() {
  return [
    { frameId: 0, url: 'https://a.test/', parentFrameId: null, graph: rawGraph('main-btn'), nodes: [{ ref: '@e1' }] },
    { frameId: 3, url: 'http://127.0.0.1:9999/frame-x.html', parentFrameId: 0, graph: rawGraph('x-btn'), nodes: [{ ref: '@e1' }] },
    { frameId: 4, url: 'about:blank', parentFrameId: 0, graph: null, nodes: [] },
  ];
}

test('每帧一个子图：frame 节点 + 命名空间 id + frame 边', () => {
  const built = buildFrameVomGraphs(entries());
  assert.equal(built.graphs.length, 3);
  const main = built.graphs[0];
  const cross = built.graphs[1];
  assert.equal(main.frameNodeId, 'frame:0');
  assert.equal(main.nodes[0].id, 'frame:0');
  assert.equal(main.nodes[0].tag, 'document');
  assert.deepEqual(main.roots, ['frame:0']);
  const mainIds = main.nodes.map((node) => node.id);
  assert.ok(mainIds.includes('f0:button') || mainIds.some((id) => id.startsWith('f0:')), '主文档节点未加 f0: 前缀：' + JSON.stringify(mainIds));
  assert.ok(main.edges.some((edge) => edge.type === 'frame' && edge.from === 'frame:0'), '缺少 frame 边');
  for (const edge of main.edges) {
    assert.ok(mainIds.includes(edge.from) && mainIds.includes(edge.to), '主图边端点必须在图内：' + JSON.stringify(edge));
  }
  assert.equal(cross.nodes[0].id, 'frame:3');
  assert.equal(cross.nodes[0].tag, 'iframe');
  const crossIds = cross.nodes.map((node) => node.id);
  assert.ok(crossIds.every((id) => id.startsWith('f3:') || id === 'frame:3'), '跨源图 id 必须带 f3: 前缀：' + JSON.stringify(crossIds));
  assert.ok(cross.edges.every((edge) => crossIds.includes(edge.from) && crossIds.includes(edge.to)), '跨源边端点越界');
  assert.equal(built.summary.count, 3);
  assert.equal(built.summary.nodes, main.counts.nodes + cross.counts.nodes + built.graphs[2].counts.nodes);
});

test('同名本地 id 跨帧不冲突（f0: vs f3:）', () => {
  const built = buildFrameVomGraphs(entries());
  const ids = new Set(built.graphs.flatMap((graph) => graph.nodes.map((node) => node.id)));
  const size = built.graphs.reduce((sum, graph) => sum + graph.nodes.length, 0);
  assert.equal(ids.size, size, '不同帧的图 id 不应相同');
  assert.ok(ids.has('f0:@e1') && ids.has('f3:@e1'), '两帧的 button 应各自带前缀：' + JSON.stringify([...ids]));
});

test('没有页面图的 frame：保留 frame 节点，available:false', () => {
  const built = buildFrameVomGraphs(entries());
  const blank = built.graphs[2];
  assert.equal(blank.available, false);
  assert.deepEqual(blank.nodes.map((node) => node.id), ['frame:4']);
  assert.deepEqual(blank.roots, ['frame:4']);
  assert.equal(blank.counts.nodes, 1);
  assert.equal(blank.counts.edges, 0);
});

test('上限：帧数/每帧节点数受限并标 truncated', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ frameId: index, url: 'https://x/' + index, graph: rawGraph(), nodes: [] }));
  const limited = buildFrameVomGraphs(many, { limits: { frames: 2 } });
  assert.equal(limited.graphs.length, 2);
  assert.equal(limited.summary.truncated, true);
  assert.equal(limited.limits.frames, 2);
  const tiny = buildFrameVomGraphs([entries()[0]], { limits: { nodes: 1 } });
  assert.equal(tiny.summary.truncated, true);
  assert.ok(tiny.graphs[0].counts.nodes <= 2, 'frame 节点 + 1 个图节点：' + tiny.graphs[0].counts.nodes);
  assert.ok(FRAME_VOM_LIMITS.frames >= 8);
});

test('iframe 元素 → 子帧根：父图补 frame 节点 + frame 边 + link 摘要', () => {
  const raw = {
    nodes: [
      { key: 'n1', ref: null, tag: 'html', domId: null, role: null, parentKey: null },
      { key: 'n2', ref: null, tag: 'iframe', domId: 'x-frame', role: 'iframe', parentKey: 'n1', frameIndex: 1 },
    ],
    edges: [{ type: 'child', from: 'n1', to: 'n2' }],
    truncated: false,
  };
  const built = buildFrameVomGraphs([
    {
      frameId: 0,
      url: 'https://a.test/',
      parentFrameId: null,
      graph: raw,
      nodes: [],
      iframeOwners: [{ frameIndex: 1, childFrameId: 3, childUrl: 'http://127.0.0.1:9999/frame-x.html' }],
    },
    { frameId: 3, url: 'http://127.0.0.1:9999/frame-x.html', parentFrameId: 0, graph: rawGraph('x-btn'), nodes: [] },
  ]);
  const main = built.graphs[0];
  const child = built.graphs[1];
  const edge = main.edges.find((item) => item.type === 'frame' && item.to === 'frame:3');
  assert.ok(edge, '主图缺少 iframe→frame:3 边：' + JSON.stringify(main.edges));
  const mainIds = new Set(main.nodes.map((node) => node.id));
  assert.ok(mainIds.has(edge.from), 'owner 节点必须在主图里：' + edge.from);
  assert.ok(mainIds.has('frame:3'), '主图缺少 frame:3 节点');
  const childRef = main.nodes.find((node) => node.id === 'frame:3');
  assert.equal(childRef.parentId, edge.from, 'frame:3 的 parentId 应指向 iframe 元素');
  assert.equal(childRef.frameId, 3);
  assert.equal(childRef.url, 'http://127.0.0.1:9999/frame-x.html');
  assert.equal(built.summary.links.length, 1);
  assert.deepEqual(built.summary.links[0], { fromFrameId: 0, toFrameId: 3, ownerId: edge.from });
  assert.equal(built.summary.unlinked, 0);
  assert.equal(child.nodes[0].id, 'frame:3', '子图仍以自己的 frame 节点为根');
});

test('owner 匹配不到 iframe 节点：只记 unlinked，不造边', () => {
  const built = buildFrameVomGraphs([
    { frameId: 0, url: 'https://a/', graph: rawGraph(), nodes: [], iframeOwners: [{ frameIndex: 9, childFrameId: 7 }] },
  ]);
  assert.equal(built.summary.unlinked, 1);
  assert.deepEqual(built.summary.links, []);
  assert.equal(built.graphs[0].edges.some((edge) => edge.to === 'frame:7'), false);
});

test('嵌套 iframe 链：子帧也能作为父帧把 iframe 接到自己的子图根', () => {
  const outerGraph = {
    nodes: [
      { key: 'n1', ref: null, tag: 'html', domId: null, role: null, parentKey: null },
      { key: 'n2', ref: null, tag: 'iframe', domId: 'inner', role: 'iframe', parentKey: 'n1', frameIndex: 0 },
    ],
    edges: [{ type: 'child', from: 'n1', to: 'n2' }],
    truncated: false,
  };
  const built = buildFrameVomGraphs([
    { frameId: 0, url: 'https://a/', graph: rawGraph(), nodes: [] },
    {
      frameId: 2,
      url: 'https://a/nested-cross-outer.html',
      parentFrameId: 0,
      graph: outerGraph,
      nodes: [],
      iframeOwners: [{ frameIndex: 0, childFrameId: 3, childUrl: 'http://127.0.0.1:9999/nested-cross-inner.html' }],
    },
    { frameId: 3, url: 'http://127.0.0.1:9999/nested-cross-inner.html', parentFrameId: 2, graph: rawGraph(), nodes: [] },
  ]);
  const parent = built.graphs.find((graph) => graph.frameId === 2);
  const edge = parent.edges.find((item) => item.type === 'frame' && item.to === 'frame:3');
  assert.ok(edge, '嵌套父帧缺少 iframe→frame:3 边：' + JSON.stringify(parent.edges));
  const parentIds = new Set(parent.nodes.map((node) => node.id));
  assert.ok(parentIds.has(edge.from) && parentIds.has('frame:3'));
  assert.deepEqual(built.summary.links.find((item) => item.toFrameId === 3), { fromFrameId: 2, toFrameId: 3, ownerId: edge.from });
  assert.equal(built.summary.unlinked, 0);
});

test('auto owner 匹配：按父图 iframe 节点的 srcUrl 连子帧（嵌套也适用）', () => {
  const mainGraph = {
    nodes: [
      { key: 'n1', ref: null, tag: 'html', domId: null, role: null, parentKey: null },
      { key: 'n2', ref: null, tag: 'iframe', domId: 'outer', role: 'iframe', parentKey: 'n1', frameIndex: 0, srcUrl: 'https://a/nested-cross-outer.html' },
    ],
    edges: [{ type: 'child', from: 'n1', to: 'n2' }],
    truncated: false,
  };
  const outerGraph = {
    nodes: [
      { key: 'n1', ref: null, tag: 'html', domId: null, role: null, parentKey: null },
      { key: 'n2', ref: null, tag: 'iframe', domId: 'inner', role: 'iframe', parentKey: 'n1', frameIndex: 0, srcUrl: 'http://127.0.0.1:9999/nested-cross-inner.html' },
    ],
    edges: [{ type: 'child', from: 'n1', to: 'n2' }],
    truncated: false,
  };
  const built = buildFrameVomGraphs([
    { frameId: 0, url: 'https://a/nested-cross.html', parentFrameId: null, graph: mainGraph, nodes: [] },
    { frameId: 2, url: 'https://a/nested-cross-outer.html', parentFrameId: 0, graph: outerGraph, nodes: [] },
    { frameId: 3, url: 'http://127.0.0.1:9999/nested-cross-inner.html', parentFrameId: 2, graph: rawGraph(), nodes: [] },
  ], {
    childFrames: [
      { frameId: 2, url: 'https://a/nested-cross-outer.html', parentFrameId: 0, hidden: false },
      { frameId: 3, url: 'http://127.0.0.1:9999/nested-cross-inner.html', parentFrameId: 2, hidden: false },
    ],
  });
  assert.deepEqual(built.summary.links.find((item) => item.toFrameId === 2), { fromFrameId: 0, toFrameId: 2, ownerId: 'f0:vom:n2' });
  const nested = built.summary.links.find((item) => item.toFrameId === 3);
  assert.ok(nested, '缺少嵌套 owner link：' + JSON.stringify(built.summary.links));
  assert.equal(nested.fromFrameId, 2);
  assert.equal(nested.ownerId, 'f2:vom:n2');
  const parent = built.graphs.find((graph) => graph.frameId === 2);
  assert.ok(parent.edges.some((edge) => edge.type === 'frame' && edge.from === nested.ownerId && edge.to === 'frame:3'));
  assert.equal(built.summary.unlinked, 0);
});

test('空输入安全降级', () => {
  const built = buildFrameVomGraphs(null);
  assert.deepEqual(built.graphs, []);
  assert.equal(built.summary.count, 0);
  assert.equal(built.summary.links.length, 0);
  const bad = buildFrameVomGraphs([null, { frameId: 'x' }]);
  assert.deepEqual(bad.graphs, []);
});
