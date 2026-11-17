import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRuntimeClassification,
  listExtensionJs,
  readReferenceOnly,
} from '../../tools/lib/extension-runtime.mjs';

test('每个扩展 JS 都属于运行时可执行路径', () => {
  const { runtime, reference, all, problems } = checkRuntimeClassification();
  assert.deepEqual(problems, []);
  // 参考镜像已物理移到 reference/extension-mirror；extension/ 里只应剩运行时。
  assert.equal(Object.keys(reference).length, 0);
  assert.equal(runtime.size, all.length);
  assert.ok(runtime.size > 0);
});

test('参考镜像目录不再被 extension 引用', () => {
  const { runtime } = checkRuntimeClassification();
  const reference = readReferenceOnly();
  const all = new Set(listExtensionJs());
  for (const file of Object.keys(reference)) {
    assert.ok(all.has(file), '参考镜像文件不存在：' + file);
    assert.ok(!runtime.has(file), '参考镜像不能同时是运行时模块：' + file);
  }
});
