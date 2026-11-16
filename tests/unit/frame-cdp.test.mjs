import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAxTree } from '../../extension/src/lib/ax-normalize.js';

test('AX 树归一：跳过 ignored/generic，保留 role/name/value/backendNodeId', () => {
  const nodes = normalizeAxTree({
    nodes: [
      { ignored: true, role: { value: 'button' }, name: { value: 'x' } },
      { role: { value: 'generic' }, name: { value: 'y' } },
      { role: { value: 'button' }, name: { value: '提交' }, backendDOMNodeId: 42 },
      { role: { value: 'textbox' }, value: { value: 'abc' }, backendDOMNodeId: 43 },
    ],
  });
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0], { role: 'button', name: '提交', value: '', backendNodeId: 42, visible: true });
  assert.equal(nodes[1].value, 'abc');
  assert.equal(nodes[1].backendNodeId, 43);
});

test('AX 树归一：空树/非法输入返回空数组', () => {
  assert.deepEqual(normalizeAxTree(null), []);
  assert.deepEqual(normalizeAxTree({ nodes: null }), []);
  assert.deepEqual(normalizeAxTree({ nodes: [{ role: { value: 'InlineTextBox' } }] }), []);
});
