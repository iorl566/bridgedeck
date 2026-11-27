import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVomPayload } from '../../extension/src/lib/vom-payload.js';

test('VOM payload 包含分层、节点和视觉对象', () => {
  const payload = buildVomPayload({
    nodes: [{ ref: '@e1', backendNodeId: 2, role: 'button', name: 'ok', bounds: { x: 1, y: 2, width: 3, height: 4 }, clickable: true }],
    layers: [{ level: 'L2', role: 'dialog', name: 'd', coverage: 0.5 }],
    visual: [{ kind: 'ref', ref: '@e1' }],
    issues: [{ stage: 'facts', reason: 'timeout' }],
    documentId: 'https://x',
    revision: 7,
  });
  assert.equal(payload.version, 1);
  assert.equal(payload.nodes[0].ref, '@e1');
  assert.equal(payload.nodes[0].clickable, true);
  assert.equal(payload.layers[0].level, 'L2');
  assert.equal(payload.visual[0].kind, 'ref');
  assert.deepEqual(payload.issues, [{ stage: 'facts', reason: 'timeout' }]);
  assert.equal(payload.revision, 7);
});

test('VOM 阶段证据 + aria 关系', () => {
  const payload = buildVomPayload({
    nodes: [
      { ref: '@e1', stableRef: 's-1', rect: { x: 0, y: 0, w: 10, h: 10 }, inViewport: true, pointerEvents: 'auto', cursor: 'pointer', hitTest: 'ok', clickable: true, ariaControls: 'panel', ariaLabelledBy: 'label', labels: ['关键词'], formId: 'search', ancestors: [{ tag: 'form', role: 'form', id: 'search', ref: '@e9' }] },
    ],
    layers: [{ level: 'L2', role: 'dialog' }],
    facts: { nodes: 1 },
  });
  assert.deepEqual(payload.stages.map((stage) => stage.stage), ['facts', 'identity', 'relations', 'layout', 'paint', 'interact']);
  assert.equal(payload.stages.find((stage) => stage.stage === 'facts').ok, true);
  assert.equal(payload.stages.find((stage) => stage.stage === 'relations').count, 1);
  // 旧路径（无页面图）的边保留 child/parent 兼容字段；2026-11-19 起同时带 type/from/to。
  assert.deepEqual(payload.edges[0], { type: 'child', from: '@e9', to: '@e1', child: '@e1', parent: '@e9' });
  assert.deepEqual(payload.nodes[0].relations, { controls: ['panel'], labelledBy: ['label'], labels: ['关键词'], form: ['search'] });
  assert.deepEqual(payload.nodes[0].ancestors, [{ tag: 'form', role: 'form', id: 'search', ref: '@e9' }]);
  assert.equal(payload.graph, null, '无页面图时 graph 应为 null');
});
