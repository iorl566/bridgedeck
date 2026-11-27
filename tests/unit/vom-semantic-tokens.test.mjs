import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVomSemanticGraph, filterSemanticGroups } from '../../extension/src/lib/vom-semantic.js';

test('filterSemanticGroups 按组 token 预算裁剪', () => {
  const entries = [
    { id: 'a', node: { name: 'x', ancestors: [{ tag: 'form', id: 'f1' }], vomScore: 30 } },
    { id: 'b', node: { name: 'y', ancestors: [{ tag: 'nav', id: 'n1' }], vomScore: 20 } },
    { id: 'free', node: { name: 'z', vomScore: 1 } },
  ];
  const graph = buildVomSemanticGraph(entries);
  const result = filterSemanticGroups(entries, graph, { maxGroupTokens: 10 });
  assert.ok(result);
  assert.ok(result.groups >= 1);
  assert.ok(result.tokensUsed <= 10 || result.groups === 1);
  assert.ok(result.ids.has('free'));
});
