import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DATE_INPUT_TYPES,
  classifyFillControl,
  fillPlanFields,
  fillStepEvidence,
  fillVerifyFields,
  isDateInputType,
  planFillSteps,
} from '../../extension/src/tools/fill-verify.js';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

test('控件分类：select/date/contenteditable/checkbox/file/文本各自有明确路径', () => {
  assert.deepEqual([...DATE_INPUT_TYPES].sort(), ['date', 'datetime-local', 'month', 'time', 'week']);
  assert.equal(isDateInputType('DATE'), true);
  assert.equal(isDateInputType('text'), false);

  const select = classifyFillControl({ tag: 'select', textLike: false });
  assert.equal(select.kind, 'select');
  assert.equal(select.path, 'page-select');
  assert.equal(select.fillable, true);

  const date = classifyFillControl({ tag: 'input', inputType: 'datetime-local', textLike: false });
  assert.equal(date.kind, 'date-control');
  assert.equal(date.path, 'native-value-setter');

  const ce = classifyFillControl({ tag: 'div', isContentEditable: true, textLike: true });
  assert.equal(ce.kind, 'contenteditable');
  assert.equal(ce.clearVia, 'keyboard');

  const checkbox = classifyFillControl({ tag: 'input', inputType: 'checkbox', textLike: false });
  assert.equal(checkbox.kind, 'check-control');
  assert.equal(checkbox.fillable, false);
  const file = classifyFillControl({ tag: 'input', inputType: 'file', textLike: false });
  assert.equal(file.kind, 'file-control');
  assert.equal(file.fillable, false);

  const text = classifyFillControl({ tag: 'input', inputType: 'text', textLike: true, hadValue: true });
  assert.equal(text.kind, 'text-control');
  const area = classifyFillControl({ tag: 'textarea', textLike: true });
  assert.equal(area.kind, 'text-control');
});

test('3 步规划：select 的中间步是 match-option，date 是 set-value，证据 via 可执行', () => {
  const select = planFillSteps({ textLike: false, tag: 'select' });
  assert.equal(select.step_count, 3);
  assert.deepEqual(select.steps, ['focus', 'match-option', 'commit']);
  assert.deepEqual(select.step_evidence.map((item) => item.via), ['element-focus', 'page-lib:select', 'input+change']);

  const date = planFillSteps({ textLike: false, tag: 'input', inputType: 'date' });
  assert.equal(date.step_count, 3);
  assert.deepEqual(date.steps, ['focus', 'set-value', 'commit']);
  assert.deepEqual(date.step_evidence.map((item) => item.via), ['element-focus', 'native-value-setter', 'input+change']);
  assert.equal(date.control_kind, 'date-control');

  const check = planFillSteps({ textLike: false, tag: 'input', inputType: 'checkbox' });
  assert.equal(check.strategy, 'programmatic');
  assert.equal(check.step_count <= 3, true);
});

test('富文本/文本控件：clear_via、control_kind 与每步 via 保留既有语义', () => {
  const rich = planFillSteps({ textLike: true, tag: 'div', isContentEditable: true, hadValue: true });
  assert.equal(rich.kind, 'rich-text', 'kind 必须保持既有 rich-text 语义');
  assert.equal(rich.control_kind, 'contenteditable');
  assert.equal(rich.clear_via, 'keyboard');
  assert.deepEqual(rich.step_evidence.map((item) => item.via), ['element-focus', 'keyboard:Control+a', 'cdp-insertText']);

  const existing = planFillSteps({ textLike: true, tag: 'input', hadValue: true });
  assert.equal(existing.clear_via, 'page-select');
  assert.equal(existing.step_evidence[1].via, 'page-select');

  const empty = planFillSteps({ textLike: true, tag: 'input', hadValue: false });
  assert.deepEqual(empty.step_evidence, [{ step: 'insert', via: 'cdp-insertText' }]);

  const append = planFillSteps({ textLike: true, tag: 'input', hadValue: true, noClear: true });
  assert.deepEqual(append.step_evidence.map((item) => item.step), ['focus', 'insert']);
});

test('步骤证据合并：ok/detail 反映每一步真实结果，失败步骤可定位', () => {
  const plan = planFillSteps({ textLike: true, tag: 'input', hadValue: true });
  const evidence = fillStepEvidence(plan, {
    focus: { focused: true },
    clear: { via: 'page-select' },
    insert: false,
  });
  assert.equal(evidence.length, 3);
  assert.equal(evidence[0].ok, true);
  assert.equal(evidence[0].detail.focused, true);
  assert.equal(evidence[2].ok, false);
  assert.equal(evidence[2].reason, 'step-failed');
  const fields = fillPlanFields({ ...plan, observed: { focus: true, clear: true, insert: { matches: false } } });
  assert.equal(fields.fill_step_evidence.length, 3);
  assert.equal(fields.fill_step_evidence[2].detail.matches, false);
  assert.deepEqual(fields.fill_steps, ['focus', 'clear', 'insert']);
  assert.equal(fields.fill_control_kind, 'text-control');
  assert.equal(fields.fill_path, 'trusted-insert');
});

test('敏感字段读回仍只回 formatted/matches，不因步骤证据泄漏值', () => {
  const fields = fillVerifyFields({ value: null, expected_value: null, formatted: false, matches: true, sensitive: true });
  assert.equal(fields.sensitive, true);
  assert.equal(fields.matches, true);
  assert.equal('actual_value' in fields, false);
  assert.equal('expected_value' in fields, false);
});

test('运行时接线：select/date/contenteditable 三条真实路径都在 fill-actions 里', () => {
  const fill = read('extension/src/tools/fill-actions.js');
  assert.match(fill, /execPage\(tabId, 'select'/, 'select 真实路径没有调用页面库 select 命令');
  assert.match(fill, /execPage\(tabId, 'node-signature'/, '没有用 node-signature 识别 select');
  assert.match(fill, /function selectProgrammaticFill/, '缺少 select 路径');
  assert.match(fill, /function dateProgrammaticFill/, '缺少 date 路径');
  assert.match(fill, /via: 'native-value-setter'/, 'date 路径没有原生 setter 证据');
  assert.match(fill, /classifyFillControl\(\{ tag: 'input', inputType: fast\.inputType/, 'date 分派没有用控件分类');
  assert.match(fill, /function legacyProgrammaticFill/, '缺少其它 programmatic 控件的回退路径');
  assert.match(fill, /fillPlanFields\(\{ \.\.\.plan, observed \}\)/, 'fill 结果没有摊平步骤证据字段');
  assert.match(fill, /planFillSteps\(\{[\s\S]{0,180}isContentEditable/, '快路径没有把 contenteditable 事实传给规划');
  // 快路径规划与读回字段仍由同一模块提供。
  const verify = read('extension/src/tools/fill-verify.js');
  assert.match(verify, /fill_step_evidence/, 'fillPlanFields 没有输出步骤证据字段');
  assert.match(verify, /export function classifyFillControl/);
  assert.match(verify, /export function fillStepEvidence/);
  assert.match(verify, /export const DATE_INPUT_TYPES/);
});

const browser = findBrowser();

test('真实 headless DOM：select/date/contenteditable 步骤证据 + 行事实探针稳定/回收/平移', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/fill-transaction.html', { timeoutMs: 30000 });
  assert.match(result.title, /^FILL_TX_OK:(\d+)$/, result.title + (result.stderr ? ' | ' + result.stderr.slice(0, 400) : ''));
  const count = Number(/^FILL_TX_OK:(\d+)$/.exec(result.title)[1]);
  assert.equal(count, 10, '真实 DOM 场景数量变了（期望 10 个场景全部通过）：' + result.title);
});
