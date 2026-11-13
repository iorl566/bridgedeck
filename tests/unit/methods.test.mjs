import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_METHODS,
  SESSION_METHODS,
  INSTANCE_METHODS,
  EXT_METHODS,
  SESSION_QUEUE_BYPASS,
  isMutating,
  methodScope,
  validateMethodRegistry,
} from '../../lib/methods.mjs';
import { METHOD_EFFECT } from '../../lib/protocol.mjs';

test('方法分类清单无漂移（protocol-check 同源）', () => {
  assert.deepEqual(validateMethodRegistry(), []);
});

test('methodScope 覆盖 local / session / instance', () => {
  assert.equal(methodScope('status'), 'local');
  assert.equal(methodScope('session.pause'), 'local');
  assert.equal(methodScope('observe'), 'session');
  assert.equal(methodScope('window.newAgent'), 'instance');
  assert.equal(methodScope('no.such.method'), null);
});

test('session 与 instance 不重叠，local 与扩展方法不重叠', () => {
  for (const method of SESSION_METHODS) assert.equal(INSTANCE_METHODS.has(method), false, method);
  for (const method of LOCAL_METHODS) assert.equal(EXT_METHODS.has(method), false, method);
});

test('所有扩展方法都有协议效果分类', () => {
  for (const method of EXT_METHODS) assert.ok(METHOD_EFFECT[method], method);
});

test('isMutating 分类保持稳定', () => {
  for (const method of ['observe', 'screenshot', 'status', 'get-html', 'ledger.status', 'actionable', 'debug.rule_list']) {
    assert.equal(isMutating(method), false, method);
  }
  for (const method of ['click', 'fill', 'navigate', 'tab.close', 'session.start', 'plan', 'debug.rule_add', 'window.newAgent']) {
    assert.equal(isMutating(method), true, method);
  }
});

test('队列旁路方法都有路由归属', () => {
  for (const method of SESSION_QUEUE_BYPASS) {
    assert.ok(SESSION_METHODS.has(method) || LOCAL_METHODS.has(method), method);
  }
});
