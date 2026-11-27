// packages/vom/test/affordance-diff.test.ts —— affordance JS ↔ TS 差分测试。
//
// 输入覆盖边界：null/undefined/空对象、缺失字段、异常 role（数字/null/大写约定）、
// 两套字段名（type/inputType、contentEditable/contenteditable、tabIndex/tabindex、
// overflowY/overflow）、祖先链非数组、长名字截断、关闭语义在/不在 dialog 内、
// 负数/小数 tabIndex、aria 布尔、同分优先级等。
//
// 除逐字段 deepEqual 外，还断言输出自身的不变量（confidence ∈ [0,1]、evidence ≤ 4、
// alternatives ≤ 2、type 合法），避免“两边一起错”也能过。

import test from 'node:test';
import assert from 'node:assert/strict';

import { AFFORDANCE_TYPES, AFFORDANCE_VERSION, affordanceForNode, summarizeAffordances } from '../src/index.ts';
import type { AffordanceInput } from '../src/index.ts';

const js: any = await import('../../../extension/src/lib/vom-affordance.js');

/** 测试夹具允许传入任意页面事实（运行期数据不可信，类型只约束调用方）。 */
function asNode(value: unknown): AffordanceInput {
  return value as AffordanceInput;
}

const CASES: readonly { label: string; node: unknown }[] = [
  { label: 'null', node: null },
  { label: 'undefined', node: undefined },
  { label: '空对象', node: {} },
  { label: '非对象输入', node: 'button' },
  { label: '普通按钮', node: { role: 'button', name: '提交' } },
  { label: '文件输入（inputType）', node: { tag: 'input', inputType: 'file' } },
  { label: '文件输入（type 回退字段）', node: { tag: 'input', type: 'FILE' } },
  { label: '复选输入（type 回退）', node: { tag: 'input', type: 'checkbox' } },
  { label: '下拉框+焦点', node: { role: 'combobox', tabIndex: 0 } },
  { label: '文本域+contenteditable 小写字段', node: { tag: 'textarea', contenteditable: 'true' } },
  { label: '链接（长 href + 大写 role）', node: { tag: 'a', role: 'LINK', href: 'https://example.com/' + 'x'.repeat(120) } },
  { label: 'dialog 内的 close 按钮', node: { role: 'button', name: 'Close', ancestors: [{ role: 'dialog' }, null] } },
  { label: 'dialog 内的中文关闭按钮', node: { tag: 'button', name: '关闭弹窗', ancestors: [{ tag: 'dialog' }] } },
  { label: '超过 12 字的取消前缀按钮（不算关闭）', node: { role: 'button', name: '取消订单并返回上一页重新选择' } },
  { label: 'slider + 拖拽事实', node: { role: 'slider', draggable: true, dragHint: 'drag-handle' } },
  { label: '头部 menuitem + popup', node: { role: 'menuitem', ariaHasPopup: 'menu', hoverable: true, cursor: 'pointer' } },
  { label: '大写 overflow 触发滚动', node: { overflowY: 'AUTO', scrollable: false } },
  { label: '异常 role/数字字段', node: { role: 42, tag: null, name: 123, tabIndex: -2 } },
  { label: 'contentEditable 大小写 + 小数 tabIndex', node: { contentEditable: true, tabIndex: 2.5, tabindex: 3 } },
  { label: 'gridcell + aria 布尔', node: { role: 'gridcell', ariaPressed: false, expanded: true } },
  { label: 'summary 折叠', node: { tag: 'summary', expanded: false } },
  { label: 'option/select 组合', node: { role: 'option', tag: 'select', scrollable: true, ariaHasPopup: 'true' } },
  { label: '祖先链非数组', node: { role: 'dialog', ancestors: 'dialog' } },
  { label: '关闭前缀 + 超长名字', node: { role: 'button', name: 'Close the current modal dialog please' } },
  { label: '邮箱输入', node: { tag: 'input', inputType: 'email', name: '邮箱' } },
  { label: 'switch 短取消名（非 clickable role）', node: { role: 'switch', name: '取消' } },
  { label: '上传按钮', node: { role: 'button', name: '上传附件' } },
  { label: '无 role + pointer cursor', node: { cursor: 'pointer', clickable: true } },
];

test('affordanceForNode：全部用例逐字段相等', () => {
  for (const { label, node } of CASES) {
    const expected = js.affordanceForNode(asNode(node) as unknown);
    const actual = affordanceForNode(asNode(node));
    assert.deepEqual(
      JSON.parse(JSON.stringify(actual)),
      JSON.parse(JSON.stringify(expected)),
      label + ' 的 affordance 不一致',
    );
  }
});

test('summarizeAffordances：节点集合统计逐字段相等', () => {
  const nodes = CASES.map((item) => item.node);
  assert.deepEqual(
    JSON.parse(JSON.stringify(summarizeAffordances(nodes))),
    JSON.parse(JSON.stringify(js.summarizeAffordances(nodes))),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(summarizeAffordances('not-an-array'))),
    JSON.parse(JSON.stringify(js.summarizeAffordances('not-an-array'))),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(summarizeAffordances([]))),
    { version: 1, total: 0, byType: {} },
  );
});

test('输出不变量：confidence ∈ [0,1]、evidence ≤ 4、alternatives ≤ 2、type 合法', () => {
  const validTypes = new Set<string>([...AFFORDANCE_TYPES, 'none']);
  for (const { label, node } of CASES) {
    const result = affordanceForNode(asNode(node));
    assert.ok(result.confidence >= 0 && result.confidence <= 1, label + ' confidence 越界：' + result.confidence);
    assert.ok(validTypes.has(result.type), label + ' 非法 type：' + result.type);
    assert.ok(result.evidence.length <= 4, label + ' evidence 超过 4 条');
    assert.ok(result.alternatives.length <= 2, label + ' alternatives 超过 2 条');
    assert.equal(new Set(result.alternatives.map((item) => item.type)).size, result.alternatives.length, label + ' alternatives 有重复 type');
    for (const evidence of result.evidence) {
      assert.equal(typeof evidence.rule, 'string');
      assert.equal(typeof evidence.field, 'string');
      assert.ok(evidence.value === null || ['string', 'number', 'boolean'].includes(typeof evidence.value));
    }
  }
});

test('关键语义硬断言（不依赖 JS 对照）', () => {
  const file = affordanceForNode({ tag: 'input', inputType: 'file' });
  assert.equal(file.type, 'upload');
  assert.equal(file.confidence, 0.95);
  assert.deepEqual(file.evidence, [{ rule: 'input:file', field: 'inputType', value: 'file' }]);

  const closeInDialog = affordanceForNode({ role: 'button', name: 'Close', ancestors: [{ role: 'dialog' }] });
  assert.equal(closeInDialog.type, 'dismiss');
  assert.equal(closeInDialog.confidence, 0.9);
  assert.equal(closeInDialog.evidence[0]?.rule, 'name:close+anchor:dialog');
  assert.deepEqual(closeInDialog.alternatives, [{ type: 'activate', confidence: 0.85 }]);

  // 不在 dialog 内的 close 按钮：dismiss 0.72 低于 activate 0.85，主 affordance 是 activate，
  // 但 dismiss 仍作为备选出现（调用方可以按上下文升级）。
  const closeOutside = affordanceForNode({ role: 'button', name: 'Close' });
  assert.equal(closeOutside.type, 'activate');
  assert.equal(closeOutside.confidence, 0.85);
  assert.deepEqual(closeOutside.alternatives, [{ type: 'dismiss', confidence: 0.72 }]);

  // 取消订单（4 字，命中“短取消前缀”）主 affordance 仍是 activate（0.85 > 0.72 dismiss）。
  const businessButton = affordanceForNode({ role: 'button', name: '取消订单' });
  assert.equal(businessButton.type, 'activate');
  assert.equal(businessButton.confidence, 0.85);
  assert.deepEqual(businessButton.alternatives, [{ type: 'dismiss', confidence: 0.72 }]);

  assert.deepEqual(affordanceForNode(null), { type: 'none', confidence: 0, evidence: [], alternatives: [] });
  assert.deepEqual(affordanceForNode({}), { type: 'none', confidence: 0, evidence: [], alternatives: [] });
  assert.equal(AFFORDANCE_VERSION, 1);
  assert.deepEqual([...AFFORDANCE_TYPES], ['activate', 'type', 'toggle', 'select', 'drag', 'scroll', 'dismiss', 'hover', 'focus', 'upload']);
});

test('同分时按 TYPE_PRIORITY 取主 affordance（upload > toggle > select > type > drag > scroll > dismiss > hover > activate > focus）', () => {
  // input[type=file] 只命中 upload，没有并列候选。
  const file = affordanceForNode({ tag: 'input', inputType: 'file' });
  assert.equal(file.type, 'upload');
  assert.deepEqual(file.alternatives, []);

  // 0.9 并列：toggle(1) 先于 type(3)，focus 作为第三备选。
  const checkboxEditable = affordanceForNode({ role: 'checkbox', contentEditable: true });
  assert.equal(checkboxEditable.type, 'toggle');
  assert.deepEqual(checkboxEditable.alternatives, [
    { type: 'type', confidence: 0.9 },
    { type: 'focus', confidence: 0.35 },
  ]);

  // 0.85 并列：toggle 先于 activate；scroll 先于 activate。
  assert.equal(affordanceForNode({ role: 'button', ariaPressed: true }).type, 'toggle');
  assert.equal(affordanceForNode({ role: 'button', scrollable: true }).type, 'scroll');

  // 0.8 并列：type(3) 先于 activate(8)。
  assert.equal(affordanceForNode({ role: 'textbox', href: 'https://example.com' }).type, 'type');

  // 0.6 并列：select(2) 先于 hover(7)。
  const optionHoverable = affordanceForNode({ role: 'option', hoverable: true });
  assert.equal(optionHoverable.type, 'select');
  assert.deepEqual(optionHoverable.alternatives, [{ type: 'hover', confidence: 0.6 }]);

  // 置信度优先于 TYPE_PRIORITY：spinbutton 的 type(0.8) 压过 drag(0.5)。
  assert.equal(affordanceForNode({ role: 'spinbutton', clickable: true }).type, 'type');

  // summary + toggle role：两个 toggle 证据同分 0.9，全部保留在主 affordance 的 evidence 里。
  const summary = affordanceForNode({ tag: 'summary', role: 'checkbox', tabIndex: 1 });
  assert.equal(summary.type, 'toggle');
  assert.equal(summary.confidence, 0.9);
  assert.deepEqual(summary.evidence.map((item) => item.rule), ['role:checkable', 'tag:summary']);
  assert.deepEqual(summary.alternatives, [{ type: 'focus', confidence: 0.35 }]);
});
