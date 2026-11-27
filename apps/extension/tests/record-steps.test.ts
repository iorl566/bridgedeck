// tests/record-steps.test.ts —— 录制 step 模型（分类/ref/证据/摘要/recipe 投影）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_STEP_VERSION,
  classifyRecordEvent,
  buildRecordStep,
  recordStepRef,
  stableHash,
  stepSignature,
  summarizeRecordSteps,
  toRecipeSteps,
  urlPath,
} from '../src/record/steps.ts';
import type { RecordEvent } from '../src/record/types.ts';

function eventOf(kind: string, extra: Record<string, unknown> = {}): RecordEvent {
  return {
    kind,
    seq: 1,
    ts: 1_700_000_000_000,
    actor: 'human',
    url: 'https://example.test/form?q=1',
    frameId: 0,
    documentId: 'doc-1',
    boundary: { documentId: 'doc-1', frameId: 0, revision: 3 },
    ...extra,
  };
}

test('stableHash 稳定且为 8 位十六进制', () => {
  assert.match(stableHash('a|b|c'), /^[0-9a-f]{8}$/);
  assert.equal(stableHash('a|b|c'), stableHash('a|b|c'));
  assert.notEqual(stableHash('a|b|c'), stableHash('a|b|d'));
  assert.match(stableHash(''), /^[0-9a-f]{8}$/);
});

test('classifyRecordEvent：交互类 → action，写入类风险/幂等/fallback 正确', () => {
  const click = classifyRecordEvent(eventOf('click', { selector: '#submit-btn', role: 'button' }));
  assert.ok(click);
  assert.equal(click.kind, 'action');
  assert.equal(click.type, 'action');
  assert.equal(click.method, 'click');
  assert.deepEqual(click.target, { selector: '#submit-btn' });
  assert.equal(click.idempotent, false);
  assert.equal(click.fallback.onError, 'stop');
  assert.equal(click.risk, 'browser_mutation');

  const hover = classifyRecordEvent(eventOf('hover', { selector: '#more-link', dwellMs: 800 }));
  assert.ok(hover);
  assert.equal(hover.method, 'hover');
  assert.equal(hover.idempotent, true);
  assert.equal(hover.risk, 'read_only');
  assert.equal(hover.params.dwellMs, 800, 'hover 停留时长要进 params（20d9）');
});

test('classifyRecordEvent：脱敏输入产生 human-gate，普通输入带 expect.value', () => {
  const masked = classifyRecordEvent(eventOf('input', { selector: '#pwd', type: 'password', value: '********' }));
  assert.ok(masked);
  assert.equal(masked.kind, 'action');
  assert.equal(masked.method, 'fill');
  assert.equal(masked.risk, 'human_gate');
  assert.ok(masked.humanGate && String(masked.humanGate.valueKind) === 'text', '密码输入必须标记人工补值');
  assert.equal(masked.params.value, undefined, '脱敏值不能进 params');

  const plain = classifyRecordEvent(eventOf('input', { selector: '#kw', type: 'text', value: '桥' }));
  assert.ok(plain);
  assert.equal(plain.risk, 'browser_mutation');
  assert.deepEqual(plain.expect, { selectorValue: '桥' });
  assert.equal(plain.params.value, '桥');
});

test('classifyRecordEvent：文件上传 → human-gate file；select 带 selection 值', () => {
  const file = classifyRecordEvent(eventOf('file', { selector: '#avatar' }));
  assert.ok(file);
  assert.equal(file.method, 'upload');
  assert.equal(file.risk, 'human_gate');
  assert.ok(file.humanGate && file.humanGate.valueKind === 'file');

  const select = classifyRecordEvent(eventOf('select', { selector: '#kind', value: 'b' }));
  assert.ok(select);
  assert.equal(select.method, 'select');
  assert.deepEqual(select.expect, { selectorValue: 'b' });
});

test('classifyRecordEvent：navigate/tab-switch/window-switch → branch 边界步骤', () => {
  const navigate = classifyRecordEvent(eventOf('navigate', { url: 'https://example.test/next?record-nav=1', source: 'pushState' }));
  assert.ok(navigate);
  assert.equal(navigate.kind, 'branch');
  assert.equal(navigate.method, 'navigate');
  assert.equal(navigate.fallback.onError, 'retry');
  assert.deepEqual(navigate.expect, { urlIncludes: '/next?record-nav=1' });
  assert.ok(navigate.branch && navigate.branch.boundary === 'document');

  const tabSwitch = classifyRecordEvent(eventOf('tab-switch', { fromTabId: 1, toTabId: 2, toWindowId: 9 }));
  assert.ok(tabSwitch);
  assert.equal(tabSwitch.kind, 'branch');
  assert.ok(tabSwitch.branch && tabSwitch.branch.boundary === 'tab-switch');

  const windowSwitch = classifyRecordEvent(eventOf('window-switch', { fromWindowId: 1, toWindowId: 2, toTabId: 5 }));
  assert.ok(windowSwitch);
  assert.ok(windowSwitch.branch && windowSwitch.branch.boundary === 'window-switch');
  assert.equal(windowSwitch.branch.windowId, 2);
});

test('classifyRecordEvent：wait/observe 类与未知类型降级', () => {
  const wait = classifyRecordEvent(eventOf('wait', { ms: 1500 }));
  assert.ok(wait);
  assert.equal(wait.kind, 'wait');
  assert.equal(wait.method, 'wait');
  assert.deepEqual(wait.params, { ms: 1500 });

  const state = classifyRecordEvent(eventOf('state', { refs: 12 }));
  assert.ok(state);
  assert.equal(state.kind, 'observe');
  assert.deepEqual(state.params, { refs: 12 });
  assert.equal(state.fallback.onError, 'retry');

  const text = classifyRecordEvent(eventOf('text', { changes: [{ selector: '#out' }, { selector: '#x' }] }));
  assert.ok(text);
  assert.equal(text.method, 'observe-text');
  assert.deepEqual(text.params, { changes: 2 });

  const media = classifyRecordEvent(eventOf('media', { media: [{ selector: '#v' }] }));
  assert.ok(media);
  assert.equal(media.method, 'observe-media');
  assert.deepEqual(media.params, { selector: '#v' });

  const odd = classifyRecordEvent(eventOf('mystery-kind'));
  assert.ok(odd);
  assert.equal(odd.kind, 'observe');
  assert.equal(odd.fallback.onError, 'skip');

  assert.equal(classifyRecordEvent(null), null);
  assert.equal(classifyRecordEvent(undefined), null);
});

test('buildRecordStep：ref 稳定、evidence 带文档/帧/actor、模型版本 v2', () => {
  const event = eventOf('click', { selector: '#submit-btn', frameId: 7, actor: 'agent' });
  const first = buildRecordStep(event, { seq: 3, index: 0, frameId: 7, documentId: 'doc-1', now: 123 });
  assert.ok(first);
  assert.equal(first.model, RECORD_STEP_VERSION);
  assert.equal(first.kind, 'action');
  assert.equal(first.method, 'click');
  assert.equal(first.ref, recordStepRef(event, classifyRecordEvent(event)!, { seq: 3, documentId: 'doc-1' }));
  assert.deepEqual(first.evidence, {
    seq: 3,
    index: 0,
    frameId: 7,
    documentId: 'doc-1',
    revision: 3,
    actor: 'agent',
    url: 'https://example.test/form?q=1',
    at: 123,
  });
  assert.equal(first.sourceKind, 'click');
  assert.match(first.ref, /^s[0-9a-f]{8}$/);

  // 同一事件重复构造 → 同 ref；换文档 → ref 变。
  const again = buildRecordStep(event, { seq: 3, frameId: 7, documentId: 'doc-1' });
  assert.equal(again?.ref, first.ref);
  const otherDoc = buildRecordStep({ ...event, documentId: 'doc-2', boundary: { documentId: 'doc-2', frameId: 7, revision: 3 } }, { seq: 3, frameId: 7, documentId: 'doc-2' });
  assert.notEqual(otherDoc?.ref, first.ref);
});

test('buildRecordStep：branch/humanGate/expect 按骨架挂载', () => {
  const nav = buildRecordStep(eventOf('navigate', { url: 'https://example.test/a' }), { seq: 2 });
  assert.ok(nav);
  assert.equal(nav.kind, 'branch');
  assert.deepEqual(nav.expect, { urlIncludes: '/a' });
  assert.ok(nav.branch);

  const pwd = buildRecordStep(eventOf('input', { type: 'password', value: '********' }), { seq: 3 });
  assert.ok(pwd);
  assert.ok(pwd.humanGate);
  assert.equal(pwd.expect, undefined);
});

test('stepSignature：同目标同值相同，fill 值变化/换方法不同', () => {
  const a = buildRecordStep(eventOf('click', { selector: '#submit-btn' }), { seq: 1 });
  const b = buildRecordStep(eventOf('click', { selector: '#submit-btn' }), { seq: 2 });
  assert.equal(stepSignature(a), stepSignature(b));
  const fillA = buildRecordStep(eventOf('input', { selector: '#kw', value: '甲' }), { seq: 3 });
  const fillB = buildRecordStep(eventOf('input', { selector: '#kw', value: '乙' }), { seq: 4 });
  assert.notEqual(stepSignature(fillA), stepSignature(fillB));
});

test('summarizeRecordSteps：种类计数/幂等/人工闸门/重试/等待/重复', () => {
  const steps = [
    buildRecordStep(eventOf('click', { selector: '#a' }), { seq: 1 }),
    { ...buildRecordStep(eventOf('click', { selector: '#a' }), { seq: 2 })!, waitBeforeMs: 1500, repeat: 2 },
    buildRecordStep(eventOf('navigate', { url: 'https://example.test/b' }), { seq: 3 }),
    buildRecordStep(eventOf('input', { type: 'password', value: '********' }), { seq: 4 }),
    buildRecordStep(eventOf('wait', { ms: 100 }), { seq: 5 }),
  ];
  const summary = summarizeRecordSteps(steps);
  assert.equal(summary.model, RECORD_STEP_VERSION);
  assert.equal(summary.total, 5);
  assert.equal(summary.byKind.action, 3);
  assert.equal(summary.byKind.branch, 1);
  assert.equal(summary.byKind.wait, 1);
  assert.equal(summary.humanGates, 1);
  assert.equal(summary.waits, 1);
  assert.equal(summary.repeated, 1);
  assert.ok(summary.refs.length === 5);
  assert.ok(summary.methods.includes('click'));
  assert.ok(summary.nonIdempotent >= 3);
});

test('toRecipeSteps：只保留可回放动作与 navigate 分支', () => {
  const steps = [
    buildRecordStep(eventOf('click', { selector: '#submit-btn' }), { seq: 1 }),
    buildRecordStep(eventOf('navigate', { url: 'https://example.test/next' }), { seq: 2 }),
    buildRecordStep(eventOf('state', { refs: 3 }), { seq: 3 }),
    buildRecordStep(eventOf('tab-switch', { toTabId: 2 }), { seq: 4 }),
    buildRecordStep(eventOf('input', { selector: '#kw', value: 'x' }), { seq: 5 }),
  ];
  const recipe = toRecipeSteps(steps);
  assert.deepEqual(recipe.map((step) => step.method), ['click', 'navigate', 'fill']);
  assert.deepEqual(recipe[1]?.params, { url: 'https://example.test/next' });
  assert.equal(recipe[2]?.params.value, 'x');
  assert.ok(recipe[0]?.source?.recordRef);
});

test('urlPath：解析失败返回空串（navigate expect 不伪造）', () => {
  assert.equal(urlPath('https://example.test/a?b=1'), '/a?b=1');
  assert.equal(urlPath('not a url'), '');
  assert.equal(urlPath(''), '');
});
