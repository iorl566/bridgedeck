import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_MIN_PROTOCOL, featureMatrix, featuresForCall, featureShortfall } from '../../lib/protocol-features.mjs';

const compare = (a, b) => {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  if (!Number.isFinite(pa[0]) || !Number.isFinite(pb[0])) return null;
  return pa[0] - pb[0] || (pa[1] || 0) - (pb[1] || 0);
};

test('feature matrix exposes every gated feature with availability', () => {
  const old = featureMatrix({ protocol: '1.8' }, compare);
  assert.equal(old.unverified.available, false);
  assert.equal(old.unverified.required, FEATURE_MIN_PROTOCOL.unverified);
  assert.equal(old.unverified.actual, '1.8');
  const current = featureMatrix({ protocol: '1.9' }, compare);
  for (const feature of Object.keys(FEATURE_MIN_PROTOCOL)) assert.equal(current[feature].available, true, feature);
  assert.equal(featureMatrix({}, compare).unverified.available, false);
});

test('a call derives only the features it actually requests', () => {
  assert.deepEqual(featuresForCall('read', {}), ['read']);
  assert.deepEqual(featuresForCall('observe', { unverified: true, expect: [{}], delta: true }).sort(), ['expect', 'observe-delta', 'unverified']);
  assert.deepEqual(featuresForCall('click', {}), []);
});

test('featureShortfall names the missing feature and both protocols', () => {
  const missing = featureShortfall({ protocol: '1.8' }, ['read'], compare);
  assert.deepEqual(missing, [{ feature: 'read', required: '1.9', actual: '1.8' }]);
});
