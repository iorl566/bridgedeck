// tests/unit/extension-parity-classification.test.mjs —— borrow/cooperate 能力面已具备，矩阵按 contract partial(P1) 记账。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_FLOORS, FEATURE_PARAM_RULES, FEATURE_META } from '../../lib/method-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('借用确认：confirmationTimeoutMs 触发 borrow_confirmation_timeout 参数门（floor 1.9）', () => {
  assert.equal(FEATURE_FLOORS.borrow_confirmation_timeout, '1.9');
  const rule = FEATURE_PARAM_RULES.find((item) => item.feature === 'borrow_confirmation_timeout');
  assert.ok(rule, '缺少 borrow_confirmation_timeout 参数级特性门');
  assert.equal(rule.param, 'confirmationTimeoutMs');
  assert.equal(rule.kind, 'defined');
  assert.deepEqual(rule.methods, ['tab.borrow']);
  assert.ok(FEATURE_META.borrow_confirmation_timeout);
});

test('daemon 在扩展派发前执行 requireFeatures（参数门真实生效）', () => {
  const dispatch = read('daemon/extension-dispatch.js');
  assert.match(dispatch, /requireFeatures\(route\.instance, method, route\.params\)/);
  const server = read('daemon/server.mjs');
  assert.match(server, /function requireFeatures\(/);
  assert.match(server, /assertProtocolCompatible\(instance, method, params, compareProtocol\)/);
});

test('cooperate：控制策略 target/strict/auto 已实现（超集）', () => {
  const control = read('extension/src/control.js');
  assert.match(control, /params\.policy === 'strict'/);
  assert.match(control, /params\.policy === 'target'/);
  assert.match(control, /params\.policy === 'auto'/);
});

test('矩阵把 borrow/cooperate 记为 partial + P1（能力存在，契约形状不同）', () => {
  const matrix = JSON.parse(read('tools/bsk-diff/matrix.json'));
  for (const id of ['extension:borrow', 'extension:cooperate']) {
    const row = matrix.rows.find((item) => item.id === id);
    assert.ok(row, '缺少矩阵行 ' + id);
    assert.equal(row.status, 'partial');
    assert.equal(row.priority, 'P1');
  }
});
