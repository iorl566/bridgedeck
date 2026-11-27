// 真实 DOM 证据：引用计数 capture 抑制（2 帧 ack）+ passthrough 令牌单次消费。
// 加载真实的 extension/content/cooperation.js 输入锁，验证抑制生效时滚轮被拦截、
// 嵌套释放不会提前恢复、归零后才恢复；passthrough 令牌只用一次、过期/越权被拒。
import { createCaptureSuppression } from '../../extension/src/lib/capture-suppression.js';
import { createPassthroughTokens } from '../../extension/src/lib/passthrough-token.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// headless --dump-dom 只推进约一帧 rAF，所以帧源用 rAF + setTimeout 兜底：
// 保证 2 帧 ack 在真实浏览器 DOM 里可观测；精确的“两帧”语义由 Node 单测
// 注入帧队列验证（tests/unit/cooperation-suppression.test.mjs）。
const frameRaf = (callback) => {
  let called = false;
  const run = () => { if (called) return; called = true; callback(); };
  requestAnimationFrame(run);
  setTimeout(run, 50);
};
const nextFrame = () => new Promise((resolve) => frameRaf(resolve));
const raf2 = async () => { await nextFrame(); await nextFrame(); };
const fail = (message) => { throw new Error(message); };
const assert = (value, message) => { if (!value) fail(message); };
const coop = () => globalThis.__bbCooperation;
const wheel = () => {
  const event = new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const key = (value) => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('2 帧 ack：acquire 后 pending 可观测，两帧后才生效', async () => {
  const store = createCaptureSuppression({ raf: frameRaf });
  const lease = store.acquire(91, { owner: 'dom-ack' });
  assert(lease.ok === true && lease.count === 1, 'acquire 失败：' + JSON.stringify(lease));
  assert(lease.effective === false, 'acquire 后不应立即生效');
  let snapshot = store.snapshot(91);
  assert(snapshot.active === true && snapshot.effective === false, '抑制状态不对');
  assert(snapshot.pending.length === 1 && snapshot.pending[0].owner === 'dom-ack', 'pending 列表缺失');
  assert(snapshot.frame === 0, 'ack 帧计数应为 0');
  await raf2();
  snapshot = store.snapshot(91);
  assert(snapshot.effective === true, '两帧后仍未生效');
  assert(snapshot.pending.length === 0 && snapshot.acked === 1, 'ack 未清空 pending');
  assert(snapshot.frame === 2, 'ack 帧数应为 2：' + snapshot.frame);
  const released = store.release(91, lease.token);
  assert(released.count === 0 && released.disabled === true, '归零未解除');
  assert(store.snapshot(91).active === false && store.snapshot(91).effective === false, '解除后状态不对');
});

test('引用计数抑制：真实输入锁在归零前保持滚轮拦截', async () => {
  const store = createCaptureSuppression({ raf: frameRaf });
  // 模拟 overlay-suppress 的接线：首个 acquire 上锁，归零时才解锁。
  const first = store.acquire(92, { owner: 'screenshot' });
  if (first.count === 1) coop().setBlocked(true);
  const second = store.acquire(92, { owner: 'native-input' });
  assert(second.count === 2, '嵌套计数不对：' + second.count);
  await raf2();
  assert(wheel() === true, '抑制生效后滚轮没有被拦截');
  const releasedOne = store.release(92, first.token);
  assert(releasedOne.count === 1 && releasedOne.disabled === false, '嵌套释放一次就提前解除');
  assert(wheel() === true, '嵌套释放一次后滚轮不应恢复');
  const releasedAll = store.release(92, second.token);
  assert(releasedAll.count === 0 && releasedAll.disabled === true, '归零未解除');
  if (releasedAll.count === 0) coop().setBlocked(false);
  assert(wheel() === false, '归零后滚轮仍被拦截');
  assert(store.release(92, second.token).duplicate === true, '重复 release 不幂等');
});

test('capture shield：生效后 keydown 被拦截，归零后恢复', async () => {
  const store = createCaptureSuppression({ raf: frameRaf });
  let effective = false;
  const shield = (event) => { if (effective) event.preventDefault(); };
  window.addEventListener('keydown', shield, true);
  try {
    const lease = store.acquire(93, { owner: 'record' });
    assert(key('a') === false, 'ack 前不应拦截键盘');
    await raf2();
    effective = store.snapshot(93).effective;
    assert(effective === true, '两帧后抑制未生效');
    assert(key('a') === true, '抑制生效后 keydown 没有被拦截');
    store.release(93, lease.token);
    effective = store.snapshot(93).effective;
    assert(key('a') === false, '归零后 keydown 仍被拦截');
  } finally {
    window.removeEventListener('keydown', shield, true);
  }
});

test('passthrough 令牌：单次消费 + 过期 + 越权', async () => {
  let clock = 1000;
  const tokens = createPassthroughTokens({ now: () => clock, ttlMs: 500, cap: 4 });
  const minted = tokens.mint({ grantee: 'agent:7' });
  assert(minted.ok === true && typeof minted.token === 'string', 'mint 失败');
  assert(tokens.verify(minted.token, 'agent:7').ok === true, 'verify 失败');
  assert(tokens.consume(minted.token, 'agent:8').code === 'E_TOKEN_GRANTEE', '越权未被拒绝');
  assert(tokens.consume(minted.token, 'agent:7').ok === true, '首次消费失败');
  assert(tokens.consume(minted.token, 'agent:7').code === 'E_TOKEN_USED', '重复消费未被拒绝');
  const expiring = tokens.mint({ grantee: 'agent:7', ttlMs: 100 });
  clock += 100;
  assert(tokens.consume(expiring.token, 'agent:7').code === 'E_TOKEN_EXPIRED', '过期未被拒绝');
  assert(tokens.list().length === 1, '过期记录应被清理');
});

test('passthrough 令牌驱动真实输入穿透：消费后释放', async () => {
  coop().setBlocked(true);
  const tokens = createPassthroughTokens();
  const minted = tokens.mint({ grantee: 'coop:0' });
  assert(minted.ok === true, 'mint 失败');
  coop().passThrough(minted.token, true);
  await sleep(0);
  assert(wheel() === false, 'passthrough 期间滚轮仍被拦截');
  assert(tokens.consume(minted.token, 'coop:0').ok === true, '消费失败');
  coop().passThrough(minted.token, false);
  coop().setBlocked(false);
  assert(wheel() === false, '解除后滚轮仍被拦截');
  assert(coop().snapshot().blocked === false, '输入锁没有解除');
});

(async () => {
  while (typeof window.__coopHandler !== 'function') await sleep(10);
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      coop().setBlocked(false);
      coop().passThrough('dom-clean', false);
    } catch (error) {
      coop().setBlocked(false);
      document.title = 'COOP_SUP_FAIL:' + name + ':' + String((error && error.message) || error);
      return;
    }
  }
  document.title = 'COOP_SUP_OK:' + passed;
})();
