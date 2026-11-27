import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVomWeights, VOM_WEIGHT_KEYS } from '../../lib/vom-weight-config.mjs';
import { scoreVomNode } from '../../extension/src/lib/vom-weights.js';

test('parseVomWeights 解析已知键并支持逗号/分号', () => {
  assert.deepEqual(parseVomWeights('interactive=40,text=2'), { interactive: 40, text: 2 });
  assert.deepEqual(parseVomWeights('area=5;depth=-8'), { area: 5, depth: -8 });
  assert.deepEqual(parseVomWeights(''), {});
  assert.ok(VOM_WEIGHT_KEYS.includes('interactive'));
  assert.throws(() => parseVomWeights('nope=1'), /未知 VOM 权重/);
  assert.throws(() => parseVomWeights('text=abc'), /权重值不合法/);
});

test('自定义权重影响打分', () => {
  const node = { interactive: true, role: 'button', name: 'OK', rect: { x: 0, y: 0, w: 40, h: 20 } };
  const normal = scoreVomNode(node).score;
  const custom = scoreVomNode(node, { interactive: 100, semanticRole: 0, area: 0 }).score;
  assert.notEqual(normal, custom);
  assert.ok(custom > normal);
});
