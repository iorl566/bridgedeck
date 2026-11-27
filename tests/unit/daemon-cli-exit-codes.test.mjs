// tests/unit/daemon-cli-exit-codes.test.mjs —— CLI 退出码契约（cli/lib/exit-codes.mjs）。
//
// 回归重点：0.3.0 既有退出码（0/1/2/6）的语义一个都不变；新增 3/4/5 只用于
// 第十一批 G 的 batch/lease 命令，且映射是纯函数、可逐条断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_CODES,
  EXIT_CANCELLED,
  EXIT_DIALOG_PENDING,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PARTIAL,
  EXIT_QUOTA,
  EXIT_USAGE,
  batchOutcomeExit,
  describeExitCode,
  exitCodeForArbitration,
  exitCodeForBatch,
  exitCodeForErrorCode,
  exitSummary,
  exitCodeTable,
  formatExitCode,
} from '../../cli/lib/exit-codes.mjs';

test('既有退出码常量保持不变（0 成功 / 1 错误 / 2 参数 / 6 对话框）', () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_ERROR, 1);
  assert.equal(EXIT_USAGE, 2);
  assert.equal(EXIT_DIALOG_PENDING, 6);
  // 新增码不与既有码冲突。
  assert.equal(EXIT_PARTIAL, 3);
  assert.equal(EXIT_QUOTA, 4);
  assert.equal(EXIT_CANCELLED, 5);
});

test('EXIT_CODES：每个码唯一、名称稳定、含含义与适用命令', () => {
  const codes = EXIT_CODES.map((item) => item.code);
  assert.deepEqual(codes, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(codes).size, codes.length);
  const names = EXIT_CODES.map((item) => item.name);
  assert.deepEqual(names, ['ok', 'error', 'usage', 'partial', 'quota', 'cancelled', 'dialog']);
  for (const item of EXIT_CODES) {
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
    assert.equal(typeof item.meaning, 'string');
    assert.ok(Array.isArray(item.commands) && item.commands.length > 0);
  }
  assert.equal(Object.isFrozen(EXIT_CODES), true);
});

test('describeExitCode：已知码返回完整说明，未知码返回 null', () => {
  const ok = describeExitCode(0);
  assert.equal(ok.name, 'ok');
  assert.equal(ok.code, 0);
  const quota = describeExitCode('4');
  assert.equal(quota.name, 'quota');
  assert.equal(describeExitCode(99), null);
  assert.equal(describeExitCode(undefined), null);
});

test('formatExitCode：有登记/未登记两种输出', () => {
  assert.match(formatExitCode(0), /退出码 0（ok）/);
  assert.match(formatExitCode(EXIT_PARTIAL), /partial/);
  assert.match(formatExitCode(77), /未登记/);
});

test('exitCodeTable：表格行覆盖全部退出码且字段形状稳定', () => {
  const table = exitCodeTable();
  assert.equal(table.length, EXIT_CODES.length);
  assert.deepEqual(Object.keys(table[0]).sort(), ['code', 'label', 'meaning', 'name']);
  assert.equal(table[2].code, 2);
  assert.equal(table[2].name, 'usage');
});

test('exitCodeForErrorCode：既有错误码语义不变（对话框 6，其余 1）', () => {
  assert.equal(exitCodeForErrorCode('E_DIALOG_PENDING'), 6);
  assert.equal(exitCodeForErrorCode('E_TIMEOUT'), 1);
  assert.equal(exitCodeForErrorCode('E_NO_SESSION'), 1);
  assert.equal(exitCodeForErrorCode(''), 1);
  assert.equal(exitCodeForErrorCode(undefined), 1);
  // 大小写不敏感。
  assert.equal(exitCodeForErrorCode('e_dialog_pending'), 6);
});

test('batchOutcomeExit：六种批次结论的退出码映射', () => {
  assert.equal(batchOutcomeExit('ok'), 0);
  assert.equal(batchOutcomeExit('partial'), 3);
  assert.equal(batchOutcomeExit('failed'), 1);
  assert.equal(batchOutcomeExit('quota-denied'), 4);
  assert.equal(batchOutcomeExit('cancelled'), 5);
  assert.equal(batchOutcomeExit('rolled-back'), 5);
  assert.equal(batchOutcomeExit('nope'), 1);
  assert.equal(batchOutcomeExit(undefined), 1);
});

test('exitCodeForBatch：优先读 outcome 字符串', () => {
  assert.equal(exitCodeForBatch({ outcome: 'ok', summary: { total: 1, succeeded: 0 } }), 0);
  assert.equal(exitCodeForBatch({ outcome: 'partial' }), 3);
  assert.equal(exitCodeForBatch({ outcome: 'quota-denied' }), 4);
  assert.equal(exitCodeForBatch({ outcome: 'cancelled' }), 5);
  assert.equal(exitCodeForBatch({ outcome: 'failed' }), 1);
  assert.equal(exitCodeForBatch('partial'), 3);
  assert.equal(exitCodeForBatch(null), 1);
});

test('exitCodeForBatch：无 outcome 时按 summary 兜底推导', () => {
  assert.equal(exitCodeForBatch({ summary: { total: 0 } }), 0);
  assert.equal(exitCodeForBatch({ summary: { total: 3, succeeded: 3, failed: 0, denied: 0 } }), 0);
  assert.equal(exitCodeForBatch({ summary: { total: 3, succeeded: 2, failed: 1, denied: 0 } }), 3);
  assert.equal(exitCodeForBatch({ summary: { total: 3, succeeded: 2, failed: 0, denied: 1 } }), 3);
  assert.equal(exitCodeForBatch({ summary: { total: 3, succeeded: 0, failed: 3, denied: 0 } }), 1);
  assert.equal(exitCodeForBatch({ summary: { total: 3, succeeded: 0, failed: 0, denied: 3 } }), 4);
  assert.equal(exitCodeForBatch({ summary: {} }), 0, '空批次（没有条目）视为成功');
});

test('exitCodeForArbitration：dry-run 永远 0，apply 有失败才 1，参数错误 2', () => {
  const plan = { summary: { verdicts: 2 } };
  assert.equal(exitCodeForArbitration(plan), 0);
  assert.equal(exitCodeForArbitration(plan, { apply: false }), 0);
  assert.equal(exitCodeForArbitration({ ...plan, applied: { summary: { ok: 2, failed: 0 } } }, { apply: true }), 0);
  assert.equal(exitCodeForArbitration({ ...plan, applied: { summary: { ok: 1, failed: 1 } } }, { apply: true }), 1);
  assert.equal(exitCodeForArbitration({ ...plan, applied: null }, { apply: true }), 0);
  assert.equal(exitCodeForArbitration({ error: { code: 'E_BAD_ARG' } }), 2);
  assert.equal(exitCodeForArbitration(null), 1);
  assert.equal(exitCodeForArbitration(undefined), 1);
});

test('exitSummary：返回 code/name/label/reason/text 且文本可读', () => {
  const summary = exitSummary(EXIT_QUOTA, '配额不足');
  assert.equal(summary.code, 4);
  assert.equal(summary.name, 'quota');
  assert.equal(summary.label, '配额拒绝');
  assert.equal(summary.reason, '配额不足');
  assert.match(summary.text, /配额拒绝：配额不足/);
  const unknown = exitSummary(99);
  assert.equal(unknown.name, 'unknown');
  assert.match(unknown.text, /未知/);
});

test('退出码文档与 batch/lease 命令的用法文本（映射兼容）', () => {
  // 文档里声明的 partial/quota/cancelled 只属于新命令，不污染旧命令。
  const newCommands = EXIT_CODES.filter((item) => [3, 4, 5].includes(item.code)).flatMap((item) => item.commands);
  assert.ok(newCommands.every((name) => name.includes('batch') || name.includes('lease')), newCommands.join(','));
  // 0/1/2 的 commands 一定包含“全部命令”。
  for (const code of [0, 1, 2]) {
    assert.ok(describeExitCode(code).commands.includes('全部命令'), String(code));
  }
});
