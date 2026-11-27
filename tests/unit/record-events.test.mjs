import test from 'node:test';
import assert from 'node:assert/strict';

// 运行时模块依赖 chrome/* 全局；这里给最小 stub（与 tests/extension/module-load.mjs 同思路）。
const connectListeners = [];
globalThis.chrome = {
  runtime: {
    onConnect: { addListener: (handler) => connectListeners.push(handler) },
    onMessage: { addListener() {} },
    sendMessage: async () => ({}),
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
  tabs: { query: async () => [], get: async () => ({ id: 1 }) },
  scripting: { executeScript: async () => [] },
};

const {
  handleRecordEvent, recordStepSnapshot, summarizeRecording, forgetRecordStepState,
} = await import('../../extension/src/record-events.js');
const { installRecordPorts, recordPortSnapshot } = await import('../../extension/src/record-ports.js');

test('handleRecordEvent：附加 boundary/actor/step 模型 v2 并维护每 tab 摘要', async () => {
  const sender = { tab: { id: 11 }, frameId: 0, documentId: 'doc-a' };
  assert.equal(handleRecordEvent({ kind: 'click', seq: 1, selector: '#go', ts: 1000 }, sender), true);
  assert.equal(handleRecordEvent({ kind: 'input', seq: 2, selector: '#q', value: 'hello', type: 'text', ts: 1100 }, sender), true);
  const snapshot = recordStepSnapshot(11);
  assert.equal(snapshot.model, 2);
  assert.equal(snapshot.index, 2);
  assert.equal(snapshot.kinds.action, 2);
  assert.equal(snapshot.refs.length, 2);
  assert.match(snapshot.lastRef, /^s[0-9a-f]{8}$/);
  // 没有 tab 的 sender 被忽略
  assert.equal(handleRecordEvent({ kind: 'click' }, {}), false);
  forgetRecordStepState(11);
  assert.equal(recordStepSnapshot(11).index, 0);
});

test('handleRecordEvent：缺 seq 时补单调序号，跨 tab 独立', async () => {
  const senderA = { tab: { id: 21 }, frameId: 0, documentId: 'doc-x' };
  handleRecordEvent({ kind: 'state', refs: 1, ts: 1 }, senderA);
  handleRecordEvent({ kind: 'state', refs: 2, ts: 2 }, senderA);
  assert.equal(recordStepSnapshot(21).index, 2);
  assert.equal(recordStepSnapshot(21).kinds.observe, 2);
  const senderB = { tab: { id: 22 }, frameId: 0, documentId: 'doc-y' };
  handleRecordEvent({ kind: 'click', selector: '#a', ts: 3 }, senderB);
  assert.equal(recordStepSnapshot(22).index, 1);
  forgetRecordStepState(21);
  forgetRecordStepState(22);
});

test('handleRecordEvent：事件间隔产生 wait 提示，连续同目标动作产生 repeat 计数', async () => {
  const sender = { tab: { id: 41 }, frameId: 0, documentId: 'doc-w' };
  handleRecordEvent({ kind: 'click', seq: 1, selector: '#next', ts: 1000 }, sender);
  handleRecordEvent({ kind: 'click', seq: 2, selector: '#next', ts: 2000 }, sender);
  let snapshot = recordStepSnapshot(41);
  assert.equal(snapshot.repeat, 1, '第二次同签名动作 repeat=1（表示连续第 2 次）');
  assert.equal(snapshot.waits, 0);
  handleRecordEvent({ kind: 'click', seq: 3, selector: '#next', ts: 9000 }, sender);
  snapshot = recordStepSnapshot(41);
  assert.equal(snapshot.repeat, 2);
  assert.equal(snapshot.waits, 1, '7s 间隔应记一条 wait 提示');
  forgetRecordStepState(41);
});

test('summarizeRecording：从已落库事件聚合 step 摘要', async () => {
  const { buildRecordStep } = await import('../../extension/src/record-steps.js');
  const events = [
    { recordStep: buildRecordStep({ documentId: 'd', kind: 'click', seq: 1, selector: '#a' }, { seq: 1 }) },
    { recordStep: buildRecordStep({ documentId: 'd', kind: 'state', seq: 2 }, { seq: 2 }) },
    { kind: 'media' },
    null,
  ];
  const summary = summarizeRecording(events);
  assert.equal(summary.total, 2);
  assert.equal(summary.byKind.action, 1);
  assert.equal(summary.byKind.observe, 1);
  assert.deepEqual(summarizeRecording(null).total, 0);
});

test('record Ports：注册/ready 更新 stepModel/断开清理', () => {
  installRecordPorts();
  assert.equal(connectListeners.length, 1);
  const onMessage = [];
  const onDisconnect = [];
  const listener = connectListeners[0];
  listener({ name: 'other', sender: { tab: { id: 1 } } });
  listener({
    name: 'bb-record',
    sender: { tab: { id: 31 }, frameId: 2, documentId: 'doc-31' },
    onMessage: { addListener: (handler) => onMessage.push(handler) },
    onDisconnect: { addListener: (handler) => onDisconnect.push(handler) },
  });
  let snapshot = recordPortSnapshot(31);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].stepModel, 2);
  assert.equal(snapshot[0].frameId, 2);
  onMessage[0]({ type: 'bb.record.ready', frameUrl: 'https://a.test/', documentId: 'doc-31' });
  snapshot = recordPortSnapshot(31);
  assert.equal(snapshot[0].url, 'https://a.test/');
  onMessage[0]({ type: 'bb.record.ready', stepModel: 3 });
  assert.equal(recordPortSnapshot(31)[0].stepModel, 3);
  onDisconnect[0]();
  assert.equal(recordPortSnapshot(31).length, 0);
});
