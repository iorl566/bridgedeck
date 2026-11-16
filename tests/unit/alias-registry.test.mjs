import test from 'node:test';
import assert from 'node:assert/strict';
import { AliasRegistry } from '../../lib/alias-registry.mjs';

test('短别名单调递增，按会话隔离，可解析', () => {
  const registry = new AliasRegistry();
  assert.equal(registry.register('s1', 'observation', 'ob_a'), 'o1');
  assert.equal(registry.register('s1', 'observation', 'ob_b'), 'o2');
  assert.equal(registry.register('s1', 'observation', 'ob_a'), 'o1');
  assert.equal(registry.register('s1', 'capture', 'cap_x'), 'c1');
  assert.equal(registry.register('s2', 'observation', 'ob_c'), 'o1');
  assert.equal(registry.resolve('s1', 'observation', 'o2'), 'ob_b');
  assert.equal(registry.resolve('s1', 'observation', 'o3'), null);
  assert.equal(registry.resolve('s2', 'observation', 'o1'), 'ob_c');
  assert.equal(registry.resolve('s1', 'capture', 'c1'), 'cap_x');
  assert.equal(registry.resolve('s1', 'capture', 'o1'), null);
  registry.clear('s1');
  assert.equal(registry.resolve('s1', 'observation', 'o1'), null);
});
