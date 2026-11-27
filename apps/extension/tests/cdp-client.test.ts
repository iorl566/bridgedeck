// tests/cdp-client.test.ts —— chrome.debugger 通道单测（假 chrome.debugger，无真实浏览器）。
//
// 覆盖：attach 成功/重复/并发去重、命令超时、错误归一（busy/forbidden/no-tab/detached）、
// 子 session（Target.setAutoAttach + 嵌套 attachedToTarget + detachedFromTarget 清理）、
// 状态陈旧重挂重试、空闲软分离、teardown/dispose、不可用降级。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_ATTACH_PARAMS,
  CdpClient,
  CdpError,
  normalizeCdpError,
} from '../src/cdp/index.ts';
import type { CdpEventSource, CdpTarget, ChromeDebuggerApi } from '../src/cdp/index.ts';

interface CommandCall {
  target: CdpTarget;
  method: string;
  params: Record<string, unknown>;
}

type EventListener = (source: CdpEventSource, method: string, params: Record<string, unknown>) => void;
type DetachListener = (source: CdpEventSource, reason: string) => void;

/** 假 chrome.debugger：记录调用、可脚本化失败、可手动发事件。 */
class FakeDebugger implements ChromeDebuggerApi {
  attachCalls: Array<{ target: CdpTarget; version: string }> = [];
  detachCalls: CdpTarget[] = [];
  commands: CommandCall[] = [];
  attachImpl: (target: CdpTarget, version: string) => Promise<void> = async () => {};
  detachImpl: (target: CdpTarget) => Promise<void> = async () => {};
  commandImpl: (target: CdpTarget, method: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({});
  private readonly eventListeners = new Set<EventListener>();
  private readonly detachListeners = new Set<DetachListener>();
  readonly onEvent = {
    addListener: (listener: EventListener): void => { this.eventListeners.add(listener); },
    removeListener: (listener: EventListener): void => { this.eventListeners.delete(listener); },
  };
  readonly onDetach = {
    addListener: (listener: DetachListener): void => { this.detachListeners.add(listener); },
    removeListener: (listener: DetachListener): void => { this.detachListeners.delete(listener); },
  };

  async attach(target: CdpTarget, version: string): Promise<void> {
    this.attachCalls.push({ target, version });
    await this.attachImpl(target, version);
  }

  async detach(target: CdpTarget): Promise<void> {
    this.detachCalls.push(target);
    await this.detachImpl(target);
  }

  async sendCommand(target: CdpTarget, method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ target, method, params: params ?? {} });
    return this.commandImpl(target, method, params ?? {});
  }

  emitEvent(source: CdpEventSource, method: string, params: Record<string, unknown> = {}): void {
    for (const listener of [...this.eventListeners]) listener(source, method, params);
  }

  emitDetach(source: CdpEventSource, reason: string): void {
    for (const listener of [...this.detachListeners]) listener(source, reason);
  }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('attach：同一 tab 重复/并发 attach 只调用一次 chrome.debugger.attach（1.3）', async () => {
  const api = new FakeDebugger();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  api.attachImpl = async () => { await gate; };
  const client = new CdpClient({ api, idleDetachMs: 0 });
  const first = client.attach(1);
  const second = client.attach(1);
  await tick();
  assert.equal(api.attachCalls.length, 1, '并发 attach 必须去重');
  assert.equal(api.attachCalls[0]?.version, '1.3');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b, '并发调用应拿到同一个会话状态');
  assert.equal(client.isAttached(1), true);
  assert.equal(client.attachedCount(), 1);
  // 已挂载后再次 attach 直接复用，不再调用浏览器 API。
  await client.attach(1);
  assert.equal(api.attachCalls.length, 1);
  await client.dispose();
});

test('attach 失败归一：busy / forbidden / no-tab 有稳定 code，且不重试', async () => {
  const cases: Array<[string, string]> = [
    ['Another debugger is already attached to the tab with id: 3', 'E_CDP_BUSY'],
    ['Cannot access a chrome:// URL', 'E_CDP_FORBIDDEN'],
    ['No tab with id: 9', 'E_CDP_NO_TAB'],
  ];
  for (const [message, code] of cases) {
    const api = new FakeDebugger();
    api.attachImpl = async () => { throw new Error(message); };
    const client = new CdpClient({ api, idleDetachMs: 0 });
    await assert.rejects(client.attach(3), (error: unknown) => {
      assert.ok(error instanceof CdpError);
      assert.equal(error.code, code);
      return true;
    });
    assert.equal(api.attachCalls.length, 1, '不可重试错误不应反复 attach');
    await client.dispose();
  }
});

test('超时：attach / send 都归一为 E_CDP_TIMEOUT，不产生未捕获拒绝', async () => {
  const api = new FakeDebugger();
  api.attachImpl = () => new Promise<void>(() => {});
  const attachClient = new CdpClient({ api, attachTimeoutMs: 20, idleDetachMs: 0 });
  await assert.rejects(attachClient.attach(1), (error: unknown) => {
    assert.ok(error instanceof CdpError);
    assert.equal(error.code, 'E_CDP_TIMEOUT');
    return true;
  });
  await attachClient.dispose();

  const api2 = new FakeDebugger();
  api2.commandImpl = () => new Promise(() => {});
  const client = new CdpClient({ api: api2, defaultTimeoutMs: 20, idleDetachMs: 0 });
  await client.attach(1);
  await assert.rejects(client.send(1, 'Page.getFrameTree'), (error: unknown) => {
    assert.ok(error instanceof CdpError);
    assert.equal(error.code, 'E_CDP_TIMEOUT');
    assert.equal(error.method, 'Page.getFrameTree');
    return true;
  });
  await client.dispose();
});

test('send：debugger is not attached 视为本地状态陈旧 → 丢掉状态、重挂并重试一次', async () => {
  const api = new FakeDebugger();
  let attempts = 0;
  api.commandImpl = async (_target, method) => {
    if (method !== 'Page.getFrameTree') return {};
    attempts += 1;
    if (attempts === 1) throw new Error('Debugger is not attached to the tab with id: 1');
    return { frameTree: { frame: { id: 'ROOT', url: 'http://a/' } } };
  };
  const client = new CdpClient({ api, idleDetachMs: 0 });
  await client.attach(1);
  const tree = await client.send<{ frameTree: { frame: { id: string } } }>(1, 'Page.getFrameTree');
  assert.equal(tree.frameTree.frame.id, 'ROOT');
  assert.equal(attempts, 2, '应重试一次');
  assert.equal(api.attachCalls.length, 2, '应重挂一次');
  await client.dispose();
});

test('子 session：flatten autoAttach 发现 OOPIF，嵌套 attachedToTarget 递归附加，detachedFromTarget 清理', async () => {
  const api = new FakeDebugger();
  api.commandImpl = async (target, method) => {
    if (method === 'Target.setAutoAttach' && !target.sessionId) {
      assert.equal(AUTO_ATTACH_PARAMS['flatten'], true);
      api.emitEvent({ tabId: 7 }, 'Target.attachedToTarget', {
        sessionId: 'S1',
        targetInfo: { targetId: 'T1', type: 'iframe', url: 'http://b/outer.html' },
      });
      return {};
    }
    if (method === 'Target.setAutoAttach' && target.sessionId === 'S1') {
      api.emitEvent({ tabId: 7, sessionId: 'S1' }, 'Target.attachedToTarget', {
        sessionId: 'S1-child',
        targetInfo: { targetId: 'T2', type: 'iframe', url: 'http://b/inner.html' },
      });
      return {};
    }
    return {};
  };
  const client = new CdpClient({
    api,
    idleDetachMs: 0,
    sleep: async (ms) => { await tick(ms); },
  });
  await client.ensureAutoAttach(7);
  const sessions = await client.waitForSessions(7, { settleMs: 0, timeoutMs: 500 });
  assert.deepEqual(sessions.map((session) => session.sessionId).sort(), ['S1', 'S1-child']);
  const nested = sessions.find((session) => session.sessionId === 'S1-child');
  assert.equal(nested?.parentSessionId, 'S1');
  assert.equal(nested?.url, 'http://b/inner.html');
  api.emitEvent({ tabId: 7 }, 'Target.detachedFromTarget', { sessionId: 'S1' });
  assert.equal(client.sessions(7).length, 0, '父 session 分离应连带清理子 session');
  await client.disableAutoAttach(7);
  await client.dispose();
});

test('teardown：detach / 外部 onDetach / dispose 清理状态、计时器与监听', async () => {
  const api = new FakeDebugger();
  const client = new CdpClient({ api, idleDetachMs: 0 });
  const reasons: string[] = [];
  const off = client.onDetach(1, (reason) => { reasons.push(reason); });
  await client.acquire(1, 'test');
  assert.equal(client.isAttached(1), true);
  assert.deepEqual(client.activeFeatures(1), ['test']);
  assert.equal(await client.detach(1), true);
  assert.equal(api.detachCalls.length, 1);
  assert.equal(client.isAttached(1), false);
  // 外部分离（DevTools 接管 / 标签页关闭）→ 清状态 + 通知监听器。
  await client.attach(1);
  api.emitDetach({ tabId: 1 }, 'target_closed');
  assert.equal(client.isAttached(1), false);
  assert.deepEqual(reasons, ['target_closed']);
  off();
  // dispose 幂等且解绑事件监听。
  await client.attach(1);
  await client.dispose();
  await client.dispose();
  assert.equal(client.isAttached(1), false);
  api.emitDetach({ tabId: 1 }, 'ignored');
  assert.deepEqual(reasons, ['target_closed'], 'dispose 后不再回调');
});

test('空闲软分离：feature 持有期间不 detach；release 后经过 idle 窗口才 detach', async () => {
  const api = new FakeDebugger();
  const client = new CdpClient({ api, idleDetachMs: 20 });
  await client.acquire(1, 'long-task');
  await tick(60);
  assert.equal(api.detachCalls.length, 0, '持有 feature 时不应分离');
  client.release(1, 'long-task');
  await tick(60);
  assert.equal(api.detachCalls.length, 1, '空闲窗口后应软分离');
  assert.equal(client.isAttached(1), false);
  await client.dispose();
});

test('不可用降级：没有 chrome.debugger 时 available=false，attach/send 抛 E_CDP_UNAVAILABLE', async () => {
  const client = new CdpClient({ api: null });
  assert.equal(client.available(), false);
  assert.deepEqual(client.status(1), { available: false, attached: false, sessions: 0, features: [] });
  await assert.rejects(client.attach(1), (error: unknown) => {
    assert.ok(error instanceof CdpError);
    assert.equal(error.code, 'E_CDP_UNAVAILABLE');
    return true;
  });
  await assert.rejects(client.send(1, 'Page.getFrameTree'), (error: unknown) => {
    assert.ok(error instanceof CdpError);
    assert.equal(error.code, 'E_CDP_UNAVAILABLE');
    return true;
  });
  await client.dispose();
});

test('normalizeCdpError：保留已归一错误；默认 E_CDP_COMMAND；退化为字符串也不炸', () => {
  const original = new CdpError('E_CDP_TIMEOUT', 'x', { method: 'm' });
  assert.equal(normalizeCdpError(original), original);
  const failed = normalizeCdpError(new Error('Something odd'), { method: 'Page.getFrameTree' });
  assert.equal(failed.code, 'E_CDP_COMMAND');
  assert.equal(failed.method, 'Page.getFrameTree');
  assert.match(failed.message, /Something odd/);
  const degraded = normalizeCdpError('plain string', { phase: 'attach' });
  assert.equal(degraded.code, 'E_CDP_ATTACH');
  assert.equal(degraded.retryable, false);
});
