// tests/unit/mcp-progress.test.mjs —— tools/call 进度通知：分档策略、节流、生命周期与元数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROGRESS_CLASSES,
  PROGRESS_CLASS_BY_TOOL,
  PROGRESS_ENV,
  createProgressSession,
  progressClassFor,
  progressDisabled,
  progressResultMeta,
  progressSnapshot,
  progressTokenFrom,
  resolveProgressPolicy,
} from '../../mcp/progress.mjs';

function fakeEnv(values = {}) {
  return { ...values };
}

function harness({ env = {}, token = 'tok-1', tool = 'browser_screenshot', policy = { timeoutMs: 180_000 }, startAt = 1_000 } = {}) {
  const clock = { value: startAt };
  const timers = [];
  const notifications = [];
  const session = createProgressSession({
    tool,
    token,
    policy,
    env,
    now: () => clock.value,
    notify: (params) => notifications.push(params),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
  });
  return {
    session,
    clock,
    timers,
    notifications,
    activeTimers: () => timers.filter((timer) => !timer.cleared),
    fire(timer) {
      if (timer && !timer.cleared) {
        timer.cleared = true; // 模拟 setTimeout 一次性语义
        timer.fn();
      }
    },
    fireLatest() {
      const active = timers.filter((timer) => !timer.cleared);
      if (active.length) {
        const timer = active.at(-1);
        timer.cleared = true;
        timer.fn();
      }
    },
  };
}

test('进度档位：显式映射优先，未映射按超时派生，未知工具退化为 fast', () => {
  assert.equal(progressClassFor('browser_screenshot', { timeoutMs: 60_000 }), 'stream');
  assert.equal(progressClassFor('browser_observe', { timeoutMs: 60_000 }), 'observe');
  assert.equal(progressClassFor('browser_video_merge', { timeoutMs: 1_000 }), 'stream');
  assert.equal(progressClassFor('browser_plan', { timeoutMs: 60_000 }), 'stream');
  assert.equal(progressClassFor('browser_navigate', { timeoutMs: 60_000 }), 'interactive');
  assert.equal(progressClassFor('browser_some_new_tool', { timeoutMs: 180_000 }), 'stream');
  assert.equal(progressClassFor('browser_some_new_tool', { timeoutMs: 100_000 }), 'observe');
  assert.equal(progressClassFor('browser_some_new_tool', { timeoutMs: 60_000 }), 'interactive');
  assert.equal(progressClassFor('unknown_tool', null), 'fast');
  for (const name of ['browser_screenshot', 'browser_observe', 'browser_video_start']) {
    assert.ok(PROGRESS_CLASS_BY_TOOL[name], name + ' 应有显式档位');
  }
});

test('resolveProgressPolicy：档位参数、环境变量上限与关闭开关', () => {
  const stream = resolveProgressPolicy('browser_screenshot', { timeoutMs: 180_000 }, {});
  assert.equal(stream.class, 'stream');
  assert.equal(stream.firstDelayMs, PROGRESS_CLASSES.stream.firstDelayMs);
  assert.equal(stream.intervalMs, PROGRESS_CLASSES.stream.intervalMs);
  assert.equal(stream.maxNotifications, PROGRESS_CLASSES.stream.maxNotifications);
  assert.equal(stream.enabled, true);

  const capped = resolveProgressPolicy('browser_screenshot', { timeoutMs: 180_000 }, { BB_MCP_PROGRESS_MAX: '3' });
  assert.equal(capped.maxNotifications, 3);
  const huge = resolveProgressPolicy('browser_screenshot', { timeoutMs: 180_000 }, { BB_MCP_PROGRESS_MAX: '999999' });
  assert.equal(huge.maxNotifications, PROGRESS_CLASSES.stream.maxNotifications, '上限只能收紧不能放大');

  assert.equal(progressDisabled({ [PROGRESS_ENV.disable]: 'off' }), true);
  assert.equal(progressDisabled({ [PROGRESS_ENV.disable]: '0' }), true);
  assert.equal(progressDisabled({}), false);
  assert.equal(resolveProgressPolicy('browser_observe', { timeoutMs: 60_000 }, { BB_MCP_PROGRESS: 'off' }).enabled, false);
});

test('progressTokenFrom：string/number 接受，其他类型与超长令牌忽略', () => {
  assert.equal(progressTokenFrom({ _meta: { progressToken: 'abc' } }), 'abc');
  assert.equal(progressTokenFrom({ _meta: { progressToken: 42 } }), 42);
  assert.equal(progressTokenFrom({ _meta: { progressToken: '' } }), null);
  assert.equal(progressTokenFrom({ _meta: { progressToken: { nope: 1 } } }), null);
  assert.equal(progressTokenFrom({ _meta: { progressToken: 'x'.repeat(129) } }), null);
  assert.equal(progressTokenFrom({ _meta: {} }), null);
  assert.equal(progressTokenFrom({}), null);
  assert.equal(progressTokenFrom(null), null);
  assert.equal(progressTokenFrom({ _meta: { progressToken: Number.NaN } }), null);
});

test('无令牌时进度会话是 no-op（不发通知、不影响工具）', () => {
  const h = harness({ token: null });
  assert.equal(h.session.enabled, false);
  h.session.start();
  h.clock.value += 5_000;
  h.session.finish();
  h.session.fail(new Error('x'));
  h.session.cancel('测试');
  assert.deepEqual(h.notifications, []);
  assert.equal(h.session.stats().emitted, 0);
  assert.equal(h.activeTimers().length, 0);
});

test('start 立即发一条 progress=0；心跳按档位延迟与最小间隔节流', () => {
  const h = harness({ token: 'prog-1' });
  h.session.start();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].progressToken, 'prog-1');
  assert.equal(h.notifications[0].progress, 0);
  assert.match(h.notifications[0].message, /browser_screenshot 开始执行/);
  assert.equal(h.notifications[0]._meta['browser-bridge/progress'].class, 'stream');
  assert.equal(h.activeTimers().length, 1);
  assert.equal(h.activeTimers()[0].ms, PROGRESS_CLASSES.stream.firstDelayMs);

  // 首次延迟前不主动发心跳
  h.clock.value += 299;
  assert.equal(h.notifications.length, 1);

  h.clock.value += 1;
  h.fireLatest();
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].progress, 300);
  assert.match(h.notifications[1].message, /运行中/);
  assert.equal(h.activeTimers()[0].ms, PROGRESS_CLASSES.stream.intervalMs);

  h.clock.value += PROGRESS_CLASSES.stream.intervalMs;
  h.fireLatest();
  assert.equal(h.notifications.length, 3);
  assert.equal(h.notifications[2].progress, 800);
  assert.ok(h.notifications[2].progress > h.notifications[1].progress, 'progress 必须单调递增');
  h.session.dispose();
  assert.equal(h.activeTimers().length, 0);
});

test('单次调用有通知上限；finish 的最终通知不受上限影响', () => {
  const h = harness({
    env: { BB_MCP_PROGRESS_MAX: '2' },
    token: 'cap',
    policy: { timeoutMs: 180_000 },
  });
  h.session.start();
  assert.equal(h.notifications.length, 1);
  for (let index = 0; index < 10; index += 1) {
    h.clock.value += PROGRESS_CLASSES.stream.intervalMs;
    h.fireLatest();
  }
  assert.equal(h.notifications.length, 2, '心跳被 maxNotifications 截断');
  assert.equal(h.session.stats().skipped > 0, true);
  h.session.finish();
  assert.equal(h.notifications.length, 3, '最终通知必须发出');
  const final = h.notifications.at(-1);
  assert.match(final.message, /browser_screenshot 完成/);
  assert.equal(final._meta['browser-bridge/progress'].phase, 'final');
  assert.equal(h.activeTimers().length, 0);
});

test('finish/fail/cancel 各自收尾并清理定时器，重复收尾幂等', () => {
  const ok = harness({ token: 'k' });
  ok.session.start();
  ok.clock.value += 1_500;
  ok.session.finish('已写出 2 个分片');
  assert.match(ok.notifications.at(-1).message, /完成（1500ms）：已写出 2 个分片/);
  ok.session.finish();
  assert.equal(ok.notifications.filter((row) => row.message.includes('完成')).length, 1);
  assert.equal(ok.activeTimers().length, 0);

  const failed = harness({ token: 'f', tool: 'browser_observe', policy: { timeoutMs: 60_000 } });
  failed.session.start();
  failed.session.fail(Object.assign(new Error('daemon 挂了'), { code: 'E_DAEMON' }));
  const failMessage = failed.notifications.at(-1).message;
  assert.match(failMessage, /browser_observe 失败：E_DAEMON/);
  assert.equal(failed.session.stats().finalPhase, 'error');

  const cancelled = harness({ token: 'c' });
  cancelled.session.start();
  cancelled.session.cancel('用户取消');
  assert.match(cancelled.notifications.at(-1).message, /已取消（用户取消）/);
  assert.equal(cancelled.session.stats().finalPhase, 'cancelled');
});

test('notify 抛错不影响工具执行与计数', () => {
  const session = createProgressSession({
    tool: 'browser_observe',
    token: 'boom',
    policy: { timeoutMs: 60_000 },
    env: {},
    now: () => 1_000,
    notify: () => { throw new Error('stdout 已关闭'); },
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  session.start();
  session.finish();
  assert.equal(session.stats().emitted, 2);
  assert.equal(session.stats().finalPhase, 'done');
});

test('progressResultMeta 汇总条数/档位/收尾状态', () => {
  const h = harness({ token: 'meta' });
  h.session.start();
  h.session.finish();
  const meta = progressResultMeta(h.session);
  assert.equal(meta.enabled, true);
  assert.equal(meta.class, 'stream');
  assert.equal(meta.emitted, 2);
  assert.equal(meta.finalPhase, 'done');
  assert.equal(meta.maxNotifications, PROGRESS_CLASSES.stream.maxNotifications);
  assert.equal(progressResultMeta(null).enabled, false);
});

test('progressSnapshot 按真实策略分档并统计（server tools/list/initialize 共用）', () => {
  const tools = [
    { name: 'browser_screenshot' },
    { name: 'browser_observe' },
    { name: 'browser_navigate' },
    { name: 'browser_status' },
  ];
  const timeoutByTool = {
    browser_screenshot: 180_000,
    browser_observe: 60_000,
    browser_navigate: 60_000,
    browser_status: 60_000,
  };
  const snapshot = progressSnapshot(tools, {}, (tool) => ({ timeoutMs: timeoutByTool[tool.name] }));
  assert.equal(snapshot.byClass.stream, 1);
  assert.equal(snapshot.byClass.observe, 1);
  assert.equal(snapshot.byClass.interactive, 1);
  assert.equal(snapshot.byClass.fast, 1);
  assert.equal(snapshot.rows.length, 4);
  assert.equal(snapshot.maxNotifications, PROGRESS_CLASSES.stream.maxNotifications);
  assert.equal(snapshot.enabled, true);
  assert.deepEqual(snapshot.classes, ['stream', 'observe', 'interactive', 'fast']);
  const disabled = progressSnapshot(tools, { BB_MCP_PROGRESS: 'off' }, () => ({ timeoutMs: 60_000 }));
  assert.equal(disabled.enabled, false);
});

test('进度通知参数符合 MCP 形状：progressToken/progress/message，且带扩展 _meta', () => {
  const h = harness({ token: 7, tool: 'browser_observe', policy: { timeoutMs: 60_000 } });
  h.session.start();
  const params = h.notifications[0];
  assert.equal(params.progressToken, 7);
  assert.equal(typeof params.progress, 'number');
  assert.equal(typeof params.message, 'string');
  assert.equal(params._meta['browser-bridge/progress'].tool, 'browser_observe');
  assert.equal(typeof params._meta['browser-bridge/progress'].elapsedMs, 'number');
  assert.equal(params.total, undefined, '总时长未知时省略 total');
});
