// tests/unit/network-runtime-wiring.test.mjs —— W3-A 新模块的运行时调用点守卫。
//
// 防注水规则要求"每个新增模块至少被一个运行时路径消费"。这里不 mock 任何东西：
// 直接读运行时入口源码，断言 import token 与函数调用 token 同时存在，并且把消费链
// （扩展 RPC → CLI/MCP 命令）也钉住，防止以后重构把模块悄悄变成死代码。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function expectTokens(relative, tokens) {
  const text = source(relative);
  for (const token of tokens) {
    assert.equal(text.includes(token), true, relative + ' 缺少 token: ' + token);
  }
}

test('扩展运行时：network.js 消费 waterfall 计时与 WS 帧索引', () => {
  expectTokens('extension/src/network.js', [
    "from './lib/network-waterfall.js'",
    'buildWaterfall(',
    'timingsForEntry(',
    "from './lib/network-ws-index.js'",
    'createWebSocketIndex(',
    'wsIndex.addFrame(',
    'wsIndex.query(',
    'wsIndex.listSockets(',
    'wsIndex.findByRequestId(',
    'networkWebSockets(',
  ]);
  const text = source('extension/src/network.js');
  for (const method of [
    'Network.dataReceived',
    'Network.responseReceived',
    'Network.loadingFinished',
    'Network.webSocketFrameSent',
    'Page.frameAttached',
    'Page.frameNavigated',
  ]) {
    assert.equal(text.includes("'" + method + "'"), true, 'network.js 未订阅 ' + method);
  }
});

test('规则运行时：rules.js 消费 DNR 离线评估器（预检 + 条件单源）', () => {
  expectTokens('extension/src/rules.js', [
    "from './lib/network-rule-eval.js'",
    'preflightRules(',
    'conditionFromRule(',
    'preflight: preflightForTab(',
    'const mapped = dnrRuleOf(rule, tabId)',
  ]);
  const text = source('extension/src/rules.js');
  assert.equal(text.includes('dnrRuleOf('), true);
  assert.equal(text.includes('chrome.declarativeNetRequest.updateSessionRules'), true);
});

test('Node 运行时：HAR 导出/导入/重放分别消费 normalize 与 plan', () => {
  expectTokens('lib/har.mjs', [
    "from './har-normalize.mjs'",
    'normalizeHarEntry(',
    'exportHarFromArchive(',
  ]);
  expectTokens('lib/har-import.mjs', [
    "from './har-normalize.mjs'",
    'normalizeHarWithCorrelation(',
    'attachWebSocketMessages(',
    'correlateHarEntries(',
  ]);
  expectTokens('lib/har-replay.mjs', [
    "from './har-normalize.mjs'",
    "from './har-plan.mjs'",
    'buildHarReplayPlan(',
    'executeHarReplayPlan(',
  ]);
});

test('HAR 端到端消费链：debug.request → debug har → har-import', () => {
  expectTokens('cli/commands/debug.mjs', ['buildHar(', 'importHar(']);
  expectTokens('extension/src/debug.js', ['networkWebSockets({ tabId, frameLimit: 200 })']);
  expectTokens('cli/commands/network.mjs', ['parseHarReplayEntries(', 'findHarReplayEntry(']);
  expectTokens('mcp/tools-debug-a.mjs', ['parseHarReplayEntries(', 'findHarReplayEntry(']);
  // debug.request 的结果里带 webSocket/timings/frame，buildHar 才有保真数据可用
  expectTokens('extension/src/network.js', [
    'webSocket, webSocketMessages: webSocket.frames',
    'timings,',
    'frame: entry.frameId == null ? null : frameView(state, entry.frameId)',
  ]);
});

test('trace 运行时：summary/v3/viewer 三个入口消费 span 树', () => {
  expectTokens('lib/trace-summary.mjs', [
    "from './trace-spans.mjs'",
    'buildSpanTree(',
    'summarizeSpans(',
    'querySpans(',
  ]);
  expectTokens('lib/trace-v3.mjs', [
    "from './trace-spans.mjs'",
    'buildSpanTree(',
    'criticalPath(',
    'querySpans(',
  ]);
  expectTokens('lib/trace-viewer.mjs', [
    "from './trace-spans.mjs'",
    'summarizeSpans(',
    'querySpans(',
    'renderSpans(',
  ]);
  expectTokens('cli/commands/trace.mjs', ['summarizeTrace(', 'renderTraceHtml(']);
  expectTokens('cli/commands/record.mjs', ['buildTraceV3(']);
});

test('waterfall 单源：Node 侧入口复用扩展实现，不复制逻辑', () => {
  const text = source('lib/network-waterfall.mjs');
  assert.equal(text.includes("from '../extension/src/lib/network-waterfall.js'"), true);
  assert.equal(text.includes('export {'), true);
  assert.equal(text.includes('function buildWaterfall'), false);
});
