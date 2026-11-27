// tests/unit/record-events-runtime.test.mjs —— 运行时消费点验证：
// handleRecordEvent（bridge.js:606 的录制事件入口）在真实去重/校验/程序采样路径上
// 产出 recordDedupe / recordMerge / recordStepIssues / recordProgram 字段，
// 并可通过 summarizeRecording 汇总。全程用最小 chrome stub（与 record-events.test.mjs 同思路）。
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = {
  runtime: {
    onConnect: { addListener() {} },
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
  handleRecordEvent,
  recordStepSnapshot,
  summarizeRecording,
  forgetRecordStepState,
} = await import('../../extension/src/record-events.js');

const AT = 1_700_000_000_000;

function sender(tabId, documentId) {
  return { tab: { id: tabId }, frameId: 0, documentId };
}

test('运行时：严格重复投递被丢弃，先到事件带 recordDedupe 并合并观察增量', () => {
  const tab = 101;
  const doc = sender(tab, 'doc-dup');
  assert.equal(handleRecordEvent({ kind: 'click', seq: 1, selector: '#go', ts: AT, source: 'content' }, doc), true);
  // 同 document+seq+kind+签名 → 可证明的重传（不同 source）
  assert.equal(handleRecordEvent({ kind: 'click', seq: 1, selector: '#go', ts: AT + 5, source: 'injected', observation: '合并来的观察' }, doc), true);
  const snapshot = recordStepSnapshot(tab);
  assert.equal(snapshot.index, 1, '重复事件不占用 step 序号');
  assert.equal(snapshot.duplicates, 1);
  const summary = summarizeRecording([{ recordStep: { kind: 'action', method: 'click', ref: 'x', idempotent: false, params: {}, target: { selector: '#go' } }, recordDedupe: { duplicates: 1, sources: ['content', 'injected'] } }]);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.program.steps, 1);
  forgetRecordStepState(tab);
  assert.equal(recordStepSnapshot(tab).duplicates, 0);
});

test('运行时：乱序 seq 触发 recordStepIssues（SEQ_REGRESSION），不影响事件落库', () => {
  const tab = 102;
  const doc = sender(tab, 'doc-order');
  handleRecordEvent({ kind: 'click', seq: 9, selector: '#a', ts: AT }, doc);
  handleRecordEvent({ kind: 'click', seq: 3, selector: '#b', ts: AT + 1 }, doc);
  const snapshot = recordStepSnapshot(tab);
  assert.equal(snapshot.index, 2);
  assert.ok(snapshot.issues >= 1, '应有 step 级问题计数');
  forgetRecordStepState(tab);
});

test('运行时：branch 边界触发程序摘要（recordProgram 字段），摘要小且含指纹', () => {
  const tab = 103;
  const doc = sender(tab, 'doc-branch');
  handleRecordEvent({ kind: 'click', seq: 1, selector: '#go', ts: AT }, doc);
  handleRecordEvent({ kind: 'navigate', seq: 2, url: 'https://a.test/next', ts: AT + 500 }, doc);
  const snapshot = recordStepSnapshot(tab);
  assert.ok(snapshot.program, 'branch 边界应生成程序摘要');
  assert.match(snapshot.program.fingerprint, /^p[0-9a-f]{8}-/);
  assert.equal(snapshot.program.steps, 2);
  assert.equal(snapshot.program.branches, 1);
  assert.ok(JSON.stringify(snapshot.program).length < 900, '挂在事件上的摘要必须小');
  forgetRecordStepState(tab);
});

test('运行时：多源同动作（不同 seq、不同 source、时间窗内）标注 recordMerge 且保留两条', () => {
  const tab = 104;
  const doc = sender(tab, 'doc-merge');
  handleRecordEvent({ kind: 'click', seq: 1, selector: '#same', ts: AT, source: 'content' }, doc);
  handleRecordEvent({ kind: 'click', seq: 2, selector: '#same', ts: AT + 10, source: 'injected', observation: '第二个来源的观察' }, doc);
  const snapshot = recordStepSnapshot(tab);
  assert.equal(snapshot.index, 2, '多源合并默认不丢事件（避免误删真实双击）');
  assert.equal(snapshot.merged, 1);
  forgetRecordStepState(tab);
});

test('运行时：无问题事件不产生多余字段（默认输出形状保持不变）', () => {
  const tab = 105;
  const doc = sender(tab, 'doc-clean');
  for (let seq = 1; seq <= 3; seq += 1) {
    handleRecordEvent({ kind: 'click', seq, selector: '#n' + seq, ts: AT + seq * 1000 }, doc);
  }
  const snapshot = recordStepSnapshot(tab);
  assert.equal(snapshot.index, 3);
  assert.equal(snapshot.duplicates, 0);
  assert.equal(snapshot.merged, 0);
  assert.equal(snapshot.issues, 0);
  assert.equal(snapshot.program, null, '未到采样阈值/无边界时不附加程序摘要');
  forgetRecordStepState(tab);
});

test('默认行为保持：新增字段不影响 Trace v3 导出（record export 的消费方）', async () => {
  const { buildTraceV3 } = await import('../../lib/trace-v3.mjs');
  const baseRecording = {
    id: 'rec-1',
    url: 'https://a.test/f',
    title: 'F',
    startedAt: AT,
    endedAt: AT + 5000,
    events: [
      { kind: 'click', seq: 1, ts: AT + 100, selector: '#go', url: 'https://a.test/f', documentId: 'doc-1', frameId: 0 },
      { kind: 'input', seq: 2, ts: AT + 200, selector: '#q', value: 'x', url: 'https://a.test/f', documentId: 'doc-1', frameId: 0 },
    ],
  };
  const withNewFields = {
    ...baseRecording,
    events: baseRecording.events.map((event, index) => ({
      ...event,
      ...(index === 0
        ? {
          recordStep: { kind: 'action', method: 'click', ref: 'saaa', idempotent: false, fallback: { onError: 'stop' }, params: {}, target: { selector: '#go' } },
          recordStepIssues: [{ code: 'SEQ_REGRESSION', severity: 'warning' }],
          recordDedupe: { duplicates: 1, sources: ['content', 'injected'] },
          recordMerge: { mergedInto: 'saaa' },
          recordProgram: { fingerprint: 'pdeadbeef-2', steps: 2, branches: 0 },
        }
        : { recordStep: { kind: 'action', method: 'fill', ref: 'sbbb', idempotent: false, fallback: { onError: 'stop' }, params: { value: 'x' }, target: { selector: '#q' } } }),
    })),
  };
  const before = buildTraceV3(baseRecording);
  const after = buildTraceV3(withNewFields);
  assert.deepEqual(after, before, 'Trace v3 输出不应因新增 step 字段变化');
  assert.equal(after.version, 3);
});
