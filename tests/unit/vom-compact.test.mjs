import test from 'node:test';
import assert from 'node:assert/strict';
import { compactVomNodes } from '../../extension/src/lib/vom-compact.js';

const nav = [{ tag: 'nav', role: 'navigation', id: 'top' }];
const nodes = [
  { name: 'a', vomScore: 5, ancestors: nav },
  { name: 'b', vomScore: 30, ancestors: nav },
  { name: 'c', vomScore: 20, ancestors: nav },
  { name: 'free', vomScore: 1 },
];

test('compactVomNodes 每组保留 top N，未分组保留', () => {
  const result = compactVomNodes(nodes, { perGroup: 2 });
  assert.deepEqual(result.nodes.map((node) => node.name), ['b', 'c', 'free']);
  assert.equal(result.groups, 1);
  assert.equal(result.dropped, 1);
});

test('compactVomNodes 关闭时原样返回', () => {
  const result = compactVomNodes(nodes, { perGroup: 0 });
  assert.equal(result.nodes.length, 4);
  assert.equal(result.dropped, 0);
});

test('compactVomNodes 按组 token 预算裁剪', () => {
  const result = compactVomNodes([
    { name: 'a', vomScore: 30, ancestors: nav },
    { name: 'b', vomScore: 20, ancestors: nav },
    { name: 'c', vomScore: 10, ancestors: nav },
  ], { maxGroupTokens: 20 });
  assert.equal(result.nodes.length, 2);
  assert.equal(result.dropped, 1);
});
