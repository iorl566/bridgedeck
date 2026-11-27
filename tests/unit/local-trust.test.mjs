import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalTrustApi } from '../../daemon/local-trust.js';

function make() {
  const trust = { token: '', strict: false, pairedAt: 0, pendingUntil: 0, pendingCode: '', browserId: '', commitTxn: '', commitUntil: 0, rotationToken: '', rotationTxn: '', rotationUntil: 0 };
  const dropped = [];
  const api = createLocalTrustApi({
    getLocalTrust: () => trust,
    saveLocalTrust: () => {},
    createPairCode: () => '123456',
    wsUrlFor: () => 'ws://local',
    LOCAL_PAIR_TTL_MS: 300000,
    instances: new Map([['i1', { localVerified: false, conn: { close: () => dropped.push('i1') } }]]),
    dropInstance: () => {},
    pairCodeMatches: (expected, actual) => expected === actual,
    log: () => {},
    crypto: { randomBytes: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex') },
  });
  return { trust, api, dropped };
}

test('localPairCreate 生成 token/确认码', () => {
  const { trust, api } = make();
  const result = api.localPairCreate({});
  assert.equal(result.ok, true);
  assert.equal(result.code, '123456');
  assert.ok(trust.token);
  assert.equal(api.localPairCodeRequired(), true);
  assert.equal(api.localPairCodeValid({ pairCode: '123456' }), true);
  assert.equal(api.localPairCodeValid({ pairCode: '000000' }), false);
});

test('localPairVerified 过期 pending 后失效', () => {
  const { trust, api } = make();
  trust.token = 'tok';
  trust.pendingUntil = 1;
  assert.equal(api.localPairVerified('tok'), false);
});

test('localTrustSet strict 关闭未验证实例', () => {
  const { trust, api, dropped } = make();
  api.localTrustSet({ strict: true });
  assert.equal(trust.strict, true);
  assert.deepEqual(dropped, ['i1']);
});
