// tests/unit/record-integration.test.mjs —— 第三轮 step 模型深化 + 录制执行器的运行时接线：
//   1) record-steps 扩展字段（parallel/cancel/branch.options）：没有声明时 step 形状与 v2 完全一致；
//   2) buildRecordStep：录制事件带并发/取消/分支选项时才出现新字段；
//   3) summarizeRecordSteps：新增计数默认 0，声明后才计数；
//   4) record-events 运行时：branch 边界/40 步采样后 recordStepSnapshot 暴露 graph/exec，
//      且既有 recordProgram 摘要形状与阈值不变；
//   5) summarizeRecording（record export 消费点）新增 graph/exec 字段而不影响既有字段。
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
  RECORD_STEP_EXTENSION_VERSION,
  RECORD_STEP_EXTENSIONS,
  RECORD_STEP_VERSION,
  attachStepExtensions,
  buildRecordStep,
  normalizeStepBranchOptions,
  normalizeStepCancel,
  normalizeStepParallel,
  summarizeRecordSteps,
} = await import('../../extension/src/record-steps.js');
const {
  handleRecordEvent,
  forgetRecordStepState,
  recordStepSnapshot,
  summarizeRecording,
} = await import('../../extension/src/record-events.js');

function event(overrides = {}) {
  return { documentId: 'doc-1', frameId: 0, url: 'https://a.test/f', boundary: { documentId: 'doc-1', frameId: 0 }, ...overrides };
}

test('normalizeStepParallel/normalizeStepCancel：默认 null、声明规整、role 白名单', () => {
  assert.equal(normalizeStepParallel(null), null);
  assert.equal(normalizeStepParallel(false), null);
  assert.equal(normalizeStepParallel({}), null, '没有 groupId 不构成并发声明');
  const parallel = normalizeStepParallel({ group: 'g1', role: 'FORK', arm: 2, waitFor: 'race', label: '双开', failFast: true });
  assert.equal(parallel.groupId, 'g1');
  assert.equal(parallel.role, 'fork');
  assert.equal(parallel.arm, 2);
  assert.equal(parallel.waitFor, 'race');
  assert.equal(parallel.label, '双开');
  assert.equal(parallel.failFast, true);
  assert.equal(normalizeStepParallel({ id: 'g2' }).role, null, '没写 role 时由 step 图推断');
  assert.equal(normalizeStepParallel({ groupId: 'g3', waitFor: 'weird' }).waitFor, 'all');
  assert.equal(normalizeStepParallel(42), null);

  assert.equal(normalizeStepCancel(null), null);
  assert.equal(normalizeStepCancel({}), null);
  const cancel = normalizeStepCancel({ scope: 'pay', onCancel: 'SKIP', afterMs: 900, reason: '超时', close: true, token: 't' });
  assert.equal(cancel.scope, 'pay');
  assert.equal(cancel.onCancel, 'skip');
  assert.equal(cancel.afterMs, 900);
  assert.equal(cancel.close, true);
  assert.equal(normalizeStepCancel({ id: 'x', mode: 'continue', end: true }).onCancel, 'continue');
  assert.equal(normalizeStepCancel({ scope: 'y', afterMs: -5 }).afterMs, 0);
});

test('normalizeStepBranchOptions：条件/目标白名单、上限 16、非法项跳过', () => {
  assert.deepEqual(normalizeStepBranchOptions(null), []);
  const options = normalizeStepBranchOptions([
    { label: 'a', when: { urlIncludes: '/a', secret: 'x' }, to: 3 },
    { when: { selector: '#s' }, to: 'ref-b' },
    { expect: { textIncludes: 'ok' } },
    'bad',
  ]);
  assert.equal(options.length, 3);
  assert.equal(options[0].label, 'a');
  assert.deepEqual(options[0].when, { urlIncludes: '/a' });
  assert.equal(options[0].to, 3);
  assert.equal(options[1].to, 'ref-b');
  assert.equal(options[2].label, 'option-3');
  assert.equal(options[2].when.textIncludes, 'ok');
  const many = normalizeStepBranchOptions(Array.from({ length: 20 }, (_, index) => ({ label: 'o' + index })));
  assert.equal(many.length, 16);
});

test('buildRecordStep：没有扩展声明时 step 形状与 v2 完全一致（默认行为不变）', () => {
  const plain = buildRecordStep(event({ kind: 'click', seq: 1, selector: '#go', ts: 1000 }), { seq: 1, index: 0 });
  assert.equal(plain.model, RECORD_STEP_VERSION);
  assert.equal(plain.kind, 'action');
  assert.equal('parallel' in plain, false);
  assert.equal('cancel' in plain, false);
  assert.equal('branchOptions' in plain, false);
  const keys = Object.keys(plain).sort();
  assert.deepEqual(keys, ['branch', 'evidence', 'expect', 'fallback', 'humanGate', 'idempotent', 'kind', 'method', 'model', 'params', 'ref', 'risk', 'sourceKind', 'target', 'type', 'waitBeforeMs', 'repeat'].filter((key) => key in plain).sort());
  assert.equal(RECORD_STEP_EXTENSION_VERSION, 1);
  assert.deepEqual(RECORD_STEP_EXTENSIONS, ['parallel', 'cancel', 'branchOptions']);
});

test('buildRecordStep/attachStepExtensions：事件带 parallel/cancel/branch.options 时只加字段', () => {
  const withParallel = buildRecordStep(event({
    kind: 'click',
    seq: 2,
    selector: '#a',
    ts: 1100,
    parallel: { groupId: 'g', role: 'arm', arm: 1, waitFor: 'any' },
    cancel: { scope: 'pay', onCancel: 'skip', afterMs: 500 },
  }), { seq: 2, index: 1 });
  assert.equal(withParallel.parallel.groupId, 'g');
  assert.equal(withParallel.parallel.role, 'arm');
  assert.equal(withParallel.parallel.arm, 1);
  assert.equal(withParallel.parallel.waitFor, 'any');
  assert.equal(withParallel.cancel.scope, 'pay');
  assert.equal(withParallel.cancel.onCancel, 'skip');

  const nav = buildRecordStep(event({
    kind: 'navigate',
    seq: 3,
    url: 'https://a.test/next',
    ts: 1200,
    branch: { boundary: 'document', source: 'navigation', url: 'https://a.test/next', options: [{ label: 'go', when: { urlIncludes: '/next' }, to: 4 }] },
  }), { seq: 3, index: 2 });
  assert.equal(nav.kind, 'branch');
  assert.deepEqual(nav.branch.options.map((option) => option.label), ['go']);
  assert.equal(nav.branchOptions, 1);

  const target = { model: 2, ref: 'x', kind: 'action', method: 'click' };
  assert.equal(attachStepExtensions(target, {}), target);
  assert.equal(attachStepExtensions(target, null), target);
  attachStepExtensions(target, { stepExtensions: { parallel: { groupId: 'gx' } } });
  assert.equal(target.parallel.groupId, 'gx');
});

test('summarizeRecordSteps：并发/取消/分支选项计数默认 0，声明后按组去重', () => {
  const plain = summarizeRecordSteps([buildRecordStep(event({ kind: 'click', seq: 1, selector: '#a', ts: 1000 }), { seq: 1, index: 0 })]);
  assert.equal(plain.parallelGroups, 0);
  assert.equal(plain.cancelScopes, 0);
  assert.equal(plain.branchOptions, 0);

  const first = buildRecordStep(event({ kind: 'click', seq: 2, selector: '#b', ts: 1100, parallel: { groupId: 'g', role: 'fork' } }), { seq: 2, index: 1 });
  const second = buildRecordStep(event({ kind: 'click', seq: 3, selector: '#c', ts: 1200, parallel: { groupId: 'g', role: 'arm' }, cancel: { scope: 'pay' } }), { seq: 3, index: 2 });
  const third = buildRecordStep(event({ kind: 'navigate', seq: 4, url: 'https://a.test/n', ts: 1300, branch: { boundary: 'document', options: [{ label: 'a' }, { label: 'b' }] } }), { seq: 4, index: 3 });
  const summary = summarizeRecordSteps([first, second, third]);
  assert.equal(summary.parallelGroups, 1);
  assert.equal(summary.cancelScopes, 1);
  assert.equal(summary.branchOptions, 2);
  assert.equal(summary.total, 3);
  assert.equal(summary.model, RECORD_STEP_VERSION);
});

test('record-events 运行时：branch 边界触发 graph/exec 采样，既有 recordProgram 形状不变', () => {
  const tab = 201;
  const sender = { tab: { id: tab }, frameId: 0, documentId: 'doc-int-1' };
  const at = 1_700_000_000_000;
  assert.equal(handleRecordEvent({ kind: 'click', seq: 1, selector: '#go', ts: at }, sender), true);
  assert.equal(handleRecordEvent({ kind: 'navigate', seq: 2, url: 'https://a.test/next', ts: at + 400 }, sender), true);
  const snapshot = recordStepSnapshot(tab);
  assert.ok(snapshot.program, '既有程序摘要仍在');
  assert.match(snapshot.program.fingerprint, /^p[0-9a-f]{8}-/);
  assert.equal(snapshot.program.steps, 2);
  assert.equal(snapshot.program.branches, 1);
  assert.ok(JSON.stringify(snapshot.program).length < 900, '既有摘要体积不变');
  // 新增字段：执行图摘要 + 内存 dry-run 摘要（都挂在抽样点上）。
  assert.ok(snapshot.graph, '图摘要应存在');
  assert.equal(snapshot.graph.version, 1);
  assert.equal(snapshot.graph.nodes, 2);
  assert.equal(snapshot.graph.branches, 1);
  assert.match(snapshot.graph.digest, /^g[0-9a-f]{8}-/);
  assert.ok(snapshot.exec, '执行摘要应存在');
  assert.equal(snapshot.exec.status, 'completed');
  assert.equal(snapshot.exec.steps, 2);
  assert.match(snapshot.exec.digest, /^x[0-9a-f]{8}$/);
  assert.ok(JSON.stringify(snapshot.exec).length < 900);
  forgetRecordStepState(tab);
  assert.equal(recordStepSnapshot(tab).graph, null);
  assert.equal(recordStepSnapshot(tab).exec, null);
});

test('record-events 运行时：采样阈值仍是每 40 步（前 39 步不产生 graph/exec）', () => {
  const tab = 202;
  const sender = { tab: { id: tab }, frameId: 0, documentId: 'doc-int-2' };
  const at = 1_700_000_100_000;
  for (let seq = 1; seq <= 39; seq += 1) {
    assert.equal(handleRecordEvent({ kind: 'click', seq, selector: '#n' + seq, ts: at + seq * 50 }, sender), true);
  }
  const before = recordStepSnapshot(tab);
  assert.equal(before.program, null);
  assert.equal(before.graph, null);
  assert.equal(before.exec, null);
  assert.equal(handleRecordEvent({ kind: 'click', seq: 40, selector: '#n40', ts: at + 40 * 50 }, sender), true);
  const after = recordStepSnapshot(tab);
  assert.ok(after.program);
  assert.ok(after.graph);
  assert.ok(after.exec);
  assert.equal(after.program.steps, 40);
  assert.equal(after.graph.nodes, 40);
  assert.equal(after.exec.steps, 40);
  forgetRecordStepState(tab);
});

test('record-events 运行时：带 human-gate 的采样不抛异常（dry-run 策略 allow），issues 计数不变', () => {
  const tab = 203;
  const sender = { tab: { id: tab }, frameId: 0, documentId: 'doc-int-3' };
  const at = 1_700_000_200_000;
  assert.equal(handleRecordEvent({ kind: 'click', seq: 1, selector: '#a', ts: at }, sender), true);
  assert.equal(handleRecordEvent({ kind: 'input', seq: 2, selector: '#pwd', value: '********', type: 'password', ts: at + 100 }, sender), true);
  assert.equal(handleRecordEvent({ kind: 'navigate', seq: 3, url: 'https://a.test/pay', ts: at + 200 }, sender), true);
  const snapshot = recordStepSnapshot(tab);
  assert.ok(snapshot.exec);
  assert.equal(snapshot.exec.status, 'completed');
  assert.equal(snapshot.exec.requiresHuman, 1);
  assert.equal(snapshot.program.humanGates, 1);
  assert.equal(snapshot.issues >= 0, true);
  forgetRecordStepState(tab);
});

test('summarizeRecording：record export 新增 graph/exec 字段，既有字段（program/duplicates/issues）不变', () => {
  const recordStep = {
    kind: 'action',
    method: 'click',
    ref: 'saaa1111',
    idempotent: false,
    fallback: { onError: 'stop' },
    params: { selector: '#go' },
    target: { selector: '#go' },
    evidence: { seq: 1, index: 0, frameId: 0, documentId: 'doc-x', actor: 'human', url: 'https://a.test/', at: 1000 },
  };
  const summary = summarizeRecording([
    { recordStep, recordDedupe: { duplicates: 2, sources: ['content', 'injected'] } },
    { recordStep: { ...recordStep, ref: 'sbbb2222', kind: 'branch', method: 'navigate', idempotent: true, branch: { boundary: 'document', url: 'https://a.test/next' }, params: { url: 'https://a.test/next' }, target: null, expect: { urlIncludes: '/next' } } },
  ]);
  assert.equal(summary.model, RECORD_STEP_VERSION);
  assert.equal(summary.total, 2);
  assert.equal(summary.duplicates, 2);
  assert.ok(summary.program);
  assert.equal(summary.program.steps, 2);
  assert.ok(summary.graph, 'record export 也应带图摘要');
  assert.equal(summary.graph.nodes, 2);
  assert.equal(summary.graph.branches, 1);
  assert.ok(summary.exec, 'record export 也应带 dry-run 摘要');
  assert.equal(summary.exec.steps, 2);
  assert.equal(summary.exec.branches, 1);
  // 回放前置：导出即带可恢复回放会话摘要 + 幂等 token（只新增字段）。
  assert.ok(summary.replay, 'record export 也应带回放会话摘要');
  assert.equal(summary.replay.version, 1);
  assert.equal(summary.replay.ok, true);
  assert.equal(summary.replay.total, 2);
  assert.equal(summary.replay.batches, 2);
  assert.match(summary.replay.token, /^rp-[0-9a-f]{8}$/);
  assert.match(summary.replay.sessionId, /^replay-/);
  assert.deepEqual(summary.issueCodes, {});

  const empty = summarizeRecording([]);
  assert.equal(empty.program.steps, 0);
  assert.equal(empty.graph.nodes, 0);
  assert.equal(empty.exec.steps, 0);
  assert.equal(empty.total, 0);
  assert.equal(empty.replay.total, 0);
  assert.equal(empty.replay.ok, false);
  assert.match(empty.replay.status, /aborted|completed/);
});
