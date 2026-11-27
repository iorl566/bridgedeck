// tests/record-service.test.ts —— record.start/stop/list/export 编排（fake tabs/capture/overlay/store）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordService, RecordServiceError, senderTabId, type RecordServiceDeps, type RecordTabInfo } from '../src/record/service.ts';
import { RecordStore } from '../src/record/store.ts';
import type { RecordingSummary } from '../src/record/types.ts';

interface Harness {
  service: RecordService;
  deps: RecordServiceDeps;
  calls: string[];
  tabs: Map<number, RecordTabInfo>;
  store: RecordStore;
  now(): number;
  advance(ms: number): void;
}

function harness(options: { includeAgent?: boolean } = {}): Harness {
  let now = 1_700_000_000_000;
  let idSeq = 0;
  const calls: string[] = [];
  const tabs = new Map<number, RecordTabInfo>([
    [12, { tabId: 12, windowId: 1, url: 'https://example.test/', title: '夹具页' }],
    [13, { tabId: 13, windowId: 2, url: 'https://example.test/other', title: '另一窗口页' }],
  ]);
  const store = new RecordStore({}, {});
  const deps: RecordServiceDeps = {
    now: () => now,
    newId: () => 'rec-' + (++idSeq),
    store,
    tabs: { get: async (tabId) => tabs.get(Number(tabId)) ?? null },
    capture: {
      start: async (tabId, captureOptions) => {
        calls.push('capture.start:' + tabId + ':' + String(captureOptions.includeAgent));
        return 2;
      },
      stop: async (tabId) => {
        calls.push('capture.stop:' + tabId);
        return 1;
      },
    },
    overlay: {
      show: async (tabId) => {
        calls.push('overlay.show:' + tabId);
        return true;
      },
      hide: async (tabId) => {
        calls.push('overlay.hide:' + tabId);
        return true;
      },
    },
    observe: async () => ({ text: '最终状态', url: 'https://example.test/?done=1', refs: 9, at: now }),
    captureScreenshot: async () => ({ dataUrl: 'data:image/jpeg;base64,SHOT', width: 800, height: 600 }),
    log: () => undefined,
  };
  void options;
  return {
    service: new RecordService(deps),
    deps,
    calls,
    tabs,
    store,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function sender(tabId = 12): { tab: { id: number }; frameId: number; documentId: string; url: string } {
  return { tab: { id: tabId }, frameId: 0, documentId: 'doc-' + tabId, url: 'https://example.test/' };
}

test('start：注入录制器 + 显示浮层；重复 start 返回 existing', async () => {
  const h = harness();
  const started = await h.service.start({ tabId: 12, includeAgent: true });
  assert.equal(started.ok, true);
  assert.equal(started.tabId, 12);
  assert.equal(started.includeAgent, true);
  assert.equal(started.captureFrames, 2);
  assert.equal(started.overlay, true);
  assert.deepEqual(h.calls, ['capture.start:12:true', 'overlay.show:12']);
  const status = h.service.status();
  assert.equal(status.active.length, 1);
  assert.equal(status.active[0]?.tabId, 12);
  assert.equal(status.backend, 'memory');

  const again = await h.service.start({ tabId: 12 });
  assert.equal(again.existing, true);
  assert.equal(again.startedAt, started.startedAt);
});

test('start：缺 tabId/不存在/受限页面给出结构化错误', async () => {
  const h = harness();
  await assert.rejects(() => h.service.start({}), (error: unknown) => {
    assert.ok(error instanceof RecordServiceError);
    assert.equal(error.code, 'E_BAD_ARG');
    return true;
  });
  await assert.rejects(() => h.service.start({ tabId: 99 }), (error: unknown) => {
    assert.ok(error instanceof RecordServiceError);
    assert.equal(error.code, 'E_NOT_FOUND');
    return true;
  });
  h.tabs.set(14, { tabId: 14, windowId: 1, url: 'chrome://settings', title: '设置' });
  await assert.rejects(() => h.service.start({ tabId: 14 }), (error: unknown) => {
    assert.ok(error instanceof RecordServiceError);
    assert.equal(error.code, 'E_BAD_ARG');
    return true;
  });
});

test('pushEvent：非活跃 tab 丢弃；活跃 tab 的 click 归一并挂 step', async () => {
  const h = harness();
  assert.deepEqual(h.service.pushEvent({ kind: 'click' }, sender()), { recorded: false, reason: 'not-recording' });
  assert.deepEqual(h.service.pushEvent({ kind: 'click' }, null), { recorded: false, reason: 'no-tab' });
  assert.deepEqual(h.service.pushEvent({ kind: 'click' }, { tab: {} }), { recorded: false, reason: 'no-tab' });

  await h.service.start({ tabId: 12, includeAgent: true });
  const first = h.service.pushEvent({ kind: 'click', selector: '#submit-btn' }, sender());
  assert.equal(first.recorded, true);
  assert.equal(first.merged, false);
  assert.equal(first.seq, 1);
  const session = h.service.sessionOf(12);
  assert.ok(session);
  assert.equal(session.events.length, 1);
  assert.equal(session.events[0]?.selector, '#submit-btn');
  assert.equal(session.events[0]?.boundary.documentId, 'doc-12');
  assert.equal(session.events[0]?.recordStep?.method, 'click');
  assert.equal(session.events[0]?.actor, 'human');

  const second = h.service.pushEvent({ kind: 'click', selector: '#a', seq: 2 }, sender());
  assert.equal(second.seq, 2);
  assert.equal(h.service.sessionOf(12)?.events.length, 2);
  assert.deepEqual(h.service.kindsOf(12), { click: 2 });
});

test('pushEvent：文本/媒体事件归并到上一条动作（20d8）', async () => {
  const h = harness();
  await h.service.start({ tabId: 12, includeAgent: true });
  h.service.pushEvent({ kind: 'click', seq: 1, selector: '#submit-btn' }, sender());
  const text = h.service.pushEvent({
    kind: 'text',
    seq: 1,
    changes: [{ selector: '#out', previous_value: '未提交', value: 'diff-1' }],
  }, sender());
  assert.equal(text.merged, true);
  const media = h.service.pushEvent({
    kind: 'media',
    seq: 1,
    media: { selector: '#media-demo', currentTime: 1.25, duration: 30 },
  }, sender());
  assert.equal(media.merged, true);
  const session = h.service.sessionOf(12);
  assert.equal(session?.events.length, 1);
  assert.equal(session?.events[0]?.textChanges?.length, 1);
  assert.equal(session?.events[0]?.media?.length, 1);
});

test('Agent 过滤：默认过滤 Agent 点击；includeAgent=true 全量记录（20d10）', async () => {
  const h = harness();
  await h.service.start({ tabId: 12 });
  h.deps.agentInputAt = () => h.now() - 100;
  const filtered = h.service.pushEvent({ kind: 'click', selector: '#submit-btn' }, sender());
  assert.equal(filtered.recorded, false);
  assert.equal(filtered.filtered, true);
  assert.equal(h.service.sessionOf(12)?.events.length, 0);

  h.deps.agentInputAt = () => 0;
  const human = h.service.pushEvent({ kind: 'click', actor: 'human', selector: '#other' }, sender());
  assert.equal(human.recorded, true, '可信时钟过期后恢复为 human（不被过滤）');

  const h2 = harness();
  await h2.service.start({ tabId: 12, includeAgent: true });
  h2.deps.agentInputAt = () => h2.now() - 100;
  const recorded = h2.service.pushEvent({ kind: 'click', selector: '#submit-btn' }, sender());
  assert.equal(recorded.recorded, true);
  assert.equal(h2.service.sessionOf(12)?.events[0]?.actor, 'agent');
});

test('noteAgentInput 让后续事件归因 agent（无可信时钟时的兜底）', async () => {
  const h = harness();
  await h.service.start({ tabId: 12 });
  h.service.noteAgentInput(12);
  const filtered = h.service.pushEvent({ kind: 'click' }, sender());
  assert.equal(filtered.filtered, true);
});

test('recordAgentAction：默认过滤，includeAgent 时记录（Agent 动作来源）', async () => {
  const h = harness();
  await h.service.start({ tabId: 12 });
  const filtered = h.service.recordAgentAction(12, 'click', { selector: '#submit-btn' });
  assert.equal(filtered.filtered, true);
  assert.equal(h.service.sessionOf(12)?.events.length, 0);

  const h2 = harness();
  await h2.service.start({ tabId: 12, includeAgent: true });
  const recorded = h2.service.recordAgentAction(12, 'click', { selector: '#submit-btn' });
  assert.equal(recorded.recorded, true);
  assert.equal(h2.service.sessionOf(12)?.events[0]?.actor, 'agent');
});

test('recordTabSwitch：跨窗口 → window-switch，带 from/to windowId（20d5）', async () => {
  const h = harness();
  await h.service.start({ tabId: 12, includeAgent: true });
  await h.service.start({ tabId: 13, includeAgent: true });
  const injected = await h.service.recordTabSwitch(13);
  assert.equal(injected, 1, '给会话 12 注入一次切换');
  const session12 = h.service.sessionOf(12);
  const switchEvent = session12?.events[0];
  assert.equal(switchEvent?.kind, 'window-switch');
  assert.equal(switchEvent?.fromWindowId, 1);
  assert.equal(switchEvent?.toWindowId, 2);
  assert.equal(switchEvent?.fromTabId, 12);
  assert.equal(switchEvent?.toTabId, 13);
  assert.ok(switchEvent?.recordStep?.branch, '切换事件应归类成 branch step');

  // 同窗口切换（13 是另一个窗口，这里补一个同窗口 tab 验证 tab-switch）。
  h.tabs.set(15, { tabId: 15, windowId: 1, url: 'https://example.test/same', title: '同窗' });
  await h.service.start({ tabId: 15, includeAgent: true });
  await h.service.recordTabSwitch(15);
  const session15 = h.service.sessionOf(15);
  assert.ok(session15);
  // recordTabSwitch 给除 15 之外的会话注入；15 自己的事件来自会话 12/13 的切换
  const eventsIn12 = h.service.sessionOf(12)?.events ?? [];
  assert.ok(eventsIn12.some((event) => event.kind === 'tab-switch' && event.toTabId === 15));
});

test('recordTabSwitch：同一次切换被两条钩子各调一次只记一条（去重，20d5）', async () => {
  const h = harness();
  await h.service.start({ tabId: 12, includeAgent: true });
  // tabs.onActivated 与 windows.onFocusChanged 会对同一次切换各调一次。
  assert.equal(await h.service.recordTabSwitch(13), 1);
  assert.equal(await h.service.recordTabSwitch(13), 0, '同一次切换的第二次钩子不应再记一步');
  assert.equal(h.service.sessionOf(12)?.events.length, 1);
});

test('recordTabSwitch：切走 + 切回录制 tab 各记一条（往返两步，20d5）', async () => {
  const h = harness();
  await h.service.start({ tabId: 12, includeAgent: true });
  assert.equal(await h.service.recordTabSwitch(13), 1);
  // 用户切回录制 tab：from 用最近一次切走的目标（13/窗口 2），to 是录制 tab（12/窗口 1）。
  assert.equal(await h.service.recordTabSwitch(12), 1, '切回录制 tab 也要记一条边界');
  const events = h.service.sessionOf(12)?.events ?? [];
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => [event.kind, event.fromTabId, event.toTabId, event.fromWindowId, event.toWindowId]),
    [
      ['window-switch', 12, 13, 1, 2],
      ['window-switch', 13, 12, 2, 1],
    ],
  );
  // 重复的聚焦钩子不应把“切回”记两遍。
  assert.equal(await h.service.recordTabSwitch(12), 0);
});

test('recordTabSwitch：会话 windowId 缺失时按 session tab 回读，仍判跨窗口（20d5）', async () => {
  const h = harness();
  await h.service.start({ tabId: 12, includeAgent: true });
  const session = h.service.sessionOf(12);
  assert.ok(session);
  session.windowId = null; // 模拟 record.start 时 tabs.get 没带 windowId
  assert.equal(await h.service.recordTabSwitch(13), 1);
  const event = h.service.sessionOf(12)?.events[0];
  assert.equal(event?.kind, 'window-switch', '回读到会话窗口后仍应判成 window-switch');
  assert.equal(event?.fromWindowId, 1);
  assert.equal(event?.toWindowId, 2);
});

test('stop：停录制器/移除浮层/补最终观察/落库；list 摘要与全量', async () => {
  const h = harness();
  await h.service.start({ tabId: 12, includeAgent: true });
  h.service.pushEvent({ kind: 'click', selector: '#submit-btn' }, sender());
  h.advance(500);
  const stopped = await h.service.stop({ tabId: 12 });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.recording.events, 1);
  assert.equal(stopped.recordingId, 'rec-1');
  assert.equal(stopped.backend, 'memory');
  assert.deepEqual(h.calls, ['capture.start:12:true', 'overlay.show:12', 'capture.stop:12', 'overlay.hide:12']);
  assert.equal(h.service.status().active.length, 0);

  const summary = await h.service.list({ includeEvents: false });
  assert.equal(summary.total, 1);
  const first = summary.recordings[0] as RecordingSummary;
  assert.equal(first.events, 1);
  assert.equal(first.kinds.click, 1);

  const full = await h.service.list();
  assert.equal(full.total, 1);
  const events = full.recordings[0]?.events;
  assert.ok(Array.isArray(events) && events.length === 1);
  assert.equal(events[0]?.observation, '最终状态', 'stop 时补最终观察');
  assert.equal(events[0]?.stateUrl, 'https://example.test/?done=1');

  await assert.rejects(() => h.service.stop({ tabId: 12 }), (error: unknown) => {
    assert.ok(error instanceof RecordServiceError);
    assert.equal(error.code, 'E_NOT_FOUND');
    return true;
  });
});

test('export：Trace v3 + states + 导出截图（20d2 服务侧）', async () => {
  const h = harness();
  await h.service.start({ tabId: 12, includeAgent: true });
  h.service.pushEvent({ kind: 'click', selector: '#submit-btn' }, sender());
  await h.service.stop({ tabId: 12 });
  const exported = await h.service.export({ screenshot: true, out: 'trace' });
  assert.equal(exported.traceVersion, 3);
  assert.ok(exported.steps >= 1);
  assert.ok(exported.states >= 1);
  assert.equal(exported.screenshots, 1);
  assert.match(String(exported.trace.screenshots?.[0]?.dataUrl), /^data:image\//);
  assert.equal(exported.tracePathHint, 'trace/trace.json');
  assert.ok(exported.stateFiles.length >= 1);
  const parsedTrace = JSON.parse(exported.traceJson) as { version: number; states: unknown[] };
  assert.equal(parsedTrace.version, 3, 'traceJson 就是可落盘的 trace.json 内容');
  assert.ok(Array.isArray(parsedTrace.states) && parsedTrace.states.length >= 1);
  assert.deepEqual(exported.stateFiles.map((file) => file.id), exported.trace.states.map((state) => state.id));

  // 不带截图参数时不补拍
  const plain = await h.service.export({});
  assert.equal(plain.screenshots, 0);
  // 指定不存在的 id
  await assert.rejects(() => h.service.export({ id: 'missing' }), (error: unknown) => {
    assert.ok(error instanceof RecordServiceError);
    assert.equal(error.code, 'E_NOT_FOUND');
    return true;
  });
});

test('export：没有历史录制时结构化失败', async () => {
  const h = harness();
  await assert.rejects(() => h.service.export({}), (error: unknown) => {
    assert.ok(error instanceof RecordServiceError);
    assert.equal(error.code, 'E_NOT_FOUND');
    return true;
  });
});

test('reattach：导航后重新注入录制器；非活跃 tab 返回 ok=false', async () => {
  const h = harness();
  await h.service.start({ tabId: 12, includeAgent: true });
  const result = await h.service.reattach(12, { overlay: true });
  assert.equal(result.ok, true);
  assert.equal(result.captureFrames, 2);
  assert.equal(result.overlay, true);
  assert.equal(h.calls.filter((call) => call === 'capture.start:12:true').length, 2);
  const missing = await h.service.reattach(99);
  assert.equal(missing.ok, false);
});

test('finishFromOverlay/summaries/remove/senderTabId 的边界', async () => {
  const h = harness();
  await h.service.start({ tabId: 12, includeAgent: true });
  h.service.pushEvent({ kind: 'click', selector: '#a' }, sender());
  const finished = await h.service.finishFromOverlay(12);
  assert.equal(finished.recording.events, 1);
  const summaries = await h.service.summaries();
  assert.equal(summaries.length, 1);
  const removed = await h.service.remove(summaries[0]!.id);
  assert.equal(removed.removed, 1);
  assert.equal((await h.service.list()).total, 0);
  assert.equal(h.service.recordedTotal(), 1);

  assert.equal(senderTabId({ tab: { id: 5 } }), 5);
  assert.equal(senderTabId({ tab: {} }), null);
  assert.equal(senderTabId(null), null);
});
