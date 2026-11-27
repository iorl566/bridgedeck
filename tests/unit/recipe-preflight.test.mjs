import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPreflightRunnable,
  isDangerousMethod,
  preflightRecipe,
  renderPreflightText,
  summarizePreflight,
} from '../../lib/recipe-preflight.mjs';

test('危险动作分类', () => {
  for (const method of ['click', 'fill', 'press', 'select', 'drag', 'upload', 'evaluate', 'navigate']) {
    assert.equal(isDangerousMethod(method), true, method + ' 应该算危险');
  }
  for (const method of ['observe', 'snapshot', 'read', 'wait-for-element', 'scroll-to', 'hover', 'status']) {
    assert.equal(isDangerousMethod(method), false, method + ' 不应算危险');
  }
});

test('预检：危险/幂等/人工节点/确认/分支/循环统计', () => {
  const preflight = preflightRecipe([
    { method: 'navigate', params: { url: 'https://x.test/' } },
    { method: 'observe' },
    { method: 'click', params: { selector: '#go' }, confirm: '确认提交' },
    { type: 'human', reason: '人工登录' },
    { type: 'loop', times: 2, steps: [{ method: 'observe' }] },
    { type: 'if', when: { urlIncludes: '/dash' }, then: [{ method: 'fill', params: { selector: '#q' } }], else: [] },
  ], { approved: true });
  assert.equal(preflight.ok, true);
  assert.deepEqual(preflight.counts, {
    total: 6, flattened: 7, actions: 6, idempotent: 3, nonIdempotent: 3, retryable: 0,
    skippable: 0, dangerous: 3, humanGates: 1, confirmations: 1, branches: 1, loops: 1, maxDepth: 2,
  });
  assert.deepEqual(preflight.dangerous.map((item) => item.method), ['navigate', 'click', 'fill']);
  assert.equal(preflight.dangerous[1].reason.includes('非幂等'), true);
  assert.equal(preflight.humanGates[0].reason, '人工登录');
  assert.equal(preflight.confirmations[0].reason, '确认提交');
  assert.equal(preflight.requiresConfirm, true);
  assert.ok(preflight.flattened.some((entry) => entry.method === 'fill')); // 两个分支都展开
  assert.ok(preflight.flattened.filter((entry) => entry.method === 'observe').length >= 3);
  assert.ok(preflight.estimatedRpcCalls >= 2);
});

test('预检阻塞项：未审批 / 非幂等重试 / 只读模式 / 缺参数', () => {
  const unapproved = preflightRecipe([{ method: 'click', params: { selector: '#a' } }]);
  assert.equal(unapproved.ok, false);
  assert.ok(unapproved.blockers.some((item) => item.code === 'E_RECIPE_NOT_APPROVED'));

  const unsafeRetry = preflightRecipe([
    { method: 'click', params: { selector: '#a' }, fallback: { onError: 'retry', retries: 2 } },
  ], { approved: true });
  assert.ok(unsafeRetry.blockers.some((item) => item.code === 'E_ARG_CONFLICT'));

  const readOnly = preflightRecipe([
    { method: 'fill', params: { selector: '#q', value: 'x' } },
  ], { approved: true, readOnly: true });
  assert.ok(readOnly.blockers.some((item) => item.code === 'E_READ_ONLY'));

  const missingParam = preflightRecipe([
    { method: 'navigate', params: { url: 'https://x.test/{{city}}' } },
  ], { approved: false });
  assert.ok(missingParam.blockers.some((item) => item.code === 'E_ARG_MISSING'));
  const provided = preflightRecipe([
    { method: 'navigate', params: { url: 'https://x.test/{{city}}' } },
  ], { params: { city: '上海' }, paramNames: ['city'] });
  assert.equal(provided.blockers.filter((item) => item.code === 'E_ARG_MISSING').length, 0);
});

test('只读 recipe 免审批，模型错误变成阻塞项', () => {
  const safe = preflightRecipe([{ method: 'observe' }, { method: 'scroll-to', params: { ref: '@e1' } }]);
  assert.equal(safe.ok, true);
  assert.equal(safe.needsApproval, false);
  const broken = preflightRecipe([{ params: {} }]);
  assert.equal(broken.ok, false);
  assert.ok(broken.blockers.some((item) => item.code === 'E_INVALID_PARAMS'));
});

test('assertPreflightRunnable 抛出首个阻塞项；摘要只含安全字段', () => {
  const preflight = preflightRecipe([{ method: 'click' }]);
  assert.throws(() => assertPreflightRunnable(preflight), (error) => error.name === 'RecipePreflightError' && error.code === 'E_RECIPE_NOT_APPROVED');
  const summary = summarizePreflight(preflight);
  assert.equal(summary.ok, false);
  assert.ok(summary.blockers.length >= 1);
  assert.deepEqual(summary.dangerous.map((item) => item.method), ['click']);
  assert.equal(summary.requiresConfirm, false);
  assert.doesNotThrow(() => assertPreflightRunnable({ ok: true, blockers: [] }));
});

test('预检文本可读且包含阻塞与警告', () => {
  const preflight = preflightRecipe([
    { method: 'click' },
    { type: 'human', reason: '登录' },
    { type: 'loop', times: 2, steps: [{ method: 'observe' }] },
  ]);
  const lines = renderPreflightText(preflight);
  assert.ok(lines[0].includes('有阻塞项'));
  assert.ok(lines.some((line) => line.includes('人工节点')));
  assert.ok(lines.some((line) => line.includes('危险动作')));
  assert.ok(lines.some((line) => line.includes('阻塞')));
});
