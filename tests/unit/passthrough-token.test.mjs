import test from 'node:test';
import assert from 'node:assert/strict';
import { createPassthroughTokens, passthroughTokens, TOKEN_ERROR } from '../../extension/src/lib/passthrough-token.js';

/** 可注入时钟 + 确定性 token 的存储，便于验证过期与有界驱逐。 */
function makeStore(options = {}) {
  let clock = 1000;
  let sequence = 0;
  const store = createPassthroughTokens({
    now: () => clock,
    ttlMs: 1000,
    cap: 4,
    idFactory: () => 'tok-' + (sequence += 1),
    ...options,
  });
  return {
    store,
    advance(ms) { clock += ms; },
    now() { return clock; },
  };
}

test('mint：签发带 grantee/TTL 的一次性令牌', () => {
  const { store } = makeStore();
  const minted = store.mint({ grantee: 'agent', ttlMs: 500 });
  assert.equal(minted.ok, true);
  assert.equal(minted.grantee, 'agent');
  assert.equal(minted.expiresAt - minted.at, 500);
  assert.match(minted.token, /^tok-/);
  assert.equal(minted.evicted, 0);
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].token, minted.token, '短 token 打码后应保持原值');
  assert.equal(listed[0].used, false);
});

test('consume 单次使用；verify 只读不消费', () => {
  const { store } = makeStore();
  const { token } = store.mint({ grantee: 'tab:1' });
  const verified = store.verify(token, 'tab:1');
  assert.equal(verified.ok, true);
  assert.equal(verified.used, false);
  assert.equal(verified.remainingMs > 0, true);
  assert.equal(store.verify(token, 'tab:1').ok, true, 'verify 不应消费令牌');
  const first = store.consume(token, 'tab:1');
  assert.equal(first.ok, true);
  assert.equal(first.token, token);
  const second = store.consume(token, 'tab:1');
  assert.equal(second.ok, false);
  assert.equal(second.code, TOKEN_ERROR.USED);
});

test('过期令牌拒绝并清理记录', () => {
  const { store, advance } = makeStore();
  const { token } = store.mint({ grantee: 'g', ttlMs: 100 });
  advance(100);
  const expired = store.consume(token, 'g');
  assert.equal(expired.ok, false);
  assert.equal(expired.code, TOKEN_ERROR.EXPIRED);
  assert.equal(store.list().length, 0, '过期记录应被清理');
});

test('verify 过期判定只读：不删除记录', () => {
  const { store, advance } = makeStore();
  const { token } = store.mint({ grantee: 'g', ttlMs: 100 });
  advance(100);
  assert.equal(store.verify(token, 'g').code, TOKEN_ERROR.EXPIRED);
  assert.equal(store.list().length, 1, 'verify 不应改存储');
});

test('grantee 越权拒绝且不消耗令牌', () => {
  const { store } = makeStore();
  const { token } = store.mint({ grantee: 'tab:1' });
  assert.equal(store.consume(token, 'tab:2').code, TOKEN_ERROR.GRANTEE);
  assert.equal(store.verify(token, 'tab:2').code, TOKEN_ERROR.GRANTEE);
  assert.equal(store.consume(token, 'tab:1').ok, true, '越权尝试不应消耗令牌');
});

test('未知/非法 token 与缺失 grantee 返回结构化错误', () => {
  const { store } = makeStore();
  assert.equal(store.consume('nope', 'g').code, TOKEN_ERROR.UNKNOWN);
  assert.equal(store.verify('nope', 'g').code, TOKEN_ERROR.UNKNOWN);
  assert.equal(store.consume('', 'g').code, TOKEN_ERROR.BAD_ARG);
  assert.equal(store.verify(undefined).code, TOKEN_ERROR.BAD_ARG);
  assert.equal(store.mint({}).code, TOKEN_ERROR.BAD_ARG);
  assert.equal(store.mint({ grantee: '   ' }).code, TOKEN_ERROR.BAD_ARG);
  assert.equal(store.revoke('').code, TOKEN_ERROR.BAD_ARG);
});

test('有界存储：超过上限时驱逐最早签发的令牌（fail closed）', () => {
  const { store } = makeStore({ cap: 2 });
  const first = store.mint({ grantee: 'g' });
  store.mint({ grantee: 'g' });
  const third = store.mint({ grantee: 'g' });
  assert.equal(third.evicted, 1);
  assert.equal(store.list().length, 2);
  const evicted = store.consume(first.token, 'g');
  assert.equal(evicted.code, TOKEN_ERROR.UNKNOWN);
  assert.equal(store.consume(third.token, 'g').ok, true);
});

test('revoke / clearGrantee / clear 清理租约', () => {
  const { store } = makeStore();
  const first = store.mint({ grantee: 'tab:1' });
  const second = store.mint({ grantee: 'tab:2' });
  assert.equal(store.revoke(first.token).revoked, true);
  assert.equal(store.revoke(first.token).revoked, false, '重复 revoke 幂等');
  assert.equal(store.consume(first.token, 'tab:1').code, TOKEN_ERROR.UNKNOWN);
  const cleared = store.clearGrantee('tab:2');
  assert.equal(cleared.revoked, 1);
  assert.equal(store.list().length, 0);
  store.mint({ grantee: 'tab:3' });
  assert.equal(store.clear().cleared, 1);
  assert.equal(second.ok, true);
});

test('计数器记录签发/消费/过期/驱逐', () => {
  const { store, advance } = makeStore({ cap: 2 });
  store.mint({ grantee: 'g', ttlMs: 100 });
  store.mint({ grantee: 'g', ttlMs: 100 });
  store.mint({ grantee: 'g', ttlMs: 100 }); // 驱逐最早一条
  const counter = store.counter();
  assert.equal(counter.minted, 3);
  assert.equal(counter.live, 2);
  advance(100);
  store.prune();
  assert.equal(store.counter().expired >= 1, true);
});

test('默认单例可直接签发/消费（cooperation 共用）', () => {
  const minted = passthroughTokens.mint({ grantee: 'coop:unit' });
  assert.equal(minted.ok, true);
  assert.equal(passthroughTokens.verify(minted.token, 'coop:unit').ok, true);
  assert.equal(passthroughTokens.consume(minted.token, 'coop:unit').ok, true);
  assert.equal(passthroughTokens.verify(minted.token, 'coop:unit').code, TOKEN_ERROR.USED);
  const listed = passthroughTokens.list('coop:unit');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].used, true);
  assert.equal(passthroughTokens.clearGrantee('coop:unit').revoked, 1, '已消费的租约也应在清理时撤销');
});
