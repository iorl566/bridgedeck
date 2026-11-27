// tests/unit/mcp-error-map.test.mjs —— 工具/资源错误恢复映射层测试。
//
// 覆盖：错误码分类（族/可重试/终端/jsonRpcCode/未知码）、重试计划与指数退避抖动
// （确定性、上限、次数耗尽、不可重试码）、errorEnvelope 文本与历史格式逐字节一致、
// recoveryInline、auditErrorMap 自洽性与 strict 包装。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_RULES,
  ERROR_CATEGORIES,
  NON_RETRYABLE_CODES,
  RETRY_POLICY,
  TERMINAL_CODES,
  assertErrorMap,
  auditErrorMap,
  classifyErrorCode,
  errorEnvelope,
  errorMapSnapshot,
  isRetryable,
  recoveryInline,
  retryDelayMs,
  retryPlan,
} from '../../mcp/error-map.mjs';
import { recoveryHint } from '../../lib/error-codes.mjs';

test('错误族分类：参数/审批/取消/传输/会话/资源/协议/账本/超时', () => {
  const cases = {
    E_ARG_MISSING: ERROR_CATEGORIES.VALIDATION,
    E_ARG_TYPE: ERROR_CATEGORIES.VALIDATION,
    E_TOKEN_BAD_ARG: ERROR_CATEGORIES.VALIDATION,
    E_HUMAN_GATE: ERROR_CATEGORIES.APPROVAL,
    E_CANCELLED: ERROR_CATEGORIES.CANCELLATION,
    E_REQUEST_CANCELLED: ERROR_CATEGORIES.CANCELLATION,
    E_TIMEOUT: ERROR_CATEGORIES.TIMEOUT,
    E_DEADLINE: ERROR_CATEGORIES.TIMEOUT,
    E_DAEMON: ERROR_CATEGORIES.TRANSPORT,
    E_ENV: ERROR_CATEGORIES.TRANSPORT,
    E_NO_SESSION: ERROR_CATEGORIES.SESSION,
    E_SESSION_STOPPED: ERROR_CATEGORIES.SESSION,
    E_TAB_LEASE_HELD: ERROR_CATEGORIES.SESSION,
    E_LEDGER_IO: ERROR_CATEGORIES.LEDGER,
    E_NOT_FOUND: ERROR_CATEGORIES.RESOURCE,
    E_STALE_REF: ERROR_CATEGORIES.RESOURCE,
    E_SNAPSHOT_CORRUPT: ERROR_CATEGORIES.RESOURCE,
    E_PROTOCOL_UNSUPPORTED: ERROR_CATEGORIES.PROTOCOL,
    E_UNKNOWN_METHOD: ERROR_CATEGORIES.PROTOCOL,
    E_INTERNAL: ERROR_CATEGORIES.INTERNAL,
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.equal(classifyErrorCode(code).category, expected, code);
  }
});

test('错误分类字段：retry/hint 来自 lib/error-codes，未知码不猜', () => {
  const known = classifyErrorCode('E_STALE_REF');
  const advice = recoveryHint('E_STALE_REF');
  assert.equal(known.retry, advice.retry);
  assert.equal(known.hint, advice.hint);
  assert.equal(known.knownFamily, true);
  assert.equal(known.terminal, false);

  const unknown = classifyErrorCode('E_COMPLETELY_MADE_UP');
  assert.equal(unknown.category, ERROR_CATEGORIES.UNKNOWN);
  assert.equal(unknown.retry, 'no');
  assert.equal(unknown.hint, '');
  assert.equal(unknown.knownFamily, false);
  assert.equal(unknown.jsonRpcCode, -32603);

  const empty = classifyErrorCode('');
  assert.equal(empty.code, 'E_INTERNAL');
  assert.equal(empty.category, ERROR_CATEGORIES.INTERNAL);
});

test('终端/不可重试集合与 JSON-RPC 映射', () => {
  for (const code of TERMINAL_CODES) {
    const classification = classifyErrorCode(code);
    assert.equal(classification.terminal, true, code);
    assert.equal(classification.nonRetryable, true, code);
  }
  assert.equal(classifyErrorCode('E_NOT_FOUND').jsonRpcCode, -32002);
  assert.equal(classifyErrorCode('E_ARG_MISSING').jsonRpcCode, -32602);
  assert.equal(classifyErrorCode('E_UNKNOWN_METHOD').jsonRpcCode, -32601);
  assert.ok(NON_RETRYABLE_CODES.includes('E_CANCELLED'));
  assert.ok(NON_RETRYABLE_CODES.includes('E_HUMAN_GATE'));
});

test('retryDelayMs：指数退避 + 确定性抖动，永不超上限', () => {
  assert.equal(retryDelayMs(0, { code: 'E_TIMEOUT', jitter: false, baseDelayMs: 100, maxDelayMs: 1000 }), 100);
  assert.equal(retryDelayMs(1, { code: 'E_TIMEOUT', jitter: false, baseDelayMs: 100, maxDelayMs: 1000 }), 200);
  assert.equal(retryDelayMs(2, { code: 'E_TIMEOUT', jitter: false, baseDelayMs: 100, maxDelayMs: 1000 }), 400);
  assert.equal(retryDelayMs(9, { code: 'E_TIMEOUT', jitter: false, baseDelayMs: 100, maxDelayMs: 1000 }), 1000);

  const first = retryDelayMs(1, { code: 'E_TIMEOUT' });
  const second = retryDelayMs(1, { code: 'E_TIMEOUT' });
  assert.equal(first, second, '同输入必得同延迟');
  assert.ok(first >= Math.round(250 * 2 * 0.85) - 1);
  assert.ok(first <= Math.round(250 * 2 * 1.15) + 1);
  assert.notEqual(retryDelayMs(1, { code: 'E_TIMEOUT' }), retryDelayMs(1, { code: 'E_STALE_REF' }));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const delay = retryDelayMs(attempt, { code: 'E_TIMEOUT' });
    assert.ok(delay >= 0 && delay <= RETRY_POLICY.maxDelayMs, String(delay));
  }
});

test('isRetryable / retryPlan：transient 可自动重试、after-action 需先动作、不可重试码', () => {
  // lib/error-codes 的 retry 只有 no / after-action / transient：
  // 只有 transient（会话忙/队列满/限流）适合自动退避重试。
  assert.equal(isRetryable('E_RATE_LIMITED', { attempt: 1, maxAttempts: 3 }), true);
  assert.equal(isRetryable('E_SESSION_BUSY', { attempt: 1, maxAttempts: 3 }), true);
  assert.equal(isRetryable('E_RATE_LIMITED', { attempt: 3, maxAttempts: 3 }), false);
  assert.equal(isRetryable('E_STALE_REF', { attempt: 1, maxAttempts: 3 }), false);
  assert.equal(isRetryable('E_HUMAN_GATE', { attempt: 1, maxAttempts: 3 }), false);
  assert.equal(isRetryable('E_CANCELLED', { attempt: 1, maxAttempts: 3 }), false);
  assert.equal(isRetryable('E_DAEMON', { attempt: 1, maxAttempts: 3 }), false);

  const retryable = retryPlan('E_RATE_LIMITED', { attempt: 1, maxAttempts: 3 });
  assert.equal(retryable.retryable, true);
  assert.equal(retryable.attempt, 1);
  assert.equal(retryable.maxAttempts, 3);
  assert.ok(retryable.delayMs > 0);
  assert.equal(retryable.reason, 'retryable-transient');
  assert.equal(retryable.category, ERROR_CATEGORIES.SESSION);

  const exhausted = retryPlan('E_RATE_LIMITED', { attempt: 3, maxAttempts: 3 });
  assert.equal(exhausted.retryable, false);
  assert.equal(exhausted.delayMs, 0);
  assert.equal(exhausted.reason, 'attempts-exhausted');

  const needsAction = retryPlan('E_STALE_REF', { attempt: 1 });
  assert.equal(needsAction.retryable, false);
  assert.equal(needsAction.needsAction, true);
  assert.equal(needsAction.reason, 'needs-action');
  assert.equal(needsAction.category, ERROR_CATEGORIES.RESOURCE);

  const blocked = retryPlan('E_HUMAN_GATE', { attempt: 1 });
  assert.equal(blocked.retryable, false);
  assert.equal(blocked.reason, 'non-retryable-code');

  const protocol = retryPlan('E_PROTOCOL_UNSUPPORTED', { attempt: 1 });
  assert.equal(protocol.retryable, false);
  assert.equal(protocol.reason, 'non-retryable-code');
});

test('errorEnvelope：文本与历史格式逐字节一致（含/不含 hint）', () => {
  const coded = Object.assign(new Error('ref 失效'), { code: 'E_STALE_REF' });
  const envelope = errorEnvelope(coded, { tool: 'browser_click', tier: 'mutate', elapsedMs: 12 });
  const advice = recoveryHint('E_STALE_REF');
  const expected = 'E_STALE_REF: ref 失效' + (advice.hint ? '\n下一步（' + advice.retry + '）：' + advice.hint : '');
  assert.equal(envelope.text, expected);
  assert.equal(envelope.code, 'E_STALE_REF');
  assert.equal(envelope.record.tool, 'browser_click');
  assert.equal(envelope.record.tier, 'mutate');
  assert.equal(envelope.record.elapsedMs, 12);
  assert.equal(envelope.record.category, ERROR_CATEGORIES.RESOURCE);
  assert.equal(envelope.record.retryable, false);
  assert.equal(envelope.record.retryReason, 'needs-action');
  assert.equal(Object.isFrozen(envelope.record), true);

  const transient = errorEnvelope(Object.assign(new Error('忙'), { code: 'E_RATE_LIMITED' }), { tool: 'browser_observe' });
  assert.equal(transient.record.retryable, true);
  assert.ok(transient.record.retryDelayMs > 0);

  const noHint = errorEnvelope({ code: 'E_PROTOCOL_UNSUPPORTED', message: 'x' });
  assert.equal(noHint.text, 'E_PROTOCOL_UNSUPPORTED: x');
  assert.equal(noHint.record.retryReason, 'non-retryable-code');

  const unknown = errorEnvelope(new Error('boom'));
  assert.equal(unknown.code, 'E_INTERNAL');
  assert.match(unknown.text, /^E_INTERNAL: boom/);
});

test('recoveryInline：资源/提示词错误路径的单行恢复建议', () => {
  const inline = recoveryInline(new Error('未知资源：bridge://nope'), {});
  assert.equal(inline.code, 'E_INTERNAL');
  const coded = recoveryInline(Object.assign(new Error('未知资源'), { code: 'E_NOT_FOUND' }));
  assert.equal(coded.rpcCode, -32002);
  assert.match(coded.text, /^E_NOT_FOUND: 未知资源/);
});

test('auditErrorMap：规则覆盖核心族、集合自洽、strict 包装不抛错', () => {
  const report = auditErrorMap();
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.rules, CATEGORY_RULES.length);
  assert.ok(report.rules >= 8);
  assert.doesNotThrow(() => assertErrorMap());
});

test('errorMapSnapshot：声明 metaKey / 重试策略 / 集合', () => {
  const snapshot = errorMapSnapshot();
  assert.equal(snapshot.metaKey, 'browser-bridge/error');
  assert.equal(snapshot.rules, CATEGORY_RULES.length);
  assert.equal(snapshot.retryPolicy.maxAttempts, RETRY_POLICY.maxAttempts);
  assert.deepEqual([...snapshot.nonRetryable], [...NON_RETRYABLE_CODES]);
  assert.ok(snapshot.categories.includes('approval'));
  assert.equal(snapshot.recoverySource, 'lib/error-codes.mjs');
});
