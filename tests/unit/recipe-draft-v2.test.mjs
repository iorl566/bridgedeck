import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_V2_VERSION, draftRecipeV2, summarizeDraftSource } from '../../lib/recipe-draft-v2.mjs';

function runStep(overrides) {
  return { kind: 'action', method: 'click', target: { selector: '#x' }, replayable: true, ok: true, frameId: 0, revision: 2, ...overrides };
}

test('v2 草稿：navigate 带期望 URL/回退策略/来源证据，click 带稳定 ref 与非幂等标记', () => {
  const draft = draftRecipeV2('demo', {
    sessionId: 'sess-1',
    steps: [
      { kind: 'navigate', method: 'navigate', origin: 'https://a.test', path: '/form', ok: true, revision: 3 },
      runStep({ target: { selector: '#submit' }, revision: 4 }),
      runStep({ method: 'hover', target: { name: '更多' } }),
    ],
  });
  assert.equal(draft.version, DRAFT_V2_VERSION);
  assert.equal(draft.steps.length, 3);
  const [navigate, click, hover] = draft.steps;
  assert.equal(navigate.kind, 'action');
  assert.equal(navigate.method, 'navigate');
  assert.equal(navigate.params.url, 'https://a.test/form');
  assert.deepEqual(navigate.expect, { urlIncludes: '/form' });
  assert.equal(navigate.fallback.onError, 'retry');
  // 导航到确定 URL 是可重复的：draft 给 navigate 带 retry，就必须显式声明幂等，
  // 否则回放预检会以 E_ARG_CONFLICT 拒绝（真实 E2E 20s9 曾因此失败）。
  assert.equal(navigate.idempotent, true);
  assert.match(navigate.ref, /^r[0-9a-f]{12}$/);
  assert.equal(navigate.source.index, 0);
  assert.equal(navigate.source.sessionId, 'sess-1');
  assert.equal(click.method, 'click');
  assert.equal(click.idempotent, false);
  assert.equal(click.fallback.onError, 'stop');
  assert.equal(hover.method, 'hover');
  assert.equal(hover.idempotent, true); // hover 可逆
  assert.equal(hover.params.text, '更多');
  assert.equal(draft.skipped.length, 0);
  assert.deepEqual(draft.humanGates, []);
  assert.equal(draft.source.kind, 'session-run-log');
  assert.equal(draft.source.stepsRead, 3);
});

test('v2 草稿：需要输入值的步骤仍跳过，并给出人工补值建议', () => {
  const draft = draftRecipeV2('demo', {
    steps: [
      runStep({ method: 'fill', target: { selector: '#q' }, replayable: false }),
      runStep({ method: 'select', target: { selector: '#s' }, replayable: false }),
      runStep({ method: 'press', target: { selector: '#q' }, replayable: false }),
      runStep({ method: 'upload', target: { selector: '#f' }, replayable: false }),
      runStep({ method: 'evaluate', target: { selector: '#x' }, replayable: false }),
      runStep({ method: 'click', target: { selector: '#ok' } }),
    ],
  });
  assert.deepEqual(draft.steps.map((step) => step.method), ['click']);
  assert.deepEqual(draft.skipped.map((item) => item.method), ['fill', 'select', 'press', 'upload', 'evaluate']);
  assert.deepEqual(draft.skipped.map((item) => item.reason), ['needs_input', 'needs_input', 'needs_input', 'needs_input', 'needs_input']);
  assert.deepEqual(draft.humanGates.map((gate) => gate.method), ['fill', 'select', 'press', 'upload']);
  assert.ok(draft.humanGates[0].reason.includes('#q'));
});

test('v2 草稿：失败步骤/navigation 变体/无目标/未知 kind 分别跳过', () => {
  const draft = draftRecipeV2('demo', {
    steps: [
      runStep({ ok: false }),
      { kind: 'navigate', method: 'reload', ok: true },
      { kind: 'navigate', method: 'navigate-back', ok: true },
      { kind: 'navigate', method: 'goto', ok: true },
      runStep({ method: 'click', target: null }),
      { kind: 'state', ok: true },
      { kind: 'action', method: 'wheel', target: { selector: '#list' }, replayable: true },
      null,
    ],
  });
  assert.deepEqual(draft.steps.map((step) => step.method), ['reload', 'navigate-back']);
  const reasons = draft.skipped.map((item) => item.reason);
  assert.deepEqual(reasons, ['failed', 'unsupported_navigation', 'no_replay_target', 'unsupported_step', 'needs_args', 'invalid']);
});

test('v2 草稿：maxSteps 截断 + run log 截断警告 + 来源摘要', () => {
  const steps = [];
  for (let index = 0; index < 5; index += 1) {
    steps.push(runStep({ target: { selector: '#b' + index }, frameId: 2 }));
  }
  const draft = draftRecipeV2('demo', { steps, truncated: true });
  const limited = draftRecipeV2('demo', { steps }, { maxSteps: 3 });
  assert.equal(limited.steps.length, 3);
  assert.equal(limited.source.truncated, true);
  assert.ok(draft.warnings.some((line) => line.includes('run log')));
  // frameId 透传进 params（>0 才带）
  assert.equal(draft.steps[0].params.frameId, 2);
  const summary = summarizeDraftSource(draft);
  assert.equal(summary.sessionId, '');
  assert.equal(summary.stepsRead, 5);
  assert.equal(summary.draftedSteps, 5);
  assert.equal(summary.humanGates, 0);
});
