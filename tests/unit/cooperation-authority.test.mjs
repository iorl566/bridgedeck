import test from 'node:test';
import assert from 'node:assert/strict';
import { beginCooperationPassthrough, endCooperationPassthrough, setCooperationBlocked } from '../../extension/src/cooperation.js';
import { clearControlGeneration, controlGeneration } from '../../extension/src/control-generation.js';

// 模拟 content/cooperation.js 的 authority 语义：低于权威代 → stale；同代/更高 → 接受。
const authority = new Map();
const sent = [];
const hardStaleTabs = new Set();

globalThis.chrome = {
  tabs: {
    async sendMessage(tabId, message) {
      sent.push({ tabId, message });
      if (message.generation === undefined) return { ok: true };
      if (hardStaleTabs.has(tabId)) return { ok: false, stale: true, generation: 999999 };
      const current = authority.get(tabId) || 0;
      if (Number(message.generation) < current) return { ok: false, stale: true, generation: current };
      authority.set(tabId, Math.max(current, Number(message.generation)));
      if (message.type === 'bb.cooperation.block') {
        return { ok: true, blocked: message.blocked === true, generation: authority.get(tabId) };
      }
      return { ok: true, pending: 1, generation: authority.get(tabId) };
    },
  },
};

const generationsFor = (tabId) => sent.filter((item) => item.tabId === tabId).map((item) => item.message.generation);
const reset = () => { sent.length = 0; };

test('service worker 重启后 generation 回退：自动抬到内容权威代 +1 并重试', async () => {
  reset();
  authority.set(11, 7);
  const blocked = await setCooperationBlocked(11, true, controlGeneration(11));
  assert.equal(blocked, true);
  assert.deepEqual(generationsFor(11), [0, 8]);
  assert.equal(controlGeneration(11), 8);
  clearControlGeneration(11);
  authority.delete(11);
});

test('passthrough 同样对齐 authority，结束租约不带 generation', async () => {
  reset();
  authority.set(12, 3);
  const lease = await beginCooperationPassthrough(12, controlGeneration(12));
  assert.ok(lease && typeof lease === 'string');
  assert.deepEqual(generationsFor(12), [0, 4]);
  assert.equal(controlGeneration(12), 4);
  await endCooperationPassthrough(12, lease);
  const last = sent[sent.length - 1];
  assert.equal(last.tabId, 12);
  assert.equal(last.message.type, 'bb.cooperation.passthrough');
  assert.equal(last.message.active, false);
  assert.equal(last.message.generation, undefined);
  clearControlGeneration(12);
  authority.delete(12);
});

test('无法对齐时动作 fail closed，输入锁按无锁降级不抛错', async () => {
  reset();
  hardStaleTabs.add(13);
  await assert.rejects(
    () => beginCooperationPassthrough(13, 0),
    (error) => error && error.code === 'E_COOPERATION_STALE',
  );
  const blocked = await setCooperationBlocked(13, true, 0);
  assert.equal(blocked, false);
  hardStaleTabs.delete(13);
  clearControlGeneration(13);
});

test('generation 已是最新时只发一次消息', async () => {
  reset();
  authority.set(14, 0);
  const blocked = await setCooperationBlocked(14, false, 2);
  assert.equal(blocked, false);
  assert.deepEqual(generationsFor(14), [2]);
  assert.equal(controlGeneration(14), 0);
  authority.delete(14);
});
