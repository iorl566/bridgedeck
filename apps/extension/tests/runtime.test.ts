// tests/runtime.test.ts —— daemon cmd 路由 + 实例/标签页/导航/设置命令（假 browser API）。
//
// 覆盖 E2E 前置链路需要的最小命令面：window.newAgent（session.start 的第一步）、
// window.list（session start 的断言）、navigate、tab.close、settings.get/set；
// 同时验证路由器的三条硬要求：未知方法、同 tab 串行、本地超时。

import test from 'node:test';
import assert from 'node:assert/strict';
import type { DaemonCommandFrame } from '../src/daemon/ws.ts';
import type { DaemonErrorPayload } from '../src/daemon/types.ts';
import { CommandRouter, createCommandRouter } from '../src/runtime/router.ts';
import {
  createRuntimeCommands,
  restrictedUrlReason,
} from '../src/runtime/commands.ts';
import { daemonSettingsView, SettingsStore } from '../src/runtime/settings.ts';
import { RpcMethodError } from '../src/rpc/registry.ts';
import { normalizeSettings } from '../shared/settings.ts';
import { FakeBrowserApi, seedBridgeSettings } from './support/fake-browser.ts';

function frame(method: string, params: Record<string, unknown> = {}, id = 'cmd-1', timeoutMs = 5_000): DaemonCommandFrame {
  return { type: 'cmd', id, method, params, timeoutMs };
}

function makeRouter(): { router: CommandRouter; api: FakeBrowserApi } {
  const api = new FakeBrowserApi();
  const router = new CommandRouter();
  router.registerAll(createRuntimeCommands({ api }));
  return { router, api };
}

async function call(router: CommandRouter, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const outcome = await router.handle(frame(method, params));
  if (!outcome.ok) {
    throw new RpcMethodError(outcome.error.code, outcome.error.message, outcome.error.data);
  }
  return outcome.result;
}

test('CommandRouter：未知方法回 E_UNKNOWN_METHOD，不等待超时', async () => {
  const { router } = makeRouter();
  const outcome = await router.handle(frame('definitely.unknown'));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, 'E_UNKNOWN_METHOD');
    assert.match(outcome.error.message, /definitely\.unknown/);
  }
});

test('CommandRouter：同 tab 串行、不同 tab 并行、读类命令不排队', async () => {
  const order: string[] = [];
  const router = createCommandRouter();
  router.register('slow', async (context) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    order.push('slow:' + String(context.params.tabId));
    return { ok: true };
  });
  router.register('fast', (context) => {
    order.push('fast:' + String(context.params.tabId));
    return { ok: true };
  });
  router.register('observe', () => {
    order.push('observe');
    return { ok: true };
  });

  const first = router.handle(frame('slow', { tabId: 1 }, 'c1'));
  const second = router.handle(frame('fast', { tabId: 1 }, 'c2'));
  const otherTab = router.handle(frame('fast', { tabId: 2 }, 'c3'));
  const read = router.handle(frame('observe', { tabId: 1 }, 'c4'));
  await Promise.all([first, second, otherTab, read]);
  // observe 直接同步执行（豁免队列）；其它 tab 的 fast 走微任务；同 tab 的 fast 必须等 slow。
  assert.deepEqual(order, ['observe', 'fast:2', 'slow:1', 'fast:1']);

  // 队列清空（诊断计数归零）。
  assert.equal(router.queuedTabs(), 0);
});

test('CommandRouter：本地超时返回 E_TIMEOUT；handler 抛 RpcMethodError 保留 code/data', async () => {
  const router = createCommandRouter();
  router.register('hang', () => new Promise(() => { /* 永不返回 */ }), { timeoutMs: 20 });
  const timedOut = await router.handle(frame('hang'));
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.error.code, 'E_TIMEOUT');

  router.register('bad', () => {
    throw new RpcMethodError('E_STALE_REF', 'ref 失效', { ref: '@e1' });
  });
  const failed = await router.handle(frame('bad'));
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.error.code, 'E_STALE_REF');
    assert.deepEqual(failed.error.data, { ref: '@e1' });
  }
});

test('CommandRouter.respond：成功/失败帧通过 responder 回给 daemon', async () => {
  const { router } = makeRouter();
  const results: Array<{ id: string; result: unknown }> = [];
  const errors: Array<{ id: string; error: DaemonErrorPayload }> = [];
  const responder = {
    sendCommandResult: (id: string, result: unknown) => {
      results.push({ id, result });
      return true;
    },
    sendCommandError: (id: string, error: DaemonErrorPayload) => {
      errors.push({ id, error });
      return true;
    },
  };

  assert.equal(await router.respond(frame('window.list', {}, 'ok-1'), responder), true);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, 'ok-1');
  assert.ok(Array.isArray((results[0]?.result as { windows?: unknown[] }).windows));

  // 第四批：dialog.* 已由 background 的 DialogService 接管，不再由 runtime commands 登记；
  // 这里用仍然未迁移的 control-hint 验证失败回包路径。
  assert.equal(await router.respond(frame('control-hint', { tabId: 1 }, 'err-1'), responder), true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.id, 'err-1');
  assert.equal(errors[0]?.error.code, 'E_NOT_IMPLEMENTED');
});

test('window.newAgent / window.list / window.close：会话链路最小形状', async () => {
  const { router, api } = makeRouter();
  const created = await call(router, 'window.newAgent', { noFocus: true }) as Record<string, unknown>;
  assert.equal(typeof created.tabId, 'number');
  assert.equal(typeof created.windowId, 'number');
  assert.equal(created.incognito, false);

  const windows = await call(router, 'window.list') as { windows: Array<Record<string, unknown>> };
  assert.equal(windows.windows.length, 1);
  const agentWindow = windows.windows[0];
  assert.ok(agentWindow);
  assert.equal(agentWindow.windowId, created.windowId);
  assert.equal(agentWindow.focused, false, 'noFocus 时不应聚焦 Agent 窗口');
  assert.equal(agentWindow.type, 'normal');
  const tabs = agentWindow.tabs as Array<Record<string, unknown>>;
  assert.equal(tabs[0]?.tabId, created.tabId);
  assert.equal(tabs[0]?.url, 'about:blank');

  // Agent 窗口登记进 session 存储（tab.list scope 与后续 ensureAgent 依赖它）。
  const stored = api.storage.session.data.get('bb.agentWindows');
  assert.deepEqual(stored, [created.windowId]);

  const listed = await call(router, 'tab.list', {}) as { tabs: Array<Record<string, unknown>> };
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0]?.owned, 'agent');

  await call(router, 'window.close', { windowId: created.windowId });
  const afterClose = await call(router, 'window.list') as { windows: unknown[] };
  assert.equal(afterClose.windows.length, 0);
  assert.deepEqual(api.storage.session.data.get('bb.agentWindows'), []);
});

test('window.newAgent：noFocus 时把焦点还给原前台窗口（Edge 启动早期会抢焦点）', async () => {
  const api = new FakeBrowserApi();
  const original = api.seedWindow({ focused: true });
  // 模拟 Edge 158 启动后 ~1s 内 windows.create 会强制聚焦新窗口的行为。
  api.forceFocusOnCreate = true;
  const router = new CommandRouter();
  // 同步 timer：焦点还原的补一次等待在单测里立即完成。
  router.registerAll(createRuntimeCommands({ api, setTimer: (handler) => { handler(); return 0; } }));

  const created = await call(router, 'window.newAgent', { noFocus: true }) as { windowId: number };
  assert.notEqual(created.windowId, original.id);
  const windows = await call(router, 'window.list') as { windows: Array<Record<string, unknown>> };
  const agent = windows.windows.find((win) => win.windowId === created.windowId);
  const previous = windows.windows.find((win) => win.windowId === original.id);
  assert.equal(agent?.focused, false, 'noFocus 的 Agent 窗口不应保持聚焦');
  assert.equal(previous?.focused, true, '焦点应还给原来的前台窗口');
});

test('window.ensureAgent：复用既有 Agent 窗口；窗口没了才新建', async () => {
  const { router } = makeRouter();
  const first = await call(router, 'window.ensureAgent', { noFocus: true }) as Record<string, unknown>;
  const second = await call(router, 'window.ensureAgent', { noFocus: true }) as Record<string, unknown>;
  assert.equal(second.windowId, first.windowId);
  assert.equal(second.tabId, first.tabId);
  assert.equal(await countWindows(router), 1);

  await call(router, 'window.close', { windowId: first.windowId });
  const third = await call(router, 'window.ensureAgent', { noFocus: true }) as Record<string, unknown>;
  assert.notEqual(third.windowId, first.windowId);
  assert.equal(await countWindows(router), 1);
});

async function countWindows(router: CommandRouter): Promise<number> {
  const result = await call(router, 'window.list') as { windows: unknown[] };
  return result.windows.length;
}

test('navigate：更新 URL 并返回当前状态；受限协议/非法参数被拒绝', async () => {
  const { router, api } = makeRouter();
  const created = await call(router, 'window.newAgent', { noFocus: true }) as { tabId: number };
  const navigated = await call(router, 'navigate', { tabId: created.tabId, url: 'https://example.test/page' }) as Record<string, unknown>;
  assert.equal(navigated.url, 'https://example.test/page');
  assert.equal(api.findTab(created.tabId)?.url, 'https://example.test/page');

  // 同 URL 走 reload（不抛错，仍返回当前 URL）。
  const again = await call(router, 'navigate', { tabId: created.tabId, url: 'https://example.test/page' }) as Record<string, unknown>;
  assert.equal(again.url, 'https://example.test/page');

  for (const url of ['chrome://settings', 'edge://version', 'javascript:alert(1)', 'about:config']) {
    await assert.rejects(call(router, 'navigate', { tabId: created.tabId, url }), (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_FORBIDDEN', '应拒绝受限 URL：' + url);
      return true;
    });
  }
  await assert.rejects(call(router, 'navigate', { tabId: created.tabId, url: '   ' }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_BAD_ARG');
    return true;
  });
  await assert.rejects(call(router, 'navigate', { url: 'https://example.test' }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_BAD_ARG');
    return true;
  });
});

test('restrictedUrlReason：about:blank 放行，其余内部协议拒绝', () => {
  assert.equal(restrictedUrlReason('about:blank'), '');
  assert.equal(restrictedUrlReason('https://example.test'), '');
  assert.equal(restrictedUrlReason('http://127.0.0.1:8080/x'), '');
  assert.notEqual(restrictedUrlReason('about:config'), '');
  assert.notEqual(restrictedUrlReason('chrome://extensions'), '');
  assert.notEqual(restrictedUrlReason('view-source:https://a'), '');
  assert.equal(restrictedUrlReason('not a url'), '无法解析的 URL');
  assert.notEqual(restrictedUrlReason('\u0000chrome://x'), '', 'C0 控制字符不能绕过协议判定');
});

test('tab.close / tab.select：关闭与激活；tab.new 默认不激活（focus 策略）', async () => {
  const { router, api } = makeRouter();
  const created = await call(router, 'window.newAgent', { noFocus: true }) as { tabId: number; windowId: number };
  await call(router, 'tab.close', { tabId: created.tabId });
  assert.equal(api.findTab(created.tabId), null);

  const second = await call(router, 'tab.new', { url: 'about:blank' }) as { tabId: number };
  assert.equal(api.findTab(second.tabId)?.active, false, 'tab.new 默认不应激活新标签页');
  await call(router, 'tab.select', { tabId: second.tabId });
  assert.equal(api.activeTab()?.id, second.tabId);

  const focusedNew = await call(router, 'tab.new', { url: 'about:blank', focus: true }) as { tabId: number };
  assert.equal(api.findTab(focusedNew.tabId)?.active, true, 'focus:true 才激活');
});

test('window.newAgent --incognito 被拒绝时回 E_INCOGNITO_UNAVAILABLE', async () => {
  const api = new FakeBrowserApi();
  // 模拟没有 InPrivate 权限的浏览器：create 返回没有 id 的窗口对象（Chrome 的静默行为）。
  api.windows.create = async () => ({ focused: false, type: 'normal', incognito: true });
  const router = new CommandRouter();
  router.registerAll(createRuntimeCommands({ api }));
  await assert.rejects(call(router, 'window.newAgent', { incognito: true }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_INCOGNITO_UNAVAILABLE');
    return true;
  });
});

test('settings.get/set：daemon 视图 borrowConfirm 投影，人工开关拒绝写入', async () => {
  const api = new FakeBrowserApi();
  seedBridgeSettings(api, { borrowRequireConfirm: false, daemonPort: 53001, controlHint: false, language: 'zh-CN' });
  const settings = new SettingsStore(api.storage.local);
  const router = new CommandRouter();
  router.registerAll(createRuntimeCommands({ api, settings }));

  const view = await call(router, 'settings.get') as { settings: Record<string, unknown>; label: string };
  assert.equal(view.settings.borrowConfirm, false, 'borrowRequireConfirm=false 应投影成 borrowConfirm=false');
  assert.equal(view.settings.controlHint, false);
  assert.equal(view.settings.daemonPort, 53001);
  assert.equal(view.label, '');

  seedBridgeSettings(api, {});
  const fresh = await call(router, 'settings.get') as { settings: Record<string, unknown> };
  assert.equal(fresh.settings.borrowConfirm, true, '默认 borrowConfirm 必须是 true（E2E 第 13 项）');

  await assert.rejects(call(router, 'settings.set', { patch: { borrowConfirm: false } }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_FORBIDDEN');
    assert.match(error.message, /borrowConfirm/);
    return true;
  });
  await assert.rejects(call(router, 'settings.set', { patch: { daemonToken: 'x' } }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_FORBIDDEN');
    return true;
  });

  const updated = await call(router, 'settings.set', { patch: { controlHint: false, borrowRequireConfirm: true } }) as Record<string, unknown>;
  assert.deepEqual(updated.applied, ['controlHint', 'borrowRequireConfirm']);
  const reread = (await settings.read());
  assert.equal(reread.controlHint, false);
  assert.equal(reread.borrowRequireConfirm, true);
});

test('daemonSettingsView：只读投影，不改写 TS 设置本身', () => {
  const input = normalizeSettings({ borrowRequireConfirm: false, controlHint: true, daemonPort: 52900 });
  const view = daemonSettingsView(input);
  assert.equal(view.settings.borrowConfirm, false);
  assert.equal(view.settings.instanceLabel, '');
  assert.equal(view.settings.allowHelp, true);
  assert.equal(input.borrowRequireConfirm, false);
});

test('未迁移命令：control-hint 回 E_NOT_IMPLEMENTED；dialog.* 由 background 接管；debugger.detach 是 no-op', async () => {
  const { router } = makeRouter();
  const outcome = await router.handle(frame('control-hint', { tabId: 1 }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, 'E_NOT_IMPLEMENTED');
    assert.match(outcome.error.message, /尚未迁移/);
  }
  // 第四批迁移后：dialog.* 不再由 runtime commands 登记（background 注册 DialogService），
  // 在这里应当是“未知方法”而不是“未迁移占位”。
  for (const method of ['dialog.arm', 'dialog.disarm', 'dialog.status']) {
    const unregistered = await router.handle(frame(method, { tabId: 1 }));
    assert.equal(unregistered.ok, false, method);
    if (!unregistered.ok) assert.equal(unregistered.error.code, 'E_UNKNOWN_METHOD', method);
  }
  const detached = await call(router, 'debugger.detach', { tabId: 1 }) as Record<string, unknown>;
  assert.equal(detached.ok, true);
  assert.equal(detached.detached, false);
});
