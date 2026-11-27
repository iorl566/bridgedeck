import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCooperationFrames } from '../../extension/src/lib/cooperation-aggregate.js';

function state({ revision = 1, inputClock = 1, humanAttributed = 0, agentAttributed = 0, editing = false, busy = false, lastHumanAt = 0 } = {}) {
  return {
    frameState: { revision, inputClock, humanAttributed, agentAttributed, agentAttributedByTimestamp: 0, agentAttributedByCoordinate: 0, editing, busy, human: humanAttributed },
    control: { inputLocked: false, shared: false, humanActive: false, agentActive: false, agentGraceMs: 0 },
    activity: { lastHumanAt, editing, recent: [] },
  };
}

test('聚合可见 frame：计数求和、revision 取最大', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'top', hidden: false, state: state({ revision: 3, inputClock: 2, humanAttributed: 1, agentAttributed: 4 }) },
    { frameId: 5, url: 'child', hidden: false, state: state({ revision: 7, inputClock: 3, humanAttributed: 2, agentAttributed: 1 }) },
  ]);
  assert.equal(merged.frameCount, 2);
  assert.equal(merged.visibleFrames, 2);
  assert.equal(merged.aggregateFrameState.revision, 7);
  assert.equal(merged.aggregateFrameState.inputClock, 5);
  assert.equal(merged.aggregateFrameState.humanAttributed, 3);
  assert.equal(merged.aggregateFrameState.agentAttributed, 5);
  assert.equal(merged.frameState.revision, 3, '顶层 frameState 应取 frameId 0');
});

test('隐藏 frame 记入 frameGaps，不参与计数', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'top', hidden: false, state: state({ inputClock: 1 }) },
    { frameId: 9, url: 'hidden', hidden: true, state: state({ inputClock: 100, humanAttributed: 100 }) },
  ]);
  assert.equal(merged.hiddenFrames, 1);
  assert.deepEqual(merged.frameGaps, [{ frameId: 9, url: 'hidden', reason: 'hidden_frame' }]);
  assert.equal(merged.aggregateFrameState.inputClock, 1);
  assert.equal(merged.aggregateFrameState.humanAttributed, 0);
});

test('control/活动取任意帧的并集', () => {
  const first = state({ editing: true, lastHumanAt: 100 });
  first.control.humanActive = true;
  const second = state({ busy: true, lastHumanAt: 300 });
  second.control.inputLocked = true;
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'a', hidden: false, state: first },
    { frameId: 2, url: 'b', hidden: false, state: second },
  ]);
  assert.equal(merged.aggregateFrameState.editing, true);
  assert.equal(merged.aggregateFrameState.busy, true);
  assert.equal(merged.control.humanActive, true);
  assert.equal(merged.control.inputLocked, true);
  assert.equal(merged.activity.lastHumanAt, 300);
});

test('空输入返回零值结构', () => {
  const merged = mergeCooperationFrames([]);
  assert.equal(merged.frameCount, 0);
  assert.equal(merged.aggregateFrameState.revision, 0);
  assert.deepEqual(merged.frameGaps, []);
  assert.equal(merged.control.inputLocked, false);
});

test('聚合保留 human/agent 归因时钟', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'a', state: { frameState: { lastHumanAt: 100, lastAgentAt: 0 } } },
    { frameId: 4, url: 'b', state: { frameState: { lastHumanAt: 50, lastAgentAt: 300 } } },
  ], { topFrameId: 0 });
  assert.equal(merged.aggregateFrameState.lastHumanAt, 100);
  assert.equal(merged.aggregateFrameState.lastAgentAt, 300);
  assert.equal(merged.frameState.lastHumanAt, 100);
});

test('聚合 focusNeutral：任一帧不中性则整体不中性', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'a', state: { frameState: { focusNeutral: true } } },
    { frameId: 2, url: 'b', state: { frameState: { focusNeutral: false } } },
  ]);
  assert.equal(merged.aggregateFrameState.focusNeutral, false);
});

test('聚合 selection：取第一个非空选区', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'a', state: { frameState: { selection: '' } } },
    { frameId: 2, url: 'b', state: { frameState: { selection: 'hello' } } },
  ]);
  assert.equal(merged.aggregateFrameState.selection, 'hello');
});

test('聚合 media：拼接各帧媒体状态', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'a', state: { frameState: { media: [{ tag: 'video', playing: true }] } } },
    { frameId: 2, url: 'b', state: { frameState: { media: [{ tag: 'audio', playing: false }] } } },
  ]);
  assert.equal(merged.aggregateFrameState.media.length, 2);
  assert.equal(merged.aggregateFrameState.media[0].tag, 'video');
});

test('聚合 fieldsComplete：任一帧不完整则整体不完整', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'a', state: { frameState: { fieldsComplete: true } } },
    { frameId: 2, url: 'b', state: { frameState: { fieldsComplete: false } } },
  ]);
  assert.equal(merged.aggregateFrameState.fieldsComplete, false);
});

test('聚合 mediaComplete：任一帧不完整则整体不完整', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'a', state: { frameState: { mediaComplete: true } } },
    { frameId: 2, url: 'b', state: { frameState: { mediaComplete: false } } },
  ]);
  assert.equal(merged.aggregateFrameState.mediaComplete, false);
});

test('聚合 textsComplete：任一帧不完整则整体不完整', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'a', state: { frameState: { textsComplete: true } } },
    { frameId: 2, url: 'b', state: { frameState: { textsComplete: false } } },
  ]);
  assert.equal(merged.aggregateFrameState.textsComplete, false);
});

test('聚合 eventsComplete：任一帧不完整则整体不完整', () => {
  const merged = mergeCooperationFrames([
    { frameId: 0, url: 'a', state: { frameState: { eventsComplete: true } } },
    { frameId: 2, url: 'b', state: { frameState: { eventsComplete: false } } },
  ]);
  assert.equal(merged.aggregateFrameState.eventsComplete, false);
});
