import test from 'node:test';
import assert from 'node:assert/strict';
import { compareProtocol } from '../../lib/protocol.mjs';
import { FEATURE_MIN_PROTOCOL, featureShortfall, featuresForCall } from '../../lib/protocol-features.mjs';

test('按方法与参数推导特性', () => {
  assert.deepEqual(featuresForCall('click', {}), []);
  assert.deepEqual(featuresForCall('evaluate', { unverified: true }), ['unverified']);
  assert.deepEqual(featuresForCall('click', { expect: [{ target: '@e1' }] }), ['expect']);
  assert.deepEqual(featuresForCall('read', {}), ['read']);
  assert.deepEqual(featuresForCall('plan', {}), ['plan']);
  assert.deepEqual(featuresForCall('observe', { delta: true }), ['observe-delta']);
});

test('旧扩展缺特性时返回缺口，1.9 放行', () => {
  assert.equal(featureShortfall({ protocol: '1.9' }, ['unverified'], compareProtocol).length, 0);
  const older = featureShortfall({ protocol: '1.8' }, ['unverified', 'expect'], compareProtocol);
  assert.deepEqual(older.map((item) => item.feature), ['unverified', 'expect']);
  assert.equal(older[0].required, FEATURE_MIN_PROTOCOL.unverified);
  assert.equal(older[0].actual, '1.8');
  // 未知/缺失协议按缺特性处理，不静默放行。
  assert.equal(featureShortfall({}, ['read'], compareProtocol).length, 1);
});
