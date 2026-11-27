// 工具行为元数据：37 个工具的分类/风险/幂等/副作用/恢复建议是否完整且自洽。
// 同时校验 TOOLS.md 生成物与实现同步（生成器 --check 的等价断言）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildToolSpecs, TOOL_METHODS } from '../../dsh-plugin/lib/tools.mjs';
import {
  applyToolMetadata,
  CATEGORIES,
  groupByCategory,
  RISK_LEVELS,
  SIDE_EFFECTS,
  summarizeMetadata,
  TOOL_METADATA,
  validateMetadataCoverage,
} from '../../dsh-plugin/lib/tool-metadata.mjs';
import { buildToolsDoc, renderToolsDoc } from '../../dsh-plugin/scripts/build-tools-doc.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'dsh-plugin');
const specs = buildToolSpecs(async () => ({}));
const byName = new Map(specs.map((spec) => [spec.name, spec]));

test('元数据与工具表一一对应（37 个，无缺失/多余）', () => {
  assert.equal(specs.length, 37);
  assert.deepEqual(validateMetadataCoverage(specs.map((spec) => spec.name)), { count: 37 });
  assert.equal(Object.keys(TOOL_METADATA).length, 37);
});

test('每个 spec 暴露分类/风险/幂等/副作用/恢复/参考/annotations', () => {
  for (const spec of specs) {
    assert.ok(Object.prototype.hasOwnProperty.call(CATEGORIES, spec.category), spec.name + ' category 非法');
    assert.equal(spec.categoryLabel, CATEGORIES[spec.category].label);
    assert.ok(RISK_LEVELS.includes(spec.risk), spec.name + ' risk 非法');
    assert.equal(typeof spec.idempotent, 'boolean');
    assert.ok(Array.isArray(spec.sideEffects), spec.name + ' sideEffects 应为数组');
    for (const effect of spec.sideEffects) assert.ok(SIDE_EFFECTS[effect], spec.name + ' 未知 sideEffect：' + effect);
    assert.ok(spec.recovery.length >= 12, spec.name + ' recovery 过短');
    assert.ok(Array.isArray(spec.docs) && spec.docs.length >= 1, spec.name + ' 缺少 docs');
    assert.ok(spec.title.length >= 2, spec.name + ' 缺少 title');
    assert.equal(typeof spec.annotations, 'object');
    assert.equal(spec.annotations.title, spec.title);
    assert.equal(spec.annotations.readOnlyHint, spec.risk === 'read');
    assert.equal(spec.annotations.destructiveHint, spec.risk === 'destructive');
    assert.equal(spec.annotations.idempotentHint, spec.idempotent);
    assert.equal(spec.annotations.openWorldHint, true);
  }
});

test('协议方法随 spec 暴露且与 TOOL_METHODS 完全一致', () => {
  for (const spec of specs) {
    assert.deepEqual(spec.methods, TOOL_METHODS[spec.name], spec.name + ' methods 不一致');
  }
});

test('风险不变量：只读必须幂等且无页面/浏览器副作用，破坏性必须声明副作用', () => {
  for (const spec of specs) {
    if (spec.risk === 'read') {
      assert.equal(spec.idempotent, true, spec.name + ' 只读工具必须幂等');
      for (const forbidden of ['page', 'browser', 'session', 'settings', 'external']) {
        assert.ok(!spec.sideEffects.includes(forbidden), spec.name + ' 只读工具不应有 ' + forbidden + ' 副作用');
      }
    }
    if (spec.risk === 'destructive') assert.ok(spec.sideEffects.length >= 1, spec.name + ' 破坏性工具缺副作用');
    if (spec.sideEffects.includes('page')) assert.notEqual(spec.risk, 'read');
  }
});

test('风险/幂等分布快照（防止元数据被悄悄改写）', () => {
  const summary = summarizeMetadata(specs);
  assert.equal(summary.total, 37);
  assert.equal(summary.withRecovery, 37);
  assert.deepEqual(summary.risks, { read: 11, write: 19, destructive: 7 });
  assert.equal(summary.idempotent, 17);
  assert.equal(Object.keys(summary.byCategory).length, Object.keys(CATEGORIES).length);
  assert.equal(Object.values(summary.byCategory).reduce((sum, count) => sum + count, 0), 37);
  for (const category of Object.keys(CATEGORIES)) assert.ok(summary.byCategory[category] >= 1, '分类没有被使用：' + category);
});

test('关键工具的语义标注符合预期', () => {
  const readOnly = ['browser_observe', 'browser_read', 'browser_status', 'browser_brief', 'browser_audit'];
  for (const name of readOnly) assert.equal(byName.get(name).risk, 'read', name);
  const destructive = ['browser_eval', 'browser_recipe', 'browser_pair', 'browser_update', 'browser_tab_close', 'browser_session_stop', 'browser_tab'];
  for (const name of destructive) assert.equal(byName.get(name).risk, 'destructive', name);
  const notIdempotent = ['browser_act', 'browser_click_backend', 'browser_plan', 'browser_recipe', 'browser_session_start'];
  for (const name of notIdempotent) assert.equal(byName.get(name).idempotent, false, name);
  assert.ok(byName.get('browser_act').sideEffects.includes('page'));
  assert.ok(byName.get('browser_screenshot').sideEffects.includes('filesystem'));
  assert.deepEqual(byName.get('browser_status').sideEffects, []);
});

test('docs 指向实际存在的技能参考（含插件补充参考）', () => {
  const referenceDir = path.join(PLUGIN, 'skill', 'references');
  for (const spec of specs) {
    for (const doc of spec.docs) {
      const target = path.join(PLUGIN, 'skill', doc);
      assert.ok(fs.existsSync(target), spec.name + ' 的参考不存在：' + doc);
      assert.ok(fs.readFileSync(target, 'utf8').length > 200, doc + ' 内容过短');
      assert.ok(doc.startsWith('references/') && target.startsWith(referenceDir));
    }
  }
  // 与工具语义直接相关的补充参考应被工具 docs 引用；其余（evaluation/offline-testing）
  // 由技能正文尾部的补充参考索引暴露（见 tests/unit/plugin-skill-extras.test.mjs）。
  const referenced = new Set(specs.flatMap((spec) => spec.docs));
  for (const extra of ['references/actions-guide.md', 'references/transactions.md']) {
    assert.ok(referenced.has(extra), '补充参考未被任何工具 docs 引用：' + extra);
  }
});

test('元数据校验会拒绝未知工具与非法字段', () => {
  assert.throws(() => applyToolMetadata({ name: 'browser_unknown' }), /未在 TOOL_METADATA 中登记/);
  assert.throws(() => applyToolMetadata({}), /需要带 name/);
});

test('TOOLS.md 生成物与当前 spec 一致', () => {
  const expected = renderToolsDoc(specs);
  const actual = fs.readFileSync(path.join(PLUGIN, 'TOOLS.md'), 'utf8');
  assert.equal(actual, expected, 'TOOLS.md 过期：node dsh-plugin/scripts/build-tools-doc.mjs');
  const check = buildToolsDoc({ check: true });
  assert.deepEqual(check.problems, []);
  assert.equal(check.changed, false);
  for (const spec of specs) assert.ok(actual.includes('`' + spec.name + '`'), 'TOOLS.md 缺少工具 ' + spec.name);
});

test('按分类分组保持声明顺序且覆盖全部工具', () => {
  const groups = groupByCategory(specs);
  assert.deepEqual([...groups.keys()], Object.keys(CATEGORIES));
  let total = 0;
  const flatNames = [];
  for (const [category, list] of groups) {
    assert.ok(list.length >= 1, '空分类：' + category);
    for (const spec of list) {
      assert.equal(spec.category, category);
      flatNames.push(spec.name);
    }
    total += list.length;
    // 同分类内保持 tools.mjs 里的工具顺序。
    const expectedInSpecs = specs.filter((spec) => spec.category === category).map((spec) => spec.name);
    assert.deepEqual(list.map((spec) => spec.name), expectedInSpecs);
  }
  assert.equal(total, 37);
  assert.deepEqual(flatNames.slice().sort(), specs.map((spec) => spec.name).sort());
});
