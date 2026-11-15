// DOMSnapshot 事实合并：clickable 语义、visibilityStale、表单差异、阻挡层标注。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBlockingLayers, applyFactToNode } from '../../extension/src/lib/facts-apply.js';

test('clickable 以 page-lib 为主，DOMSnapshot 作为 domClickable', () => {
  const node = { clickable: true, hitTest: 'self' };
  applyFactToNode(node, { bounds: { x: 0, y: 0, width: 10, height: 10 }, visible: true, clickable: false });
  assert.equal(node.clickable, true);
  assert.equal(node.domClickable, false);
});

test('visible=false 与 hitTest=self 矛盾时标 visibilityStale', () => {
  const node = { hitTest: 'self' };
  applyFactToNode(node, { bounds: null, visible: false, clickable: false });
  assert.equal(node.visible, false);
  assert.equal(node.visibilityStale, true);
});

test('表单值/checked 差异标 formStateStale，密码不比较', () => {
  const text = { value: 'old', checked: false };
  applyFactToNode(text, { bounds: null, visible: true, value: 'new', checked: true });
  assert.equal(text.domValue, 'new');
  assert.equal(text.formStateStale, true);
  const password = { value: 'secret' };
  applyFactToNode(password, { bounds: null, visible: true, value: '********' });
  assert.equal(password.formStateStale, undefined);
});

test('applyBlockingLayers 只标注完全落在阻挡层内的节点', () => {
  const layer = { role: 'dialog', name: '弹窗', coverage: 0.6, bounds: { x: 0, y: 0, width: 100, height: 100 } };
  const insideNode = { bounds: { x: 10, y: 10, width: 20, height: 20 } };
  const outsideNode = { bounds: { x: 90, y: 90, width: 20, height: 20 } };
  applyBlockingLayers([insideNode, outsideNode], [layer]);
  assert.equal(insideNode.underBlockingLayer.name, '弹窗');
  assert.equal(outsideNode.underBlockingLayer, undefined);
  applyBlockingLayers([{ bounds: null }], [layer]);
});
