import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_STEP_VERSION,
  buildRecordStep,
  classifyRecordEvent,
  recordEventTarget,
  recordStepRef,
  stableHash,
  stepSignature,
  summarizeRecordSteps,
  toRecipeSteps,
} from '../../extension/src/record-steps.js';

const base = { documentId: 'doc-1', frameId: 0, revision: 7, actor: 'human', url: 'https://a.test/form?x=1', ts: 1700000000000 };

test('stableHash：确定、短、不同输入不同结果', () => {
  assert.match(stableHash('a'), /^[0-9a-f]{8}$/);
  assert.equal(stableHash('a'), stableHash('a'));
  assert.notEqual(stableHash('a'), stableHash('b'));
  assert.equal(stableHash(''), '811c9dc5');
});

test('target 提取：selector > text > name', () => {
  assert.deepEqual(recordEventTarget({ selector: '#a', text: 'x' }), { selector: '#a' });
  assert.deepEqual(recordEventTarget({ text: 'x', name: 'y' }), { text: 'x' });
  assert.deepEqual(recordEventTarget({ name: 'y' }), { name: 'y' });
  assert.equal(recordEventTarget({}), null);
  assert.equal(recordEventTarget(null), null);
});

test('classify：click/fill/select/file 是非幂等写动作，不自动重试', () => {
  const click = classifyRecordEvent({ kind: 'click', selector: '#go', text: '去' });
  assert.equal(click.kind, 'action');
  assert.equal(click.method, 'click');
  assert.equal(click.idempotent, false);
  assert.equal(click.fallback.onError, 'stop');
  assert.equal(click.risk, 'browser_mutation');
  assert.deepEqual(click.params, { selector: '#go' });

  const fill = classifyRecordEvent({ kind: 'input', selector: '#q', value: 'hello', type: 'text' });
  assert.equal(fill.method, 'fill');
  assert.equal(fill.params.value, 'hello');
  assert.deepEqual(fill.expect, { selectorValue: 'hello' });
  assert.equal(fill.humanGate, null);

  const masked = classifyRecordEvent({ kind: 'input', selector: '#pwd', value: '********', type: 'password' });
  assert.equal(masked.params.value, undefined);
  assert.equal(masked.risk, 'human_gate');
  assert.ok(masked.humanGate.reason.includes('脱敏'));
  assert.equal(masked.expect, null);

  const select = classifyRecordEvent({ kind: 'select', selector: '#s', value: 'L' });
  assert.equal(select.method, 'select');
  assert.deepEqual(select.expect, { selectorValue: 'L' });

  const file = classifyRecordEvent({ kind: 'file', selector: '#f', files: ['a.txt'] });
  assert.equal(file.method, 'upload');
  assert.equal(file.risk, 'human_gate');
  assert.ok(file.humanGate.valueKind === 'file');
});

test('classify：hover 可逆；drag 合并 from/to；观察/等待类可重试', () => {
  const hover = classifyRecordEvent({ kind: 'hover', selector: '#more', dwellMs: 800 });
  assert.equal(hover.idempotent, true);
  assert.equal(hover.fallback.onError, 'skip');
  assert.equal(hover.params.dwellMs, 800);

  const dragStart = classifyRecordEvent({ kind: 'dragstart', selector: '#from' });
  assert.equal(dragStart.method, 'drag');
  assert.equal(dragStart.params.from, '#from');
  const drop = classifyRecordEvent({ kind: 'drop', selector: '#to', from: '#from' });
  assert.equal(drop.params.to, '#to');
  assert.equal(drop.params.from, '#from');

  const state = classifyRecordEvent({ kind: 'state', refs: 12 });
  assert.equal(state.kind, 'observe');
  assert.equal(state.method, 'observe');
  assert.equal(state.fallback.onError, 'retry');
  assert.equal(state.fallback.retries, 2);
  assert.equal(state.params.refs, 12);

  const text = classifyRecordEvent({ kind: 'text', changes: [1, 2, 3] });
  assert.equal(text.method, 'observe-text');
  assert.equal(text.params.changes, 3);

  const media = classifyRecordEvent({ kind: 'media', media: { selector: 'video' } });
  assert.equal(media.method, 'observe-media');
  assert.equal(media.params.selector, 'video');
});

test('classify：navigate 是文档边界（branch），带 URL 期望与重试', () => {
  const navigate = classifyRecordEvent({ kind: 'navigate', url: 'https://a.test/form?q=1', source: 'pushState' });
  assert.equal(navigate.kind, 'branch');
  assert.equal(navigate.method, 'navigate');
  assert.equal(navigate.params.url, 'https://a.test/form?q=1');
  assert.deepEqual(navigate.expect, { urlIncludes: '/form?q=1' });
  assert.equal(navigate.fallback.onError, 'retry');
  assert.equal(navigate.branch.boundary, 'document');
  assert.equal(navigate.branch.source, 'pushState');

  const tab = classifyRecordEvent({ kind: 'tab-switch', tabId: 9, windowId: 3 });
  assert.equal(tab.kind, 'branch');
  assert.equal(tab.branch.boundary, 'tab-switch');
  assert.equal(tab.branch.tabId, 9);

  const unknown = classifyRecordEvent({ kind: 'mystery' });
  assert.equal(unknown.kind, 'observe');
  assert.equal(unknown.fallback.onError, 'skip');
  assert.equal(unknown.params.sourceKind, 'mystery');
  assert.equal(classifyRecordEvent(null), null);
});

test('buildRecordStep：模型版本/稳定 ref/证据/期望/人工补值', () => {
  const event = { ...base, kind: 'click', seq: 4, selector: '#go', text: '去' };
  const first = buildRecordStep(event, { seq: 4, index: 2, frameId: 0, documentId: 'doc-1' });
  const second = buildRecordStep({ ...event }, { seq: 4, index: 3, frameId: 0, documentId: 'doc-1' });
  assert.equal(first.model, RECORD_STEP_VERSION);
  assert.equal(first.kind, 'action');
  assert.equal(first.ref, second.ref, '同一事件重复投递 ref 不变');
  assert.equal(first.evidence.index, 2);
  assert.equal(first.evidence.seq, 4);
  assert.equal(first.evidence.revision, 7);
  assert.equal(first.evidence.actor, 'human');
  assert.equal(first.evidence.documentId, 'doc-1');
  assert.ok(first.evidence.url.startsWith('https://a.test/'));
  assert.equal(first.sourceKind, 'click');

  const otherDoc = buildRecordStep(event, { seq: 4, documentId: 'doc-2' });
  assert.notEqual(otherDoc.ref, first.ref, '换文档 ref 变化');

  const masked = buildRecordStep({ ...base, kind: 'input', seq: 5, selector: '#pwd', value: '********', type: 'password' }, { seq: 5 });
  assert.equal(masked.risk, 'human_gate');
  assert.ok(masked.humanGate);
  const navigate = buildRecordStep({ ...base, kind: 'navigate', seq: 6, url: 'https://a.test/next', source: 'navigation' }, { seq: 6 });
  assert.equal(navigate.branch.boundary, 'document');
  assert.deepEqual(navigate.expect, { urlIncludes: '/next' });
  assert.equal(buildRecordStep(null), null);
});

test('recordStepRef 与 seq/目标相关', () => {
  const step = { kind: 'action', method: 'click', target: { selector: '#a' } };
  const first = recordStepRef({ documentId: 'd', seq: 1 }, step, {});
  assert.match(first, /^s[0-9a-f]{8}$/);
  assert.notEqual(recordStepRef({ documentId: 'd', seq: 2 }, step, {}), first);
  assert.notEqual(recordStepRef({ documentId: 'd', seq: 1 }, { ...step, target: { selector: '#b' } }, {}), first);
  // 没有 documentId 时按 frame 区分
  assert.notEqual(
    recordStepRef({ frameId: 0, seq: 1 }, step, {}),
    recordStepRef({ frameId: 1, seq: 1 }, step, {}),
  );
});

test('summarizeRecordSteps：按 kind/幂等/重试/人工补值统计', () => {
  const steps = [
    buildRecordStep({ ...base, kind: 'click', seq: 1, selector: '#a' }, { seq: 1 }),
    buildRecordStep({ ...base, kind: 'input', seq: 2, selector: '#p', value: '********', type: 'password' }, { seq: 2 }),
    buildRecordStep({ ...base, kind: 'state', seq: 3, refs: 1 }, { seq: 3 }),
    buildRecordStep({ ...base, kind: 'navigate', seq: 4, url: 'https://a.test/x' }, { seq: 4 }),
  ];
  const summary = summarizeRecordSteps(steps);
  assert.equal(summary.model, RECORD_STEP_VERSION);
  assert.equal(summary.total, 4);
  assert.equal(summary.byKind.action, 2);
  assert.equal(summary.byKind.observe, 1);
  assert.equal(summary.byKind.branch, 1);
  assert.equal(summary.idempotent, 2);
  assert.equal(summary.nonIdempotent, 2);
  assert.equal(summary.humanGates, 1);
  assert.ok(summary.retryable >= 1);
  assert.equal(summary.refs.length, 4);
  assert.ok(summary.methods.includes('click'));
  assert.deepEqual(summarizeRecordSteps(null).total, 0);
});

test('stepSignature 识别同目标重复动作；摘要统计 wait/重复提示', () => {
  const click = buildRecordStep({ ...base, kind: 'click', seq: 1, selector: '#a' }, { seq: 1 });
  const same = buildRecordStep({ ...base, kind: 'click', seq: 2, selector: '#a' }, { seq: 2 });
  const other = buildRecordStep({ ...base, kind: 'click', seq: 3, selector: '#b' }, { seq: 3 });
  assert.equal(stepSignature(click), stepSignature(same));
  assert.notEqual(stepSignature(click), stepSignature(other));
  const fillA = buildRecordStep({ ...base, kind: 'input', seq: 4, selector: '#q', value: 'a' }, { seq: 4 });
  const fillB = buildRecordStep({ ...base, kind: 'input', seq: 5, selector: '#q', value: 'b' }, { seq: 5 });
  assert.notEqual(stepSignature(fillA), stepSignature(fillB));
  fillA.waitBeforeMs = 2000;
  fillA.repeat = 2;
  const summary = summarizeRecordSteps([click, fillA]);
  assert.equal(summary.waits, 1);
  assert.equal(summary.repeated, 1);
  assert.equal(summarizeRecordSteps([click]).waits, 0);
});

test('toRecipeSteps：只输出可回放动作，不自动插入 human 节点', () => {
  const steps = [
    buildRecordStep({ ...base, kind: 'navigate', seq: 1, url: 'https://a.test/form' }, { seq: 1 }),
    buildRecordStep({ ...base, kind: 'click', seq: 2, selector: '#go' }, { seq: 2 }),
    buildRecordStep({ ...base, kind: 'input', seq: 3, selector: '#pwd', value: '********', type: 'password' }, { seq: 3 }),
    buildRecordStep({ ...base, kind: 'state', seq: 4, refs: 2 }, { seq: 4 }),
  ];
  const recipeSteps = toRecipeSteps(steps);
  assert.deepEqual(recipeSteps.map((step) => step.method), ['navigate', 'click', 'fill']);
  assert.ok(recipeSteps[0].expect.urlIncludes === '/form');
  assert.equal(recipeSteps[0].fallback.onError, 'retry');
  assert.equal(recipeSteps[1].idempotent, undefined);
  assert.equal(recipeSteps[2].method, 'fill');
  assert.equal(recipeSteps[2].params.value, undefined);
  assert.ok(recipeSteps[1].source.recordRef.startsWith('s'));
  assert.deepEqual(toRecipeSteps(null), []);
});
