import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fillPlanFields, fillVerifyFields, planFillSteps } from '../../extension/src/tools/fill-verify.js';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

test('空且简单 input：规划为 1 步 insertText', () => {
  const plan = planFillSteps({ textLike: true, tag: 'input', type: 'text', hadValue: false });
  assert.deepEqual(plan.steps, ['insert']);
  assert.equal(plan.step_count, 1);
  assert.equal(plan.insert_text_calls, 1);
  assert.equal(plan.needs_clear, false);
  assert.equal(plan.strategy, 'fast');
  const fields = fillPlanFields(plan);
  assert.equal(fields.fill_strategy, 'fast');
  assert.deepEqual(fields.fill_steps, ['insert']);
  assert.equal(fields.fill_step_count, 1);
  assert.equal(fields.fill_needs_clear, false);
});

test('已有值/textarea：规划为 focus→clear→insert，共 3 步', () => {
  const filled = planFillSteps({ textLike: true, tag: 'input', hadValue: true });
  assert.deepEqual(filled.steps, ['focus', 'clear', 'insert']);
  assert.equal(filled.step_count, 3);
  assert.equal(filled.needs_clear, true);
  assert.equal(filled.clear_via, 'page-select');
  assert.equal(fillPlanFields(filled).fill_clear_via, 'page-select');

  const area = planFillSteps({ textLike: true, tag: 'textarea', hadValue: true });
  assert.equal(area.step_count, 3);
  assert.equal(area.kind, 'text-control');
});

test('contenteditable（rich-text）：即使 value 为空也走 3 步 + 键盘清空', () => {
  const rich = planFillSteps({ textLike: true, tag: 'div', hadValue: false });
  assert.equal(rich.kind, 'rich-text');
  assert.equal(rich.reason, 'rich-text');
  assert.deepEqual(rich.steps, ['focus', 'clear', 'insert']);
  assert.equal(rich.step_count, 3);
  assert.equal(rich.needs_clear, true);
  assert.equal(rich.clear_via, 'keyboard');
});

test('noClear 追加 2 步；复杂控件走 programmatic 且 ≤3 步', () => {
  const append = planFillSteps({ textLike: true, tag: 'input', hadValue: true, noClear: true });
  assert.deepEqual(append.steps, ['focus', 'insert']);
  assert.equal(append.step_count, 2);
  assert.equal(append.needs_clear, false);

  for (const [tag, inputType] of [['select', 'select-one'], ['input', 'date'], ['input', 'time']]) {
    const plan = planFillSteps({ textLike: false, tag, inputType, hadValue: true });
    assert.equal(plan.strategy, 'programmatic', tag + ' 应按 programmatic 处理');
    assert.ok(plan.step_count <= 3, tag + ' 步骤数超过 3：' + plan.step_count);
    assert.equal(fillPlanFields(plan).fill_strategy, 'programmatic');
  }
});

test('fill 校验证据保留 matches/expected，敏感字段不泄漏值', () => {
  const fields = fillVerifyFields({ value: 'hello', expected_value: 'hello', formatted: false, matches: true });
  assert.equal(fields.matches, true);
  assert.equal(fields.expected_value, 'hello');
  assert.equal(fields.actual_value, 'hello');
  assert.equal(fields.formatted, false);

  const mismatch = fillVerifyFields({ value: 'hello', expected_value: 'world', formatted: true, matches: false });
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.expected_value, 'world');

  const sensitive = fillVerifyFields({ value: 'secret', expected_value: 'secret', formatted: false, matches: true, sensitive: true });
  assert.equal(sensitive.matches, true);
  assert.equal(sensitive.sensitive, true);
  assert.equal('expected_value' in sensitive, false);
  assert.equal('actual_value' in sensitive, false);
});

test('运行时接线：fill 快路径规划/输入时钟/行锚点守卫都接上了', () => {
  const fillActions = read('extension/src/tools/fill-actions.js');
  assert.match(fillActions, /planFillSteps\(/);
  assert.match(fillActions, /fillPlanFields\(plan\)/);
  assert.match(fillActions, /inputEventStamp\(tabId, 'fill-insert'\)/);
  assert.match(fillActions, /checkRowAnchor\(facts\)/, '没有校验行锚点');
  assert.match(fillActions, /guardRowAnchor\(params\)/, 'fill 入口没有行锚点守卫');
  assert.match(fillActions, /throw bridgeError\('E_TARGET_MISMATCH'/, '行锚点拒绝没有协议错误码');

  const pointerActions = read('extension/src/tools/pointer-actions.js');
  assert.ok((pointerActions.match(/timestamp: /g) || []).length >= 6, 'pointer-actions 鼠标事件缺少 timestamp');
  assert.match(pointerActions, /inputEventStamp\(tabId/, 'pointer-actions 没有接入输入时钟');

  const primitives = read('extension/src/tools/pointer-primitives.js');
  assert.match(primitives, /timestamp: stamp\.timestamp/);
  assert.match(primitives, /inputTransactions\.stamp\(tabId\)/);
});

const browser = findBrowser();

test('真实 headless DOM：空输入 1 步、有值/富文本 ≤3 步、虚拟化行被 guard 拒绝', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/fill-transaction.html', { timeoutMs: 20000 });
  assert.match(result.title, /^FILL_TX_OK:\d+$/, result.title + (result.stderr ? ' | ' + result.stderr.slice(0, 400) : ''));
});
