// tests/record-events.test.ts —— 录制事件来源：归一化/actor 归因/Agent 过滤/归并。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_INPUT_WINDOW_MS,
  contextFromSender,
  eventTargetOf,
  isAgentFiltered,
  kindCounts,
  mergeIntoPending,
  normalizeRecordEvent,
} from '../src/record/sources.ts';
import type { RecordEvent } from '../src/record/types.ts';

test('normalizeRecordEvent：补 boundary、sender 帧/文档、默认序号与 actor=human', () => {
  const event = normalizeRecordEvent(
    { kind: 'click', selector: '#submit-btn', text: '提交', ts: 1000 },
    { now: 2000, nextSeq: 5, frameId: 3, documentId: 'doc-frame', url: 'https://example.test/frame.html', revision: 7 },
  );
  assert.ok(event);
  assert.equal(event.kind, 'click');
  assert.equal(event.seq, 5);
  assert.equal(event.ts, 1000);
  assert.equal(event.actor, 'human');
  assert.equal(event.frameId, 3);
  assert.equal(event.documentId, 'doc-frame');
  assert.deepEqual(event.boundary, { documentId: 'doc-frame', frameId: 3, revision: 7 });
  assert.equal(event.url, 'https://example.test/frame.html');
  assert.ok(event.recordStep, '归一化必须同时产出 step v2');
  assert.equal(event.recordStep?.kind, 'action');
  assert.equal(event.recordStepVersion, 2);
});

test('normalizeRecordEvent：页面自报 seq 优先，非法形状返回 null', () => {
  const event = normalizeRecordEvent({ kind: 'click', seq: 42 }, { nextSeq: 2 });
  assert.equal(event?.seq, 42);
  assert.equal(normalizeRecordEvent(null), null);
  assert.equal(normalizeRecordEvent('click'), null);
  assert.equal(normalizeRecordEvent({} as Record<string, unknown>), null);
  assert.equal(normalizeRecordEvent({ kind: '' }), null);
  assert.equal(normalizeRecordEvent({ kind: 'x'.repeat(50) }), null);
});

test('normalizeRecordEvent：可信 Agent 输入窗口内的事件归因 agent（20d10 前提）', () => {
  const now = 10_000;
  const recent = normalizeRecordEvent({ kind: 'click' }, { now, agentInputAt: now - 500 });
  assert.equal(recent?.actor, 'agent');
  const stale = normalizeRecordEvent({ kind: 'click' }, { now, agentInputAt: now - AGENT_INPUT_WINDOW_MS - 1 });
  assert.equal(stale?.actor, 'human');
  const explicit = normalizeRecordEvent({ kind: 'click', actor: 'human' }, { now, agentInputAt: now - 10 });
  assert.equal(explicit?.actor, 'agent', '可信输入时钟优先于页面自报 actor（页面分不清 CDP 输入与真人点击）');
  const pageAgent = normalizeRecordEvent({ kind: 'click', actor: 'agent' }, { now });
  assert.equal(pageAgent?.actor, 'agent', '页面自报 agent 在没有时钟时保留');
});

test('isAgentFiltered：默认过滤 Agent 交互动作，includeAgent 时全量记录', () => {
  assert.equal(isAgentFiltered({ kind: 'click', actor: 'agent' }, false), true);
  assert.equal(isAgentFiltered({ kind: 'hover', actor: 'agent' }, false), true);
  assert.equal(isAgentFiltered({ kind: 'input', actor: 'agent' }, false), true);
  assert.equal(isAgentFiltered({ kind: 'click', actor: 'agent' }, true), false);
  assert.equal(isAgentFiltered({ kind: 'click', actor: 'human' }, false), false);
  assert.equal(isAgentFiltered({ kind: 'state', actor: 'agent' }, false), false, '观察类不在默认过滤面');
  assert.equal(isAgentFiltered({ kind: 'tab-switch', actor: 'agent' }, false), false, '边界类不属交互动作');
});

test('mergeIntoPending：文本变化归并到上一条动作（20d8）', () => {
  const events: RecordEvent[] = [
    normalizeRecordEvent({ kind: 'click', seq: 1, selector: '#submit-btn' }, { nextSeq: 1 })!,
  ];
  const textEvent = normalizeRecordEvent(
    { kind: 'text', seq: 1, changes: [{ selector: '#out', value: 'diff-1', previous_value: '未提交' }] },
    { nextSeq: 1 },
  )!;
  assert.equal(mergeIntoPending(events, textEvent), 'merged');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.textChanges?.length, 1);
  assert.equal(events[0]?.textChanges?.[0]?.value, 'diff-1');
});

test('mergeIntoPending：媒体进度归并成数组（20d8）', () => {
  const events: RecordEvent[] = [
    normalizeRecordEvent({ kind: 'click', seq: 1, selector: '#play' }, { nextSeq: 1 })!,
  ];
  const media = normalizeRecordEvent(
    { kind: 'media', seq: 1, media: { selector: '#media-demo', currentTime: 1.5, duration: 30, event: 'timeupdate' } },
    { nextSeq: 1 },
  )!;
  assert.ok(Array.isArray(media.media), '对象媒体事件归一化成数组');
  assert.equal(mergeIntoPending(events, media), 'merged');
  assert.equal(events[0]?.media?.length, 1);
  assert.equal(events[0]?.media?.[0]?.selector, '#media-demo');

  const second = normalizeRecordEvent({ kind: 'media', seq: 1, media: [{ selector: '#media-demo', currentTime: 2.25 }] }, { nextSeq: 1 })!;
  mergeIntoPending(events, second);
  assert.equal(events[0]?.media?.length, 2);
});

test('mergeIntoPending：state 观察挂到同 frame 上一条事件', () => {
  const events: RecordEvent[] = [
    normalizeRecordEvent({ kind: 'click', seq: 1, selector: '#a' }, { nextSeq: 1 })!,
    normalizeRecordEvent({ kind: 'click', seq: 2, selector: '#b', frameId: 5 }, { nextSeq: 2, frameId: 5 })!,
  ];
  const state = normalizeRecordEvent(
    { kind: 'state', seq: 2, frameId: 0, observation: 'button "提交"', refs: 4, url: 'https://example.test/', title: '页' },
    { nextSeq: 2, frameId: 0 },
  )!;
  assert.equal(mergeIntoPending(events, state), 'merged');
  assert.equal(events[0]?.observation, 'button "提交"');
  assert.equal(events[0]?.refs, 4);
  assert.equal(events[0]?.stateUrl, 'https://example.test/');
  assert.equal(events[1]?.observation, undefined, '不同 frame 不应串状态');
});

test('mergeIntoPending：点击带 parentToken 时回填 hover 归属（20d7）', () => {
  const hover = normalizeRecordEvent(
    { kind: 'hover', seq: 1, selector: '#menu-trigger', token: 'ifh-1', frameId: 4, expectsPopup: true },
    { nextSeq: 1, frameId: 4 },
  )!;
  const click = normalizeRecordEvent(
    { kind: 'click', seq: 2, selector: '#menu-item', parentToken: 'ifh-1' },
    { nextSeq: 2 },
  )!;
  const events: RecordEvent[] = [hover];
  assert.equal(mergeIntoPending(events, click), 'appended');
  assert.equal(click.parent, '#menu-trigger');
  assert.equal(click.parentFrameId, 4);
  assert.equal(click.parentToken, undefined, 'token 只用于归因，不留在事件里');
});

test('mergeIntoPending：普通动作返回 appended；空的变化列表被丢弃', () => {
  const click = normalizeRecordEvent({ kind: 'click', seq: 1 }, { nextSeq: 1 })!;
  assert.equal(mergeIntoPending([], click), 'appended');
  const emptyText = normalizeRecordEvent({ kind: 'text', seq: 1, changes: [] }, { nextSeq: 1 })!;
  assert.equal(mergeIntoPending([click], emptyText), 'merged');
  assert.equal(click.textChanges, undefined);
});

test('kindCounts/contextFromSender/eventTargetOf 的边界口径', () => {
  const click = normalizeRecordEvent({ kind: 'click', selector: '#a' }, { nextSeq: 1 })!;
  const text = normalizeRecordEvent({ kind: 'text', changes: [{ selector: '#x' }] }, { nextSeq: 2 })!;
  assert.deepEqual(kindCounts([click, text, click]), { click: 2, text: 1 });
  assert.deepEqual(kindCounts([]), {});

  const context = contextFromSender({ tab: { id: 9, url: 'https://e.test/' }, frameId: 2, documentId: 'doc-9' }, { now: 5, nextSeq: 1 });
  assert.equal(context.tabId, 9);
  assert.equal(context.frameId, 2);
  assert.equal(context.documentId, 'doc-9');
  assert.equal(context.url, 'https://e.test/');
  assert.equal(contextFromSender(null).frameId, undefined);

  assert.deepEqual(eventTargetOf({ selector: '#a' }), { selector: '#a' });
  assert.deepEqual(eventTargetOf({ text: '提交' }), { text: '提交' });
  assert.equal(eventTargetOf({}), null);
});
