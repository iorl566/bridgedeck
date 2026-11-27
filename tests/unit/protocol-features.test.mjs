import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_FLOORS } from '../../lib/method-catalog.mjs';
import {
  FEATURE_MIN_PROTOCOL,
  PROTOCOL_UNSUPPORTED,
  featureMatrix,
  featureShortfall,
  featuresForCall,
  protocolGate,
} from '../../lib/protocol-features.mjs';

const compare = (a, b) => {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  if (!Number.isFinite(pa[0]) || !Number.isFinite(pb[0])) return null;
  return pa[0] - pb[0] || (pa[1] || 0) - (pb[1] || 0);
};

test('feature matrix exposes every gated feature with availability', () => {
  assert.equal(Object.keys(FEATURE_MIN_PROTOCOL).length, 15);
  assert.equal(Object.keys(FEATURE_FLOORS).length, 15);
  const old = featureMatrix({ protocol: '1.8' }, compare);
  assert.equal(old.unverified.available, false);
  assert.equal(old.unverified.required, FEATURE_MIN_PROTOCOL.unverified);
  assert.equal(old.unverified.actual, '1.8');
  const current = featureMatrix({ protocol: '1.9' }, compare);
  for (const feature of Object.keys(FEATURE_MIN_PROTOCOL)) {
    assert.equal(current[feature].available, true, feature);
    assert.equal(old[feature].available, false, feature);
    assert.equal(old[feature].required, '1.9', feature);
  }
  assert.equal(featureMatrix({}, compare).unverified.available, false);
  assert.equal(featureMatrix({}, compare).video.actual, 'unknown');
});

test('a call derives only the features it actually requests', () => {
  assert.deepEqual(featuresForCall('read', {}), ['read']);
  assert.deepEqual(featuresForCall('observe', { unverified: true, expect: [{}], delta: true }).sort(), ['expect', 'observe-delta', 'unverified']);
  assert.deepEqual(featuresForCall('click', {}), []);
  // 新 gated 能力：方法级 + 参数级
  assert.deepEqual(featuresForCall('video.start', {}), ['video']);
  assert.deepEqual(featuresForCall('debug.history', {}), ['debug.journal']);
  assert.deepEqual(featuresForCall('network.replay', {}), ['har']);
  assert.deepEqual(featuresForCall('screenshot', { stream: true }), ['capture.stream']);
  assert.deepEqual(featuresForCall('screenshot', { segmented: true }), ['capture.stream']);
  assert.deepEqual(featuresForCall('screenshot', {}), []);
});

test('featureShortfall names the missing feature and both protocols', () => {
  const missing = featureShortfall({ protocol: '1.8' }, ['read'], compare);
  // 第二轮起 missing 项只加字段（label/fallback/migration/degradable），既有三字段语义不变。
  assert.equal(missing.length, 1);
  assert.deepEqual(
    { feature: missing[0].feature, required: missing[0].required, actual: missing[0].actual },
    { feature: 'read', required: '1.9', actual: '1.8' },
  );
  assert.equal(missing[0].label, '确定性读取');
  assert.equal(typeof missing[0].migration, 'string');
  assert.equal(missing[0].degradable, true);
  assert.equal(missing[0].fallback.kind, 'method');
  assert.deepEqual(featureShortfall({ protocol: '1.8' }, ['video', 'read'], compare).map((item) => item.feature), ['video', 'read']);
  assert.deepEqual(featureShortfall({ protocol: '1.9' }, ['video'], compare), []);
});

test('protocolGate 用 E_PROTOCOL_UNSUPPORTED 明确拒绝 1.8 客户端的新能力请求', () => {
  const denied = protocolGate({ protocol: '1.8' }, 'video.start', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.code, PROTOCOL_UNSUPPORTED);
  assert.equal(denied.data.feature, 'video');
  assert.match(denied.message, /E_PROTOCOL_UNSUPPORTED/);
  const allowed = protocolGate({ protocol: '1.9' }, 'video.start', {});
  assert.equal(allowed.ok, true);
  assert.equal(allowed.code, null);
  assert.deepEqual(allowed.missing, []);
  // 不依赖特性的旧调用继续可用
  assert.equal(protocolGate({ protocol: '1.8' }, 'click', {}).ok, true);
});
