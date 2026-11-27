import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dependencyGraph, fileLines, findCycles, listSourceFiles } from '../../tools/lib/architecture.mjs';
import { listMethods } from '../../lib/method-catalog.mjs';
import { needsReceipt } from '../../extension/src/lib/receipt-methods.js';

const ALLOW_LARGE = new Set([
  'extension/src/generated/protocol.js',
  'extension/src/browser-driver/chromium-cdp.js',
]);

test('extension/src 无循环依赖', () => {
  const cycles = findCycles(dependencyGraph());
  assert.deepEqual(cycles, [], '存在循环依赖：' + JSON.stringify(cycles.slice(0, 3)));
});

test('extension/src 文件复杂度预算', () => {
  for (const file of listSourceFiles()) {
    if (ALLOW_LARGE.has(file)) continue;
    const lines = fileLines(file);
    assert.ok(lines <= 1100, file + ' 过大：' + lines + ' 行，应拆分');
  }
});

test('method catalog 与 receipt 契约一致', () => {
  const mismatches = listMethods().filter((entry) => entry.receipt !== needsReceipt(entry.method));
  assert.deepEqual(mismatches, []);
});

test('lib 不反向依赖 tools/bridge/dispatch', () => {
  const graph = dependencyGraph();
  for (const [file, deps] of graph) {
    if (!file.includes('/lib/')) continue;
    for (const dep of deps) {
      assert.ok(!dep.endsWith('/bridge.js') && !dep.endsWith('/dispatch.js') && !dep.includes('/tools/'), file + ' 反向依赖 ' + dep);
    }
  }
});

test('没有源文件被写成占位符/编码字符串', () => {
  for (const file of listSourceFiles()) {
    const text = fs.readFileSync(file, 'utf8').trim();
    assert.ok(text.length > 20 && text !== 'utf8', file + ' 内容异常');
  }
});
