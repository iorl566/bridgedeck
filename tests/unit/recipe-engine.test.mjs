import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RecipeEngineError,
  buildConditionExpression,
  buildSelectorProbeExpression,
  isRetryableCode,
  runRecipeEngine,
} from '../../lib/recipe-engine.mjs';
import { normalizeRecipeSteps } from '../../lib/recipe-model.mjs';

function planOk(methods) {
  return {
    ok: true,
    result: {
      steps: methods.map((method, index) => ({ index, method, ok: true, result: null })),
      completed: methods.length,
      failedAt: null,
    },
  };
}

function planFail(methods, at, error = { code: 'E_NOT_FOUND', message: '目标不存在' }) {
  return {
    ok: true,
    result: {
      steps: methods.map((method, index) => ({
        index,
        method,
        ok: index < at,
        ...(index < at ? { result: null } : {}),
        ...(index === at ? { error } : {}),
      })),
      completed: at,
      failedAt: at,
    },
  };
}

function planError(code = 'E_DAEMON', message = 'daemon 不可用') {
  return { ok: false, error: { code, message } };
}

function makeDrivers(handlers = {}) {
  const calls = { run: [], evaluate: [], help: [] };
  let clock = 1000;
  return {
    calls,
    now: () => (clock += 5),
    sleep: async () => {},
    runSteps: async (steps, attempt) => {
      calls.run.push(steps);
      return handlers.run ? handlers.run(steps, calls.run.length) : planOk(steps.map((step) => step.method));
    },
    evaluate: async (expression) => {
      calls.evaluate.push(expression);
      return handlers.evaluate ? handlers.evaluate(expression, calls.evaluate.length) : { ok: true, value: true };
    },
    requestHelp: async (payload) => {
      calls.help.push(payload);
      return handlers.requestHelp ? handlers.requestHelp(payload, calls.help.length) : { ok: true, result: { action: 'approve' } };
    },
  };
}

test('连续动作合并成一段 plan 执行，返回 completed/planned/结果', async () => {
  const drivers = makeDrivers();
  const result = await runRecipeEngine([
    { method: 'observe' },
    { method: 'click', params: { selector: '#go' } },
  ], { drivers, name: 'demo' });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 2);
  assert.equal(result.planned, 2);
  assert.equal(result.failedAt, null);
  assert.equal(result.aborted, false);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map((item) => item.status), ['ok', 'ok']);
  assert.equal(drivers.calls.run.length, 1);
  assert.deepEqual(drivers.calls.run[0].map((item) => item.method), ['observe', 'click']);
  assert.equal(result.report.recipe, 'demo');
  assert.deepEqual(result.report.differences, []);
});

test('段内失败默认 stop：失败步骤/错误/可重试性进入证据，后续步骤标记 blocked', async () => {
  const drivers = makeDrivers({ run: () => planFail(['observe', 'click', 'fill'], 1) });
  const result = await runRecipeEngine([
    { method: 'observe' },
    { method: 'click', params: { selector: '#go' } },
    { method: 'fill', params: { selector: '#q' } },
  ], { drivers });
  assert.equal(result.ok, false);
  assert.equal(result.completed, 1);
  assert.equal(result.failedAt, 2);
  assert.equal(result.error.code, 'E_NOT_FOUND');
  assert.equal(result.evidence.failedStep.method, 'click');
  assert.equal(result.evidence.canRetry, false);
  assert.ok(result.evidence.next.includes('不可自动重试'));
  assert.deepEqual(result.results.map((item) => item.status), ['ok', 'failed', 'blocked']);
  assert.equal(result.report.statuses.failed, 1);
});

test('幂等步骤 retry：失败后重试成功，结果 attempts 记录真实次数', async () => {
  const drivers = makeDrivers({
    run: (steps, attempt) => (attempt === 1 ? planFail(['observe'], 0, { code: 'E_TIMEOUT', message: '超时' }) : planOk(['observe'])),
  });
  const result = await runRecipeEngine([
    { method: 'observe', fallback: { onError: 'retry', retries: 2, retryDelayMs: 0 } },
  ], { drivers });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(result.planned, 1);
  assert.equal(result.results[0].attempts, 2);
  assert.equal(drivers.calls.run.length, 2);
});

test('非幂等动作拒绝自动重试（避免重复副作用）', async () => {
  const drivers = makeDrivers({ run: () => planFail(['click'], 0, { code: 'E_TIMEOUT', message: '超时' }) });
  const result = await runRecipeEngine([
    { method: 'click', params: { selector: '#go' }, fallback: { onError: 'retry', retries: 2 } },
  ], { drivers });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_FORBIDDEN');
  assert.equal(drivers.calls.run.length, 1);
  assert.equal(result.evidence.canRetry, false);
});

test('skip 失败策略：失败步骤记 skipped，后续步骤继续执行', async () => {
  const drivers = makeDrivers({ run: () => planFail(['observe', 'observe'], 0, { code: 'E_BUSY', message: '忙' }) });
  const result = await runRecipeEngine([
    { method: 'observe', fallback: { onError: 'skip', skipReason: '观察失败可跳过' } },
    { method: 'observe' },
  ], { drivers });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(result.planned, 2);
  assert.deepEqual(result.results.map((item) => item.status), ['skipped', 'ok']);
  assert.equal(result.results[0].skippedReason, '观察失败可跳过');
  assert.equal(result.report.statuses.skipped, 1);
});

test('human gate：approve 继续，reason/timeout 传给 driver', async () => {
  const drivers = makeDrivers();
  const result = await runRecipeEngine([
    { type: 'human', reason: '请人工登录', timeoutMs: 60000 },
    { method: 'observe' },
  ], { drivers });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(result.planned, 1);
  assert.equal(drivers.calls.help.length, 1);
  assert.equal(drivers.calls.help[0].reason, '请人工登录');
  assert.equal(drivers.calls.help[0].timeoutMs, 60000);
  assert.equal(result.results[0].kind, 'human');
  assert.equal(result.results[0].status, 'ok');
});

test('human gate：cancel → E_CANCELLED，超时 → E_TIMEOUT', async () => {
  const cancelled = await runRecipeEngine([{ type: 'human', reason: '登录' }], {
    drivers: makeDrivers({ requestHelp: () => ({ ok: true, result: { action: 'cancel' } }) }),
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'E_CANCELLED');
  const timeout = await runRecipeEngine([{ type: 'human', reason: '登录' }], {
    drivers: makeDrivers({ requestHelp: () => ({ ok: true, result: { action: 'timeout' } }) }),
  });
  assert.equal(timeout.error.code, 'E_TIMEOUT');
});

test('if 分支：按 evaluate 条件选择 then/else，分支记录进 results', async () => {
  const thenDrivers = makeDrivers({ evaluate: () => ({ ok: true, value: true }) });
  const thenResult = await runRecipeEngine([
    { type: 'if', when: { urlIncludes: '/dash' }, then: [{ method: 'observe' }], else: [{ method: 'click' }] },
  ], { drivers: thenDrivers });
  assert.equal(thenResult.ok, true);
  assert.equal(thenResult.completed, 1);
  assert.equal(thenResult.results[0].branch, 'then');
  assert.equal(thenResult.results[1].method, 'observe');
  assert.ok(thenDrivers.calls.evaluate[0].includes('/dash'));

  const elseDrivers = makeDrivers({ evaluate: () => ({ ok: true, value: false }) });
  const elseResult = await runRecipeEngine([
    { type: 'if', when: { urlIncludes: '/dash' }, then: [{ method: 'observe' }], else: [{ method: 'click' }] },
  ], { drivers: elseDrivers });
  assert.equal(elseResult.results[0].branch, 'else');
  assert.equal(elseResult.results[1].method, 'click');
});

test('loop：times 次数展开；until 命中提前 break', async () => {
  const plainDrivers = makeDrivers();
  const plain = await runRecipeEngine([
    { type: 'loop', times: 2, steps: [{ method: 'observe' }] },
  ], { drivers: plainDrivers });
  assert.equal(plain.ok, true);
  assert.equal(plain.completed, 2);
  assert.equal(plain.planned, 2);
  assert.equal(plainDrivers.calls.run.length, 1);
  assert.equal(plainDrivers.calls.run[0].length, 2);

  const untilDrivers = makeDrivers({ evaluate: () => ({ ok: true, value: true }) });
  const broke = await runRecipeEngine([
    { type: 'loop', times: 5, until: { selector: '.done' }, steps: [{ method: 'observe' }] },
  ], { drivers: untilDrivers });
  assert.equal(broke.completed, 1);
  assert.equal(untilDrivers.calls.run.length, 1);
  assert.ok(untilDrivers.calls.evaluate[0].includes('.done'));
});

test('step.confirm：执行前请求人工确认，确认后 parameters 不带内部标记', async () => {
  const drivers = makeDrivers();
  const result = await runRecipeEngine([
    { method: 'click', params: { selector: '#del' }, confirm: '确认删除' },
  ], { drivers });
  assert.equal(result.ok, true);
  assert.equal(result.completed, 1);
  assert.equal(drivers.calls.help.length, 1);
  assert.equal(drivers.calls.help[0].reason, '确认删除');
  assert.equal(drivers.calls.run.length, 1);
  assert.equal(drivers.calls.run[0][0].params.__recipeConfirm, undefined);

  const rejected = await runRecipeEngine([
    { method: 'click', params: { selector: '#del' }, confirm: '确认删除' },
  ], { drivers: makeDrivers({ requestHelp: () => ({ ok: true, result: { action: 'cancel' } }) }) });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'E_HUMAN_GATE');
  assert.equal(rejected.failedAt, 1);
});

test('期望 vs 实际：默认只记差异不阻断；expectOn=fail 时失败', async () => {
  const warnDrivers = makeDrivers({
    run: () => planOk(['navigate']),
    evaluate: () => ({ ok: true, value: 'https://a.test/other' }),
  });
  const warn = await runRecipeEngine([
    { method: 'navigate', params: { url: 'https://a.test/other' }, expect: { urlIncludes: '/home' } },
  ], { drivers: warnDrivers });
  assert.equal(warn.ok, true);
  assert.equal(warn.report.differences.length, 1);
  assert.equal(warn.report.differences[0].field, 'urlIncludes');
  assert.equal(warn.results[0].status, 'ok');

  const failDrivers = makeDrivers({
    run: () => planOk(['navigate']),
    evaluate: () => ({ ok: true, value: 'https://a.test/other' }),
  });
  const failed = await runRecipeEngine([
    { method: 'navigate', params: { url: 'https://a.test/other' }, expect: { urlIncludes: '/home' }, expectOn: 'fail' },
  ], { drivers: failDrivers });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'E_EXPECT_FAILED');
  assert.equal(failed.failedAt, 1);
});

test('执行预算：loop 放大超过 maxSteps 时 E_RECIPE_BUDGET 且不再发 plan', async () => {
  const drivers = makeDrivers();
  const result = await runRecipeEngine([
    { type: 'loop', times: 50, steps: [{ method: 'observe' }] },
  ], { drivers, maxSteps: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_TOO_LARGE');
  assert.equal(drivers.calls.run.length, 0);
});

test('driver 抛异常也会变成结构化失败，不裸崩', async () => {
  const drivers = makeDrivers({ run: () => { throw new Error('boom'); } });
  const result = await runRecipeEngine([{ method: 'observe' }], { drivers });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_INTERNAL');
  assert.ok(result.error.message.includes('boom'));
});

test('driver 缺失 runSteps 直接报 E_RECIPE_DRIVER', async () => {
  await assert.rejects(() => runRecipeEngine([{ method: 'observe' }], { drivers: {} }), (error) => error instanceof RecipeEngineError && error.code === 'E_INTERNAL');
});

test('structuralSteps 模式接受已归一化步骤且 ref 保持不变', async () => {
  const { steps } = normalizeRecipeSteps([{ method: 'observe' }, { type: 'human', reason: '登录' }]);
  const drivers = makeDrivers();
  const result = await runRecipeEngine(steps, { drivers, structuralSteps: true });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].ref, steps[0].ref);
  assert.equal(result.completed, 1);
});

test('条件表达式与 selector 探测表达式只读且布尔化', () => {
  const url = buildConditionExpression({ urlIncludes: '/dash', negate: true });
  assert.ok(url.startsWith('(function(){return Boolean(!('));
  assert.ok(url.includes('/dash'));
  const dom = buildConditionExpression({ selector: '#q', selectorVisible: true });
  assert.ok(dom.includes('querySelector'));
  assert.ok(dom.includes('getBoundingClientRect'));
  assert.equal(buildConditionExpression({}), 'false');
  const probe = buildSelectorProbeExpression('#q');
  assert.ok(probe.includes('"#q"'));
  assert.ok(probe.includes('exists:true'));
  assert.equal(isRetryableCode('E_TIMEOUT', ['E_TIMEOUT']), true);
  assert.equal(isRetryableCode('E_NOT_FOUND', ['E_TIMEOUT']), false);
  assert.equal(isRetryableCode('E_STALE_REF'), true);
});
