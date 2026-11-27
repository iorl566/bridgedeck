// 错误恢复映射：daemon/CLI 错误码 → 可执行下一步；渲染层 error 输出；直连回退边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ERROR_CODE_LIST } from '../../lib/error-codes.mjs';
import { DaemonRpcError } from '../../dsh-plugin/lib/daemon-rpc.mjs';
import { BridgeCliError } from '../../dsh-plugin/lib/bridge.mjs';
import {
  canFallbackToCli,
  describeError,
  ERROR_ACTIONS,
  FALLBACK_CODES,
  isAutoRetrySafe,
  isDaemonRpcError,
  nextActionsFor,
  PLUGIN_ONLY_CODES,
  RETRY_POLICIES,
} from '../../dsh-plugin/lib/error-recovery.mjs';
import { errorResultFor, renderErrorText, renderToolResult, wrapToolExecute } from '../../dsh-plugin/lib/tool-output.mjs';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'dsh-plugin');
const VALID_STEP_KINDS = new Set(['tool', 'cli', 'human', 'wait']);
const VALID_RETRY = new Set(Object.keys(RETRY_POLICIES));
const TOOL_NAMES = new Set(buildToolSpecs(async () => ({})).map((spec) => spec.name));

test('仓库权威错误码全部显式登记，且没有多余编码', () => {
  // eval 离线工具链的错误码只在开发期 Node 脚本里抛，不会经 daemon/CLI 到达插件，
  // 因此不要求插件侧提供恢复动作；其余每个码都必须显式登记。
  const INTERNAL_ONLY = new Set([
    'E_EVAL_CORPUS',
    'E_EVAL_RUNNER',
    'E_EVAL_DOM',
    'E_EVAL_DOM_ARGS',
    'E_EVAL_DOM_BAD_FACTS',
    'E_EVAL_DOM_BAD_JSON',
    'E_EVAL_DOM_FIXTURE',
    'E_EVAL_DOM_NO_BROWSER',
    'E_EVAL_DOM_NO_FACTS',
    'E_EVAL_DOM_NO_MARKER',
    'E_EVAL_DOM_SPAWN',
  ]);
  assert.ok(ERROR_CODE_LIST.length >= 122, '权威错误码不应少于 122 个，实际 ' + ERROR_CODE_LIST.length);
  const required = ERROR_CODE_LIST.filter((code) => !INTERNAL_ONLY.has(code));
  const missing = required.filter((code) => !ERROR_ACTIONS[code]);
  assert.deepEqual(missing, [], '未登记恢复动作的错误码：' + missing.join(', '));
  for (const code of required) assert.equal(nextActionsFor(code).known, true, code + ' 应显式登记');
  for (const code of INTERNAL_ONLY) assert.ok(ERROR_CODE_LIST.includes(code), '内部码不在权威清单：' + code);
  const registered = Object.keys(ERROR_ACTIONS);
  const extra = registered.filter((code) => !ERROR_CODE_LIST.includes(code) && !PLUGIN_ONLY_CODES.includes(code));
  assert.deepEqual(extra, [], '映射里出现清单外错误码：' + extra.join(', '));
  for (const code of PLUGIN_ONLY_CODES) assert.ok(ERROR_ACTIONS[code], '插件自有码缺少恢复动作：' + code);
});

test('每个错误码都有可执行的下一步与合法重试语义', () => {
  for (const code of Object.keys(ERROR_ACTIONS)) {
    const action = nextActionsFor(code);
    assert.ok(VALID_RETRY.has(action.retry), code + ' retry 非法：' + action.retry);
    assert.ok(action.steps.length >= 1, code + ' 没有任何下一步');
    for (const step of action.steps) {
      assert.ok(VALID_STEP_KINDS.has(step.kind), code + ' step kind 非法：' + step.kind);
      assert.ok(step.hint.length >= 8, code + ' step hint 过短：' + step.hint);
      if (step.kind === 'tool') assert.ok(TOOL_NAMES.has(step.target), code + ' 引用了不存在的工具：' + step.target);
      if (step.kind === 'cli') assert.match(step.target, /^(bridge |node )/, code + ' cli 目标不是可执行命令：' + step.target);
      if (step.kind === 'human' || step.kind === 'wait') assert.equal(step.target, null);
    }
    for (const doc of action.docs) {
      assert.ok(fs.existsSync(path.join(PLUGIN, 'skill', doc)), code + ' 的参考不存在：' + doc);
    }
  }
});

test('重试语义与仓库 lib/error-codes.mjs 的既定分类一致', () => {
  const afterAction = ['E_STALE_REF', 'E_DIALOG_PENDING', 'E_LEDGER_PENDING', 'E_NO_SESSION', 'E_TIMEOUT'];
  for (const code of afterAction) assert.equal(nextActionsFor(code).retry, 'after-action', code);
  const transient = ['E_SESSION_BUSY', 'E_RATE_LIMITED', 'E_QUEUE_FULL', 'E_DAEMON', 'E_RECIPE_LOCKED'];
  for (const code of transient) assert.equal(nextActionsFor(code).retry, 'transient', code);
  const noRetry = ['E_BAD_ARG', 'E_FORBIDDEN', 'E_READ_ONLY', 'E_UNSUPPORTED_CAPABILITY', 'E_EXPECT_FAILED', 'E_BORROW_DENIED'];
  for (const code of noRetry) assert.equal(nextActionsFor(code).retry, 'no', code);
});

test('只有“请求尚未到 daemon”的两个码允许回退 CLI', () => {
  assert.deepEqual(FALLBACK_CODES, ['E_DAEMON', 'E_DIRECT_RPC_DISABLED']);
  assert.equal(canFallbackToCli({ code: 'E_DAEMON' }), true);
  assert.equal(canFallbackToCli('E_DIRECT_RPC_DISABLED'), true);
  for (const code of ['E_TIMEOUT', 'E_FORBIDDEN', 'E_NO_SESSION', 'E_STALE_REF', 'E_RPC', undefined, 'nope']) {
    assert.equal(canFallbackToCli({ code }), false, String(code));
  }
});

test('非幂等工具即使遇到瞬时错误也不自动重试', () => {
  assert.equal(isAutoRetrySafe('E_SESSION_BUSY', { idempotent: true }), true);
  assert.equal(isAutoRetrySafe('E_SESSION_BUSY', { idempotent: false }), false);
  assert.equal(isAutoRetrySafe('E_TIMEOUT', { idempotent: true }), false);
  assert.equal(isAutoRetrySafe('E_UNKNOWN_CODE', {}), false);
  // 与 spec 元数据联动：browser_act 非幂等，browser_observe 幂等。
  const specs = buildToolSpecs(async () => ({}));
  const act = specs.find((spec) => spec.name === 'browser_act');
  const observe = specs.find((spec) => spec.name === 'browser_observe');
  assert.equal(isAutoRetrySafe('E_SESSION_BUSY', act), false);
  assert.equal(isAutoRetrySafe('E_SESSION_BUSY', observe), true);
});

test('describeError 保留错误码/消息/诊断数据，未知码回落到 E_INTERNAL 指引', () => {
  const rpcError = new DaemonRpcError('E_NO_SESSION', '没有活动会话', { hint: 'start' });
  const described = describeError(rpcError, { tool: 'browser_act', idempotent: false, risk: 'write', sessionId: 's1' });
  assert.equal(described.code, 'E_NO_SESSION');
  assert.equal(described.message, '没有活动会话');
  assert.equal(described.data, '{"hint":"start"}');
  assert.equal(described.tool, 'browser_act');
  assert.equal(described.risk, 'write');
  assert.equal(described.sessionId, 's1');
  assert.ok(described.steps.some((step) => step.target === 'browser_session_start'));
  assert.equal(described.known, true);
  assert.equal(isDaemonRpcError(rpcError), true);
  assert.equal(isDaemonRpcError(new Error('x')), false);

  const unknown = describeError({ code: 'E_NOT_REGISTERED', message: 'x' });
  assert.equal(unknown.known, false);
  assert.ok(unknown.steps.length >= 1);

  const huge = describeError({ code: 'E_INTERNAL', message: 'm', data: { blob: 'x'.repeat(2000) } });
  assert.ok(huge.data.length <= 801, '诊断数据应被截断');
  assert.match(huge.data, /…$/);

  const stringError = describeError('E_TIMEOUT');
  assert.equal(stringError.code, 'E_TIMEOUT');
  assert.equal(stringError.message, 'E_TIMEOUT');
});

test('errorResultFor：参数校验错误映射 E_BAD_ARG，业务错误保留码', () => {
  const specs = buildToolSpecs(async () => ({}));
  const act = specs.find((spec) => spec.name === 'browser_act');
  const invalid = errorResultFor(act, new Error('需要 ref（@eN）或 selector（CSS）之一'), { action: 'click' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.tool, 'browser_act');
  assert.equal(invalid.invalidArgs, true);
  assert.equal(invalid.error.code, 'E_BAD_ARG');

  const business = errorResultFor(act, new BridgeCliError('E_STALE_REF', 'ref 失效'), { action: 'click', ref: '@e1', sessionId: 's1' });
  assert.equal(business.ok, false);
  assert.equal(business.error.code, 'E_STALE_REF');
  assert.equal(business.error.sessionId, 's1');
  assert.ok(business.error.steps.some((step) => step.target === 'browser_observe'));
  assert.equal(business.invalidArgs, undefined);
});

test('渲染层：成功是 JSON，失败给错误码 + 重试语义 + 下一步 + 参考', () => {
  const success = renderToolResult({}, { port: 4242, browsers: [] });
  assert.equal(success.length, 1);
  assert.equal(success[0].type, 'text');
  assert.match(success[0].text, /"port": 4242/);

  const specs = buildToolSpecs(async () => ({}));
  const observe = specs.find((spec) => spec.name === 'browser_observe');
  const errorValue = errorResultFor(observe, new DaemonRpcError('E_STALE_REF', 'ref 已不在文档里'), { sessionId: 's1' });
  const rendered = renderToolResult({}, errorValue);
  assert.equal(rendered.length, 1);
  const text = rendered[0].text;
  assert.match(text, /^\[失败\] browser_observe：E_STALE_REF/);
  assert.match(text, /重试语义：/);
  assert.match(text, /下一步：/);
  assert.match(text, /\[工具\] browser_observe/);
  assert.match(text, /参考：references\/actions-guide\.md/);
  assert.match(renderErrorText(errorValue.error), /不要自动重试/);

  // human 步骤必须显式标注“问用户”，模型不能把它当成自动动作。
  const humanError = describeError({ code: 'E_BORROW_DENIED', message: '用户拒绝借用' });
  assert.match(renderErrorText(humanError), /\[问用户\]/);
});

test('wrapToolExecute：成功原样返回，带码错误转结构化结果，参数错误仍抛出', async () => {
  const okSpec = { name: 'browser_act', risk: 'write', idempotent: false, execute: async (args) => ({ ok: true, args }) };
  const wrappedOk = wrapToolExecute(okSpec);
  assert.deepEqual(await wrappedOk({ action: 'click' }, {}), { ok: true, args: { action: 'click' } });

  const failSpec = {
    name: 'browser_act',
    risk: 'write',
    idempotent: false,
    execute: async () => {
      throw new DaemonRpcError('E_FORBIDDEN', '被策略禁止');
    },
  };
  const wrappedFail = wrapToolExecute(failSpec);
  const result = await wrappedFail({ action: 'click', ref: '@e1' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_FORBIDDEN');
  assert.equal(result.tool, 'browser_act');

  // 参数校验错误（无 code）保持抛出：模型应改调用方式，而不是把它当“执行失败”的结果。
  const invalidSpec = {
    name: 'browser_act',
    risk: 'write',
    idempotent: false,
    execute: async () => {
      throw new Error('需要 ref（@eN）或 selector（CSS）之一');
    },
  };
  await assert.rejects(() => wrapToolExecute(invalidSpec)({ action: 'click' }, {}), /需要 ref/);
});
