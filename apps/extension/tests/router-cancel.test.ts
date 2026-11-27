// tests/router-cancel.test.ts —— 命令路由器的取消语义（真实 E2E 20t 的回归防线）。
//
// operation.cancel / cancel 必须绕过同 tab 串行队：否则取消命令会排在它要取消的
// 等待命令之后，表现成“取消永远找不到进行中的 operation”。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter } from '../src/runtime/router.ts';
import type { DaemonCommandFrame } from '../src/daemon/ws.ts';

function frame(method: string, params: Record<string, unknown>, id = 'f1'): DaemonCommandFrame {
  return { type: 'cmd', id, method, params, timeoutMs: 5000 } as DaemonCommandFrame;
}

test('router：operation.cancel 不被同 tab 串行队阻塞', async () => {
  const router = new CommandRouter();
  let release: (() => void) | null = null;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  router.register('wait-for-element', async () => {
    await blocker;
    return { satisfied: false };
  });
  router.register('operation.cancel', () => {
    release?.();
    return { cancelled: true };
  });
  const waiting = router.handle(frame('wait-for-element', { tabId: 7, selector: '#x' }, 'wait-1'));
  // 同一 tab 的另一个动作必须排队；取消必须立即返回。
  const cancellations = await router.handle(frame('operation.cancel', { tabId: 7, id: 'op-1' }, 'cancel-1'));
  assert.equal(cancellations.ok, true);
  if (cancellations.ok) assert.deepEqual(cancellations.result, { cancelled: true });
  const waited = await waiting;
  assert.equal(waited.ok, true);
  assert.equal((waited as { result: { satisfied: boolean } }).result.satisfied, false);
});

test('router：普通变更命令仍按 tab 串行（顺序执行）', async () => {
  const router = new CommandRouter();
  const order: string[] = [];
  router.register('click', async () => {
    order.push('click-start');
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push('click-end');
    return { ok: true };
  });
  router.register('fill', async () => {
    order.push('fill-start');
    return { ok: true };
  });
  const first = router.handle(frame('click', { tabId: 7 }, 'c1'));
  const second = router.handle(frame('fill', { tabId: 7 }, 'c2'));
  await Promise.all([first, second]);
  assert.deepEqual(order, ['click-start', 'click-end', 'fill-start']);
});

test('router：串行命令抛错后不阻塞后续命令', async () => {
  const router = new CommandRouter();
  let calls = 0;
  router.register('click', async () => {
    calls += 1;
    throw new Error('boom');
  });
  const failed = await router.handle(frame('click', { tabId: 7 }, 'a'));
  assert.equal(failed.ok, false);
  const second = await router.handle(frame('click', { tabId: 7 }, 'b'));
  assert.equal(second.ok, false);
  assert.equal(calls, 2);
});

test('router：未注册方法明确 E_UNKNOWN_METHOD', async () => {
  const router = new CommandRouter();
  const outcome = await router.handle(frame('nope', { tabId: 7 }, 'x'));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, 'E_UNKNOWN_METHOD');
});
