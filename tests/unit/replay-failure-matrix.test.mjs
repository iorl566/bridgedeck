// tests/unit/replay-failure-matrix.test.mjs —— 失败注入矩阵（超时/404/连接失败/重定向…）与恢复建议。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../../extension/src/lib/replay-failure-matrix.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function plan(method = 'GET') {
  return {
    version: 1,
    source: 'network.replay',
    token: 'rp1-plan',
    fingerprint: 'fp-plan',
    steps: [{ index: 0, kind: 'network', method: 'network.replay', params: { method }, fallback: { onError: 'stop' } }],
    blockers: [],
    network: { method, sideEffect: method !== 'GET', crossOrigin: false },
  };
}

function timeoutError() {
  return Object.assign(new Error('network replay 超时（15000ms）'), { code: 'E_TIMEOUT' });
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

test('失败矩阵版本/上限/注入种类稳定，目录自检全绿', () => {
  assert.equal(M.REPLAY_FAILURE_MATRIX_VERSION, 2);
  assert.equal(M.MATRIX_LIMITS.maxCells, 32);
  assert.equal(M.INJECTION_KINDS.length, 17);
  assert.equal(M.INJECTION_KINDS.includes('timeout'), true);
  assert.equal(M.INJECTION_KINDS.includes('http-404'), true);
  assert.equal(M.INJECTION_KINDS.includes('connection-refused'), true);
  assert.equal(M.INJECTION_KINDS.includes('redirect'), true);

  const catalog = M.verifyFailureMatrixCatalog();
  assert.equal(catalog.ok, true, JSON.stringify(catalog.issues));
  assert.equal(catalog.cells, M.INJECTION_KINDS.length);
  assert.equal(catalog.kinds, M.INJECTION_KINDS.length);

  for (const cell of M.FAILURE_INJECTIONS) {
    assert.equal(Object.isFrozen(cell), true);
    assert.equal(typeof cell.id, 'string');
    assert.equal(typeof cell.trigger.errorMessage, 'string');
    assert.equal(cell.recovery.length > 0, true);
  }
});

test('selectInjections：按 id/kind 选、去重、未知忽略、默认全选', () => {
  assert.equal(M.selectInjections().length, M.INJECTION_KINDS.length);
  const selected = M.selectInjections(['timeout', 'http-404', 'timeout', 'not-exist']);
  assert.deepEqual(selected.map((cell) => cell.id), ['timeout', 'http-404']);
  const byKind = M.selectInjections('redirect-loop');
  assert.equal(byKind.length, 1);
  assert.equal(byKind[0].id, 'redirect-loop');
  assert.deepEqual(M.selectInjections([]), []);
  assert.equal(M.getInjection('timeout').kind, 'timeout');
  assert.equal(M.getInjection('nope'), null);
});

test('injectedError / injectedResponse：本地构造、字段稳定、不发请求', () => {
  const cell = M.getInjection('timeout');
  const error = M.injectedError(cell);
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'E_TIMEOUT');
  assert.equal(error.injectionId, 'timeout');
  assert.equal(error.message.includes('超时'), true);

  const response = M.injectedResponse(M.getInjection('http-404'));
  assert.equal(response.status, 404);
  assert.equal(response.headers['x-injected'], 'http-404');
  assert.equal(typeof response.body, 'string');
  assert.equal(response.url, 'https://a.test/api');

  const redirect = M.injectedResponse(M.getInjection('redirect'));
  assert.equal(redirect.url, 'https://b.test/landing');
});

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

test('classifyReplayFailure：超时（GET）→ 可重试、读请求无副作用、映射 REPLAY_TIMEOUT', () => {
  const classification = M.classifyReplayFailure(timeoutError(), { method: 'GET', cell: 'timeout' });
  assert.equal(classification.code, M.MATRIX_CODES.TIMEOUT);
  assert.equal(classification.category, 'network');
  assert.equal(classification.retriable, true);
  assert.equal(classification.safeToRetry, true);
  assert.equal(classification.sideEffectPossible, false);
  assert.equal(classification.retry.retryAfterMs, 250);
  assert.equal(classification.retry.maxAttempts, 2);
  assert.equal(classification.catalog.code, 'REPLAY_TIMEOUT');
  assert.equal(classification.explanation.code, 'REPLAY_TIMEOUT');
  assert.equal(typeof classification.signature, 'string');
  assert.equal(M.classifyReplayFailure(timeoutError(), { method: 'GET', cell: 'timeout' }).signature, classification.signature);
});

test('classifyReplayFailure：超时（POST）→ 重试前必须先对账副作用', () => {
  const classification = M.classifyReplayFailure(timeoutError(), { method: 'POST', cell: 'timeout' });
  assert.equal(classification.retriable, true);
  assert.equal(classification.safeToRetry, false);
  assert.equal(classification.sideEffectPossible, true);
  assert.equal(classification.retry.allowed, false);
  const recovery = M.recoveryPlanFor(classification);
  assert.equal(recovery.actions[0].action, 'verify-side-effects');
});

test('classifyReplayFailure：404 不可重试；500/429 可重试且退避确定', () => {
  const notFound = M.classifyReplayFailure({ status: 404 }, { method: 'GET', cell: 'http-404' });
  assert.equal(notFound.code, M.MATRIX_CODES.HTTP_NOT_FOUND);
  assert.equal(notFound.retriable, false);
  assert.equal(notFound.safeToRetry, false);
  assert.equal(notFound.sideEffectPossible, false);

  const serverError = M.classifyReplayFailure({ status: 500 }, { method: 'GET', cell: 'http-500' });
  assert.equal(serverError.code, M.MATRIX_CODES.HTTP_RETRYABLE);
  assert.equal(serverError.retriable, true);
  assert.equal(serverError.safeToRetry, true);
  const schedule = M.retrySchedule(serverError);
  assert.deepEqual(schedule.map((item) => item.delayMs), [500, 1000, 2000]);
  assert.deepEqual(schedule.map((item) => item.atMs), [500, 1500, 3500]);

  const rateLimited = M.classifyReplayFailure({ status: 429 }, { method: 'GET', cell: 'http-429' });
  assert.equal(rateLimited.code, M.MATRIX_CODES.RATE_LIMITED);
  assert.deepEqual(M.retrySchedule(rateLimited).map((item) => item.delayMs), [2000, 4000, 8000]);
});

test('classifyReplayFailure：连接失败/DNS/重置语义不同', () => {
  const refused = M.classifyReplayFailure('fetch 失败：net::ERR_CONNECTION_REFUSED', { method: 'GET' });
  assert.equal(refused.code, M.MATRIX_CODES.CONNECTION_FAILED);
  assert.equal(refused.retriable, true);
  assert.equal(refused.safeToRetry, true);

  const dns = M.classifyReplayFailure('fetch 失败：net::ERR_NAME_NOT_RESOLVED', { method: 'GET' });
  assert.equal(dns.code, M.MATRIX_CODES.DNS_FAILURE);
  assert.equal(dns.retriable, false);
  assert.equal(dns.needsHuman, true);

  const reset = M.classifyReplayFailure('fetch 失败：net::ERR_CONNECTION_RESET', { method: 'POST' });
  assert.equal(reset.code, M.MATRIX_CODES.CONNECTION_RESET);
  assert.equal(reset.retriable, true);
  assert.equal(reset.safeToRetry, false);
  assert.equal(reset.sideEffectPossible, true);
});

test('classifyReplayFailure：重定向/循环/跨源/CORS 各有恢复路径', () => {
  const redirected = M.classifyReplayFailure({ status: 302, url: 'https://b.test/landing' }, { method: 'GET', cell: 'redirect' });
  assert.equal(redirected.code, M.MATRIX_CODES.REDIRECTED);
  assert.equal(redirected.retriable, false);
  assert.equal(M.recoveryPlanFor(redirected).primary.action, 'follow-recorded-redirect');

  const loop = M.classifyReplayFailure('fetch 失败：net::ERR_TOO_MANY_REDIRECTS', { method: 'GET' });
  assert.equal(loop.code, M.MATRIX_CODES.REDIRECT_LOOP);
  assert.equal(loop.needsHuman, true);
  assert.equal(M.recoveryPlanFor(loop).actions[0].action, 'inspect-redirect-chain');

  const crossOrigin = M.classifyReplayFailure({ status: 307, url: 'https://c.test/' }, { method: 'GET', cell: 'redirect-cross-origin' });
  assert.equal(crossOrigin.code, M.MATRIX_CODES.REDIRECT_CROSS_ORIGIN);
  assert.equal(crossOrigin.needsHuman, true);
  assert.equal(crossOrigin.catalog.code, 'NETWORK_REPLAY_CROSS_ORIGIN');

  const cors = M.classifyReplayFailure('fetch 失败：TypeError: Failed to fetch（CORS）', { method: 'GET' });
  assert.equal(cors.code, M.MATRIX_CODES.CORS_BLOCKED);
  assert.equal(cors.needsHuman, true);
  assert.equal(cors.retriable, false);
});

test('classifyReplayFailure：取消/正文截断/文档失效/帧脱离/人工超时/预算耗尽', () => {
  const cancelled = M.classifyReplayFailure({ error: { code: 'E_CANCELLED', message: '回放已取消' } }, { method: 'GET' });
  assert.equal(cancelled.code, M.MATRIX_CODES.CANCELLED);
  assert.equal(cancelled.retriable, false);
  assert.equal(cancelled.sideEffectPossible, false); // GET 无副作用

  const truncated = M.classifyReplayFailure({ code: 'OBSERVATION_TRUNCATED', message: '正文被截断' }, { method: 'GET' });
  assert.equal(truncated.code, M.MATRIX_CODES.BODY_TRUNCATED);
  assert.equal(M.recoveryPlanFor(truncated).primary.action, 'compare-digest');

  const stale = M.classifyReplayFailure({ error: { code: 'BOUNDARY_STALE_DOCUMENT', message: 'documentId 已变化' } }, { method: 'GET' });
  assert.equal(stale.code, M.MATRIX_CODES.STALE_DOCUMENT);
  assert.equal(stale.retriable, true);
  assert.equal(stale.catalog.code, 'BOUNDARY_STALE_DOCUMENT');

  const detached = M.classifyReplayFailure({ error: { code: 'E_TARGET_DETACHED', message: 'frame 已脱离' } }, { method: 'GET' });
  assert.equal(detached.code, M.MATRIX_CODES.FRAME_DETACHED);
  assert.equal(detached.catalog.code, 'BOUNDARY_FRAME_UNAVAILABLE');

  const human = M.classifyReplayFailure({ code: 'REPLAY_HUMAN_REQUIRED', message: 'human-gate 等待超时' }, { method: 'GET' });
  assert.equal(human.code, M.MATRIX_CODES.HUMAN_TIMEOUT);
  assert.equal(human.needsHuman, true);
  assert.equal(M.recoveryPlanFor(human).stopRecommended, true);

  const budget = M.classifyReplayFailure({ code: 'PLAN_RETRY_BUDGET', message: '预算耗尽' }, { method: 'GET' });
  assert.equal(budget.code, M.MATRIX_CODES.BUDGET_EXCEEDED);
  assert.equal(M.recoveryPlanFor(budget).actions[0].action, 'split-program');
});

test('classifyReplayFailure：未知失败 → 安全默认（需人工、不可重试）', () => {
  const unknown = M.classifyReplayFailure(new Error('something very weird happened'), { method: 'GET' });
  assert.equal(unknown.code, M.MATRIX_CODES.UNKNOWN);
  assert.equal(unknown.retriable, false);
  assert.equal(unknown.needsHuman, true);
  assert.equal(unknown.catalog, null);
  assert.equal(unknown.explanation, null);
  const recovery = M.recoveryPlanFor(unknown);
  assert.equal(recovery.actions[0].action, 'verify-side-effects');
  assert.equal(recovery.actions.some((item) => item.action === 'request-human-help'), true);
});

// ---------------------------------------------------------------------------
// 重试 / 恢复
// ---------------------------------------------------------------------------

test('retrySchedule：不可安全重试为空；上限 5 次、单次退避封顶 8000ms', () => {
  assert.deepEqual(M.retrySchedule({ safeToRetry: false }), []);
  const long = M.retrySchedule({ safeToRetry: true, retry: { maxAttempts: 99, retryAfterMs: 3000 } });
  assert.equal(long.length, M.MATRIX_LIMITS.maxAttempts);
  assert.equal(long[long.length - 1].delayMs, M.MATRIX_LIMITS.maxRetryDelayMs);
  const bounded = M.retrySchedule({ safeToRetry: true, retry: { maxAttempts: 2, retryAfterMs: 250 } }, { baseDelayMs: 100 });
  assert.deepEqual(bounded.map((item) => item.delayMs), [100, 200]);
});

test('recoveryPlanFor：动作有序、副作用对账在前、重试计划只在安全时给出', () => {
  const classification = M.classifyReplayFailure(timeoutError(), { method: 'POST', cell: 'timeout' });
  const recovery = M.recoveryPlanFor(classification);
  assert.equal(recovery.ok, true);
  assert.equal(recovery.actions[0].action, 'verify-side-effects');
  assert.equal(recovery.actions[1].action, 'retry-with-backoff');
  assert.equal(recovery.actions[1].retry, undefined); // POST 不能安全重试 → 无退避表
  assert.equal(recovery.retry, null);
  assert.equal(recovery.actions.map((item) => item.order).join(','), '1,2,3');
  assert.equal(recovery.stopRecommended, false);
  assert.equal(recovery.text.split('\n').length >= 3, true);
  assert.equal(M.formatRecoveryPlan(recovery).includes('恢复建议'), true);
  assert.equal(M.formatRecoveryPlan(null), '恢复建议：无');
  assert.equal(M.recoveryPlanFor(classification).signature, recovery.signature);

  // 读请求可安全重试 → 带确定性退避表
  const getClassification = M.classifyReplayFailure(timeoutError(), { method: 'GET', cell: 'timeout' });
  const getRecovery = M.recoveryPlanFor(getClassification);
  const retryAction = getRecovery.actions.find((item) => item.action === 'retry-with-backoff');
  assert.equal(retryAction.retry.attempts, 2);
  assert.deepEqual(retryAction.retry.delays, [250, 500]);
});

test('recoveryPlanFor：需要人工时补 request-human-help，且优先 stop', () => {
  const classification = M.classifyReplayFailure('fetch 失败：net::ERR_NAME_NOT_RESOLVED', { method: 'GET' });
  const recovery = M.recoveryPlanFor(classification);
  assert.equal(recovery.actions[0].action, 'verify-host-dns');
  assert.equal(recovery.actions.some((item) => item.action === 'request-human-help'), true);
  assert.equal(recovery.needsHuman, true);
  assert.equal(recovery.stopRecommended, true);
});

// ---------------------------------------------------------------------------
// 矩阵运行
// ---------------------------------------------------------------------------

test('runFailureMatrix：默认全本地注入，17 格全部可解释且确定性', () => {
  const matrix = M.runFailureMatrix(plan('GET'));
  assert.equal(matrix.ok, true);
  assert.equal(matrix.total, M.INJECTION_KINDS.length);
  assert.equal(matrix.explained, matrix.total);
  assert.equal(matrix.unexplained, 0);
  assert.equal(matrix.networkUsed, 'local-injection');
  assert.equal(matrix.deterministic, true);
  assert.equal(matrix.method, 'GET');
  for (const cell of matrix.cells) {
    assert.equal(cell.explained, true);
    assert.equal(typeof cell.classification.code, 'string');
    assert.equal(cell.recovery.actions.length > 0, true);
  }
  const again = M.runFailureMatrix(plan('GET'));
  assert.equal(again.digest, matrix.digest);
  assert.deepEqual(again.byCode, matrix.byCode);
  assert.deepEqual(again.byCategory, matrix.byCategory);
});

test('runFailureMatrix：POST 计划 → 副作用风险格显式标记，读计划无副作用风险', () => {
  const getMatrix = M.runFailureMatrix(plan('GET'));
  assert.equal(getMatrix.sideEffectRisk, 0);
  const postMatrix = M.runFailureMatrix(plan('POST'));
  assert.equal(postMatrix.sideEffectRisk > 0, true);
  assert.equal(postMatrix.needsHuman > 0, true);
  assert.equal(typeof postMatrix.advice.firstAction, 'string');
  assert.equal(postMatrix.advice.firstAction.length > 0, true);
  assert.notEqual(postMatrix.digest, getMatrix.digest);
});

test('runFailureMatrix：可注入自定义 execute（模拟真实执行），分类仍正确', () => {
  const seen = [];
  const matrix = M.runFailureMatrix(plan('GET'), {
    injections: ['timeout', 'http-404', 'redirect'],
    execute: (cell) => {
      seen.push(cell.id);
      if (cell.stage === 'execute') throw M.injectedError(cell);
      return M.injectedResponse(cell);
    },
  });
  assert.deepEqual(seen, ['timeout', 'http-404', 'redirect']);
  assert.equal(matrix.total, 3);
  assert.equal(matrix.ok, true);
  assert.equal(matrix.networkUsed, 'injected-execute');
  const timeoutCell = matrix.cells.find((item) => item.id === 'timeout');
  assert.equal(timeoutCell.classification.code, M.MATRIX_CODES.TIMEOUT);
  assert.equal(timeoutCell.recovery.actions[0], 'verify-side-effects');
  const redirectCell = matrix.cells.find((item) => item.id === 'redirect');
  assert.equal(redirectCell.classification.code, M.MATRIX_CODES.REDIRECTED);
});

test('runFailureMatrix：子集选择与 maxCells 生效；未知 injection 被忽略', () => {
  const matrix = M.runFailureMatrix(plan(), { injections: ['timeout', 'dns-failure', 'nope'] });
  assert.equal(matrix.total, 2);
  const capped = M.runFailureMatrix(plan(), { maxCells: 3 });
  assert.equal(capped.total, 3);
  const firstIds = capped.cells.map((item) => item.id);
  assert.deepEqual(firstIds, M.INJECTION_KINDS.slice(0, 3));
});

// ---------------------------------------------------------------------------
// 摘要 / 文本 / 附加 / 自检
// ---------------------------------------------------------------------------

test('summarizeFailureMatrix / formatFailureMatrix / serializeFailureMatrix 有界稳定', () => {
  const matrix = M.runFailureMatrix(plan('GET'));
  const summary = M.summarizeFailureMatrix(matrix);
  assert.equal(summary.ok, true);
  assert.equal(summary.version, 2);
  assert.equal(summary.total, M.INJECTION_KINDS.length);
  assert.equal(summary.cells.length, 8);
  assert.equal(summary.digest, matrix.digest);
  assert.equal(typeof summary.advice.firstAction, 'string');

  const text = M.formatFailureMatrix(matrix);
  assert.equal(text.includes('失败注入矩阵'), true);
  assert.equal(text.split('\n').length <= 30, true);
  assert.equal(M.formatFailureMatrix(null), '失败注入矩阵：无结果');
  assert.equal(M.serializeFailureMatrix(matrix), M.serializeFailureMatrix(M.runFailureMatrix(plan('GET'))));
  assert.equal(M.summarizeFailureMatrix(null), null);
});

test('matrixRecoveryAdvice：按动作聚合计数并给出首行动作', () => {
  const matrix = M.runFailureMatrix(plan('GET'));
  const advice = M.matrixRecoveryAdvice(matrix);
  assert.equal(advice.actions.length > 0, true);
  assert.equal(typeof advice.firstAction, 'string');
  const counts = advice.actions.map((item) => item.count);
  for (let index = 1; index < counts.length; index += 1) assert.equal(counts[index - 1] >= counts[index], true);
  assert.equal(M.matrixRecoveryAdvice({ cells: [] }).firstAction, '');
});

test('attachMatrixRecovery：只加 failureMatrix 字段，不改原解释字段', () => {
  const explanation = { code: 'REPLAY_TIMEOUT', category: 'runtime', title: '超时', retriable: true };
  const classification = M.classifyReplayFailure(timeoutError(), { method: 'POST', cell: 'timeout' });
  const recovery = M.recoveryPlanFor(classification);
  const attached = M.attachMatrixRecovery(explanation, {
    ...classification,
    recovery: { ok: recovery.ok, primary: recovery.primary.action, actions: recovery.actions.map((item) => item.action) },
  });
  assert.equal(attached, explanation);
  assert.equal(attached.code, 'REPLAY_TIMEOUT');
  assert.equal(attached.failureMatrix.safeToRetry, false);
  assert.equal(attached.failureMatrix.sideEffectPossible, true);
  assert.equal(attached.failureMatrix.recovery.primary, 'verify-side-effects');
  assert.equal(M.attachMatrixRecovery(null, classification), null);
  assert.equal(M.attachMatrixRecovery(explanation, null), explanation);
});

test('MATRIX_UNKNOWN_ERROR_CLASSIFIER 与第一轮 explain 分类器同源', () => {
  const classified = M.MATRIX_UNKNOWN_ERROR_CLASSIFIER.classify(Object.assign(new Error('network timeout'), { code: 'E_X' }));
  // E_* 未知码沿用第一轮目录的归一语义（→ PLAN_INVALID_INPUT），而不是自造类别。
  assert.equal(classified.code, 'PLAN_INVALID_INPUT');
  assert.equal(typeof classified.category, 'string');
});

test('失败矩阵源码确定性门禁：不含 Date.now / Math.random / 动态 import', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension/src/lib/replay-failure-matrix.js'), 'utf8');
  assert.equal(/Date\.now\s*\(/.test(source), false);
  assert.equal(/Math\.random\s*\(/.test(source), false);
  assert.equal(/await import\s*\(/.test(source), false);
});
