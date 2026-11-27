// packages/protocol/test/gate-parity.test.ts —— 兼容闸门（特性门/决策/异常）差分测试。
//
// 对拍对象是 lib/protocol-features.mjs：同一批 (peer, method, params) 输入，TS 实现
// 必须给出逐字段相同的 features / missing / floor / message / data。覆盖：
// - 1.7/1.8/1.9/2.0、数字形式、空白形式、无法解析、缺字段、null peer；
// - 方法级门（read/plan/video.*/network.replay/debug.*）、参数级门
//   （unverified/expect/delta/stream/segmented/staleAttempts）、未知方法；
// - 自定义 compare（恒 null = 不可比较、恒正 = 总是满足）与默认 compare；
// - assertProtocolCompatible 抛出的 message/code/data 与 JS 侧普通 Error 一致。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as ts from '../src/index.ts';
import type { ProtocolPeer } from '../src/types.ts';

const jsFeatures: any = await import('../../../lib/protocol-features.mjs');
const jsCatalog: any = await import('../../../lib/method-catalog.mjs');

type PeerInput = ProtocolPeer | null | undefined;

const PEERS: readonly { label: string; peer: PeerInput }[] = [
  { label: '1.8', peer: { protocol: '1.8' } },
  { label: '1.9', peer: { protocol: '1.9' } },
  { label: '1.7', peer: { protocol: '1.7' } },
  { label: '2.0', peer: { protocol: '2.0' } },
  { label: '1.10', peer: { protocol: '1.10' } },
  { label: '数字 1.9', peer: { protocol: 1.9 } },
  { label: '空白 1.9', peer: { protocol: ' 1.9 ' } },
  { label: '空串', peer: { protocol: '' } },
  { label: '无 protocol 字段', peer: {} },
  { label: 'null peer', peer: null },
  { label: 'undefined peer', peer: undefined },
  { label: '无法解析', peer: { protocol: 'abc' } },
];

const METHODS: readonly string[] = [
  'read',
  'plan',
  'video.start',
  'video.status',
  'screenshot',
  'screenshot.read',
  'longshot.recover',
  'network.replay',
  'debug.history',
  'debug.pin',
  'click',
  'observe',
  'section',
  'bogus.method',
];

const PARAM_SETS: readonly { label: string; params: Readonly<Record<string, unknown>> }[] = [
  { label: '空参数', params: {} },
  { label: 'unverified=true', params: { unverified: true } },
  { label: 'unverified=false', params: { unverified: false } },
  { label: 'expect=[x]', params: { expect: ['#a'] } },
  { label: 'expect=[]', params: { expect: [] } },
  { label: 'expect=字符串', params: { expect: '#a' } },
  { label: 'delta=true', params: { delta: true } },
  { label: 'delta=字符串', params: { delta: 'true' } },
  { label: 'stream=true', params: { stream: true } },
  { label: 'segmented=true', params: { segmented: true } },
  { label: 'staleAttempts=0', params: { staleAttempts: 0 } },
  { label: 'staleAttempts=undefined', params: { staleAttempts: undefined } },
  { label: 'stream+segmented+staleAttempts', params: { stream: true, segmented: true, staleAttempts: 2 } },
];

function allCases(): { peer: PeerInput; peerLabel: string; method: string; params: Readonly<Record<string, unknown>>; paramsLabel: string }[] {
  const cases = [];
  for (const { label: peerLabel, peer } of PEERS) {
    for (const method of METHODS) {
      for (const { label: paramsLabel, params } of PARAM_SETS) {
        cases.push({ peer, peerLabel, method, params, paramsLabel });
      }
    }
  }
  return cases;
}

const CASES = allCases();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('featuresForCall：方法级门 + 参数级门逐用例一致', () => {
  for (const item of CASES) {
    const expected = clone(jsFeatures.featuresForCall(item.method, item.params));
    const actual = clone(ts.featuresForCall(item.method, item.params));
    assert.deepEqual(actual, expected, item.method + ' / ' + item.paramsLabel + ' 的特性推导不一致');
  }
});

test('methodFeature / floorForFeature / featureMetaOf 与 JS 迁移源一致', () => {
  for (const method of CASES.map((item) => item.method)) {
    assert.equal(ts.methodFeature(method), jsFeatures.methodFeature(method), method + ' 方法级门不一致');
  }
  assert.equal(ts.methodFeature('read'), 'read');
  assert.equal(ts.methodFeature('click'), null);
  assert.equal(ts.methodFeature('bogus.method'), null);
  assert.equal(ts.methodFeature(null), null);
  assert.equal(ts.floorForFeature('video'), '1.9');
  assert.equal(ts.floorForFeature('nope'), null);
  assert.equal(ts.featureMetaOf('video')?.label, '视频录制');
  assert.equal(ts.featureMetaOf('nope'), null);
  assert.deepEqual([...ts.methodsGatedBy('video')], [...jsCatalog.FEATURE_METHODS.video]);
  assert.deepEqual(ts.methodsGatedBy('nope'), []);
  assert.equal(ts.isFeatureName('har'), true);
  assert.equal(ts.isFeatureName('nope'), false);
});

test('featureShortfall / requiredFloorFor：默认与自定义 compare 一致', () => {
  const compares: { label: string; compare: (a: unknown, b: unknown) => number | null }[] = [
    { label: '默认', compare: ts.compareProtocol },
    { label: '恒 null', compare: () => null },
    { label: '恒正', compare: () => 1 },
    { label: '恒负', compare: () => -1 },
  ];
  for (const item of CASES) {
    const features = ts.featuresForCall(item.method, item.params);
    for (const { label, compare } of compares) {
      assert.deepEqual(
        clone(ts.featureShortfall(item.peer, features, compare)),
        clone(jsFeatures.featureShortfall(item.peer, features, compare)),
        item.method + ' / ' + label + ' 的缺口不一致',
      );
      assert.deepEqual(
        clone(ts.requiredFloorFor(features, compare)),
        clone(jsFeatures.requiredFloorFor(features, compare)),
        item.method + ' / ' + label + ' 的 required floor 不一致',
      );
    }
  }
});

test('featureMatrix：全 peer × 全特性一致', () => {
  for (const { label, peer } of PEERS) {
    assert.deepEqual(
      clone(ts.featureMatrix(peer)),
      clone(jsFeatures.featureMatrix(peer)),
      label + ' 的特性可用性矩阵不一致',
    );
  }
});

test('protocolGate：全用例决策逐字段一致', () => {
  for (const item of CASES) {
    const actual = ts.protocolGate(item.peer, item.method, item.params);
    const expected = jsFeatures.protocolGate(item.peer, item.method, item.params);
    assert.deepEqual(clone(actual), clone(expected),
      item.peerLabel + ' / ' + item.method + ' / ' + item.paramsLabel + ' 的闸门决策不一致');
  }
});

test('protocolGate 负例：1.8 客户端被 gated 能力明确拒绝', () => {
  const gatedCases = [
    { method: 'read', params: {}, feature: 'read' },
    { method: 'plan', params: {}, feature: 'plan' },
    { method: 'video.start', params: {}, feature: 'video' },
    { method: 'network.replay', params: {}, feature: 'har' },
    { method: 'debug.history', params: {}, feature: 'debug.journal' },
    { method: 'click', params: { unverified: true }, feature: 'unverified' },
    { method: 'click', params: { expect: ['#a'] }, feature: 'expect' },
    { method: 'observe', params: { delta: true }, feature: 'observe-delta' },
    { method: 'screenshot', params: { stream: true }, feature: 'capture.stream' },
    { method: 'screenshot', params: { segmented: true }, feature: 'capture.stream' },
    { method: 'screenshot', params: { staleAttempts: 3 }, feature: 'capture.stream' },
  ];
  for (const item of gatedCases) {
    const decision = ts.protocolGate({ protocol: '1.8' }, item.method, item.params);
    assert.equal(decision.ok, false, item.method + ' 必须被 1.8 拒绝');
    if (decision.ok) continue;
    assert.equal(decision.code, ts.PROTOCOL_UNSUPPORTED);
    assert.equal(decision.missing[0]?.feature, item.feature, item.method + ' 缺失特性不符');
    assert.equal(decision.floor, ts.FEATURE_FLOORS[item.feature as keyof typeof ts.FEATURE_FLOORS]);
    assert.equal(decision.data.actual, '1.8');
    assert.ok(decision.message.includes('E_PROTOCOL_UNSUPPORTED'));
  }
  // 1.9 客户端同样的调用必须放行。
  for (const item of gatedCases) {
    const decision = ts.protocolGate({ protocol: '1.9' }, item.method, item.params);
    assert.equal(decision.ok, true, item.method + ' 不应被 1.9 拒绝');
  }
  // 无特性门的普通方法在 1.8 上也放行。
  for (const method of ['click', 'observe', 'get-html', 'session.start']) {
    assert.equal(ts.protocolGate({ protocol: '1.8' }, method, {}).ok, true, method + ' 在 1.8 上应放行');
  }
});

test('assertProtocolCompatible：通过/拒绝与 JS 抛错逐字段一致', () => {
  for (const item of CASES) {
    const expectedError = expectThrow(() => jsFeatures.assertProtocolCompatible(item.peer, item.method, item.params));
    const actualError = expectThrow(() => ts.assertProtocolCompatible(item.peer, item.method, item.params));
    if (!expectedError) {
      assert.equal(actualError, null, item.method + ' 应通过却抛错：' + String(actualError));
      continue;
    }
    assert.ok(actualError, item.method + ' 应拒绝却通过');
    if (!actualError) continue;
    assert.equal(actualError.message, expectedError.message, '错误 message 不一致');
    assert.equal(actualError.code, expectedError.code, '错误 code 不一致');
    assert.deepEqual(clone(actualError.data), clone(expectedError.data), '错误 data 不一致');
  }
});

test('TS 结构化错误：ProtocolError 类型守卫与数据提取', () => {
  try {
    ts.assertProtocolCompatible({ protocol: '1.8' }, 'video.start');
    assert.fail('必须抛出 ProtocolError');
  } catch (error) {
    assert.ok(ts.isProtocolError(error), '必须是 ProtocolError');
    assert.ok(error instanceof ts.ProtocolError);
    assert.equal(error.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.equal(error.data.method, 'video.start');
    assert.equal(error.data.required, '1.9');
    assert.equal(ts.isProtocolUnsupportedError(error), true);
    const data = ts.protocolErrorDataOf(error);
    assert.ok(data);
    assert.equal(data.feature, 'video');
    // JS 侧普通 Error（只有 code/data）也要被识别。
    const jsLike = Object.assign(new Error('x'), { code: 'E_PROTOCOL_UNSUPPORTED', data: { code: 'E_PROTOCOL_UNSUPPORTED' } });
    assert.equal(ts.isProtocolUnsupportedError(jsLike), true);
    assert.ok(ts.protocolErrorDataOf(jsLike));
    assert.equal(ts.isProtocolError({ code: 'E_OTHER' }), false);
    assert.equal(ts.protocolErrorDataOf(null), null);
  }
});

test('compatibilityMatrix：与 JS 一致且 1.8 全拒绝 / 1.9 全放行', () => {
  const actual = ts.compatibilityMatrix();
  const expected = jsFeatures.compatibilityMatrix();
  assert.deepEqual(clone(actual), clone(expected));
  assert.deepEqual(actual.versions, ['1.8', '1.9']);
  assert.equal(actual.baseline, '1.8');
  assert.equal(actual.current, '1.9');
  assert.equal(actual.ok, true);
  assert.equal(actual.counts['1.8']?.allowed, 0, '1.8 客户端必须一个门都不放行');
  assert.equal(actual.counts['1.9']?.denied, 0, '1.9 客户端必须全部放行');
  for (const row of actual.features) {
    assert.equal(row.allowed['1.8'], false, row.feature + ' 不应在 1.8 可用');
    assert.equal(row.allowed['1.9'], true, row.feature + ' 应在 1.9 可用');
  }
  // 自定义比较器：把 1.8 当满足 → ok=false，证明矩阵的 ok 不是常量。
  const permissive = ts.compatibilityMatrix(() => 1);
  assert.equal(permissive.ok, false, '1.8 全放行时矩阵必须判不 ok');
  assert.equal(permissive.counts['1.8']?.allowed, ts.FEATURE_NAMES.length);
});

/** 执行函数并返回捕获的错误（没有抛错返回 null）。 */
function expectThrow(run: () => unknown): { message: string; code?: unknown; data?: unknown } | null {
  try {
    run();
    return null;
  } catch (error) {
    return error as { message: string; code?: unknown; data?: unknown };
  }
}
