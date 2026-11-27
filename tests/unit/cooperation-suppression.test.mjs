import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureSuppression, captureSuppression } from '../../extension/src/lib/capture-suppression.js';
import { openOverlay, closeOverlay, getOverlayState } from '../../extension/src/overlay-state.js';
import { withOverlaysHidden } from '../../extension/src/overlay-suppress.js';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

// overlay-suppress 的真实接线测试：只 stub chrome.scripting.executeScript，
// 记录 hide=true/false 的调用序列（真实模块，非副本）。
const applied = [];
globalThis.chrome = {
  scripting: {
    async executeScript(options) {
      applied.push(options && options.args ? options.args[1] : undefined);
      return [];
    },
  },
};

/** 可手动 flush 的 rAF 队列：一帧一帧推进，验证 2 帧 ack。 */
function createFrameQueue() {
  const queue = [];
  const raf = (callback) => { queue.push(callback); };
  const flush = (frames = 1) => {
    for (let index = 0; index < frames; index += 1) {
      const batch = queue.splice(0, queue.length);
      for (const callback of batch) callback();
    }
  };
  return { raf, flush, queued: () => queue.length };
}

test('acquire/release 引用计数：2 帧 ack 前不生效，计数归零才解除', () => {
  const frames = createFrameQueue();
  const store = createCaptureSuppression({ raf: frames.raf });
  const first = store.acquire(1, { owner: 'screenshot' });
  assert.equal(first.ok, true);
  assert.equal(first.count, 1);
  assert.equal(first.effective, false, 'acquire 后不应立即生效');
  assert.equal(store.snapshot(1).pending.length, 1);
  frames.flush(1);
  assert.equal(store.snapshot(1).effective, false, '一帧后还不应生效');
  assert.equal(store.snapshot(1).pending.length, 1);
  frames.flush(1);
  const acked = store.snapshot(1);
  assert.equal(acked.effective, true, '两帧后应生效');
  assert.equal(acked.acked, 1);
  assert.equal(acked.frame, 2);
  assert.deepEqual(acked.pending, []);

  const second = store.acquire(1, { owner: 'native-input' });
  assert.equal(second.count, 2);
  const releasedOne = store.release(1, first.token);
  assert.equal(releasedOne.count, 1);
  assert.equal(releasedOne.disabled, false, '还有引用时不应解除');
  const releasedAll = store.release(1, second.token);
  assert.equal(releasedAll.count, 0);
  assert.equal(releasedAll.disabled, true);
  assert.equal(store.snapshot(1).active, false);
});

test('重复/未知 release 返回结构化结果而不是抛异常（幂等）', () => {
  const frames = createFrameQueue();
  const store = createCaptureSuppression({ raf: frames.raf });
  const lease = store.acquire(2);
  assert.equal(store.release(2, lease.token).disabled, true);
  const again = store.release(2, lease.token);
  assert.equal(again.ok, true);
  assert.equal(again.released, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.count, 0);
  const unknown = store.release(2, 'not-a-token');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.duplicate, true);
  const wrongTab = store.release(99, lease.token);
  assert.equal(wrongTab.ok, true);
  assert.equal(wrongTab.count, 0);
});

test('不带 token 的 release 释放最近一次引用（兼容计数减一语义）', () => {
  const frames = createFrameQueue();
  const store = createCaptureSuppression({ raf: frames.raf });
  const first = store.acquire(3);
  const second = store.acquire(3);
  const released = store.release(3);
  assert.equal(released.released, true);
  assert.equal(released.releasedOwner, second.owner);
  assert.equal(store.snapshot(3).holders.length, 1);
  assert.equal(store.snapshot(3).holders[0].token, first.token);
  store.release(3, first.token);
});

test('owner 标签随引用记录，并出现在 holders/pending', () => {
  const frames = createFrameQueue();
  const store = createCaptureSuppression({ raf: frames.raf });
  const first = store.acquire(4, { owner: 'shot' });
  const second = store.acquire(4, { owner: 'pointer' });
  const snapshot = store.snapshot(4);
  assert.deepEqual(snapshot.holders.map((holder) => holder.owner), ['shot', 'pointer']);
  assert.deepEqual(snapshot.pending.map((entry) => entry.owner), ['shot', 'pointer']);
  frames.flush(2);
  assert.deepEqual(store.pending(4), []);
  store.release(4, first.token);
  store.release(4, second.token);
});

test('按 tab 隔离，list 只列出活跃 tab', () => {
  const store = createCaptureSuppression({ raf: () => {} });
  store.acquire(10);
  store.acquire(11);
  assert.deepEqual(store.list().map((entry) => entry.tabId), [10, 11]);
  store.release(10);
  assert.deepEqual(store.list().map((entry) => entry.tabId), [11]);
  assert.equal(store.snapshot(10).active, false);
  store.release(11);
  assert.deepEqual(store.list(), []);
});

test('单 tab 引用超上限返回 E_CAPTURE_LIMIT，不会无限增长', () => {
  const store = createCaptureSuppression({ raf: () => {}, maxPerTab: 2 });
  assert.equal(store.acquire(20).ok, true);
  assert.equal(store.acquire(20).ok, true);
  const overflow = store.acquire(20);
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'E_CAPTURE_LIMIT');
  assert.equal(store.snapshot(20).count, 2);
});

test('releaseAll 清空该 tab 的全部引用', () => {
  const frames = createFrameQueue();
  const store = createCaptureSuppression({ raf: frames.raf });
  store.acquire(21);
  store.acquire(21);
  const cleared = store.releaseAll(21);
  assert.equal(cleared.released, 2);
  assert.equal(cleared.disabled, true);
  assert.equal(store.snapshot(21).active, false);
});

test('非法 tabId 返回结构化错误', () => {
  const store = createCaptureSuppression();
  const lease = store.acquire('nope');
  assert.equal(lease.ok, false);
  assert.equal(lease.code, 'E_CAPTURE_BAD_TAB');
  const snapshot = store.snapshot(null);
  assert.equal(snapshot.active, false);
  assert.deepEqual(snapshot.pending, []);
});

test('overlay-suppress 接线：嵌套隐藏只 apply 一次，最后一个引用释放才恢复', async () => {
  openOverlay(31, 'help', { priority: 1 });
  applied.length = 0;
  let innerDone = false;
  await withOverlaysHidden(31, async () => {
    assert.deepEqual(applied, [true], '外层应先隐藏一次');
    await withOverlaysHidden(31, async () => {
      assert.deepEqual(applied, [true], '嵌套抑制不应重复隐藏');
      innerDone = true;
    });
    assert.equal(innerDone, true);
    assert.deepEqual(applied, [true], '内层释放后不应提前恢复');
  });
  assert.deepEqual(applied, [true, false], '最后一个引用释放后才恢复浮层');
  assert.equal(getOverlayState(31).capturing, false, 'capture 锁应归零');
  closeOverlay(31, 'help');
});

test('overlay-suppress 接线：fn 抛错时引用也会释放（无泄漏）', async () => {
  openOverlay(32, 'help', { priority: 1 });
  applied.length = 0;
  await assert.rejects(() => withOverlaysHidden(32, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(applied, [true, false]);
  assert.equal(captureSuppression.snapshot(32).active, false, '异常路径没有释放引用');
  assert.equal(getOverlayState(32).capturing, false, 'capture 锁泄漏');
  closeOverlay(32, 'help');
});

test('默认单例与 overlay-suppress 共用同一份计数', async () => {
  openOverlay(33, 'help', { priority: 1 });
  await withOverlaysHidden(33, async () => {
    const snapshot = captureSuppression.snapshot(33);
    assert.equal(snapshot.active, true, '单例里看不到 overlay-suppress 的引用');
    assert.deepEqual(snapshot.holders.map((holder) => holder.owner), ['overlay-suppress']);
  });
  assert.equal(captureSuppression.snapshot(33).active, false);
  closeOverlay(33, 'help');
});

// 真实 Chromium DOM：引用计数抑制 + 2 帧 ack + passthrough 单次消费。
test('真实 Chromium DOM：引用计数抑制与 passthrough 令牌', { skip: !findBrowser() }, async () => {
  const result = await runHeadlessPage('tests/browser/cooperation-suppression.html', { timeoutMs: 15000 });
  assert.match(result.title, /^COOP_SUP_OK:\d+$/, result.title + '\n' + String(result.stderr || '').slice(0, 600));
});
