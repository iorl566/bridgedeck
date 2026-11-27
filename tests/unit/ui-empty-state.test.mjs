// tests/unit/ui-empty-state.test.mjs —— 空态深度模型（extension/ui/lib/empty-state.js）单测。
//
// 重点：七种空态原因要能区分（尤其“过滤后为空”不能显示“首次进入”），
// 文案带总数、动作按原因给出、聚合优先级与表格模型映射正确。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_REASONS,
  aggregateEmptyReasons,
  buildEmptyState,
  distinguishEmpty,
  emptyActionsFor,
  emptyCounterText,
  emptyInputFromTable,
  emptyStateCatalog,
  iconFor,
  resolveEmptyReason,
  shouldSuggestClearFilters,
} from '../../extension/ui/lib/empty-state.js';

test('原因判定：错误/权限/过大/待选/过滤空/首次进入/不支持', () => {
  assert.equal(resolveEmptyReason({ error: { code: 'E_TIMEOUT' } }), 'error');
  assert.equal(resolveEmptyReason({ permission: true }), 'permission');
  assert.equal(resolveEmptyReason({ tooLarge: true }), 'too-large');
  assert.equal(resolveEmptyReason({ selectionPending: true, selectionCount: 0 }), 'needs-selection');
  assert.equal(resolveEmptyReason({ selectionPending: true, selectionCount: 2 }), 'first-run');
  assert.equal(resolveEmptyReason({ total: 10, matched: 0 }), 'no-match');
  assert.equal(resolveEmptyReason({ total: 0, matched: 0, query: 'x' }), 'no-match');
  assert.equal(resolveEmptyReason({ total: 0, matched: 0 }), 'first-run');
  assert.equal(resolveEmptyReason({ unsupported: true }), 'unsupported');
  // 优先级：error 最高。
  assert.equal(resolveEmptyReason({ error: 'x', permission: true, total: 5, matched: 0 }), 'error');
  assert.deepEqual([...EMPTY_REASONS], ['error', 'permission', 'too-large', 'needs-selection', 'no-match', 'first-run', 'unsupported']);
});

test('区分“没有数据”与“被过滤掉”：总数与匹配数', () => {
  assert.deepEqual(distinguishEmpty({ total: 0 }), { kind: 'no-data', filtered: false, total: 0, matched: 0 });
  assert.deepEqual(distinguishEmpty({ total: 10, matched: 0, query: 'x' }), { kind: 'no-match', filtered: true, total: 10, matched: 0 });
  assert.deepEqual(distinguishEmpty({ total: 10, matched: 3, query: 'x' }), { kind: 'has-data', filtered: false, total: 10, matched: 3 });
  assert.equal(distinguishEmpty({}).kind, 'no-data');
});

test('空态模型：no-match 明确说“不是没数据”，并带总数脚注', () => {
  const model = buildEmptyState({ surface: 'workspace', total: 12, matched: 0, query: 'status:>=500' });
  assert.equal(model.reason, 'no-match');
  assert.equal(model.tone, 'muted');
  assert.equal(model.filtered, true);
  assert.match(model.body, /12/);
  assert.match(model.footnote, /12/);
  assert.match(model.announcement, /没有匹配/);
  assert.equal(model.role, 'status');
  assert.equal(model.live, 'polite');
  assert.equal(model.icon, 'search');
  assert.deepEqual(model.actions.map((action) => action.key), ['clear-filter', 'reduce']);
  assert.equal(model.actions[0].primary, true);
  assert.equal(model.query, 'status:>=500');
});

test('空态模型：error 用 assertive + 重试；权限去设置；过大提示拆分', () => {
  const error = buildEmptyState({ surface: 'audit', error: { code: 'E_TIMEOUT' } });
  assert.equal(error.reason, 'error');
  assert.equal(error.role, 'alert');
  assert.equal(error.live, 'assertive');
  assert.equal(error.actions[0].key, 'retry');
  assert.equal(error.icon, 'alert');

  const permission = buildEmptyState({ surface: 'audit', permission: true });
  assert.equal(permission.actions[0].key, 'settings');
  assert.equal(permission.tone, 'warn');

  const tooLarge = buildEmptyState({ surface: 'workspace', tooLarge: true, limit: 50000 });
  assert.match(tooLarge.body, /50000/);
  assert.equal(tooLarge.actions[0].key, 'import');
});

test('空态模型：首次进入按表面给入口', () => {
  assert.equal(buildEmptyState({ surface: 'workspace' }).actions[0].key, 'import');
  assert.equal(buildEmptyState({ surface: 'record' }).actions[0].key, 'load');
  assert.equal(buildEmptyState({ surface: 'unknown-surface' }).actions[0].key, 'refresh');
  assert.equal(buildEmptyState({}).reason, 'first-run');
  // detail 覆盖正文（页面拿到后端错误文案时用）。
  const withDetail = buildEmptyState({ surface: 'workspace', reason: 'error', detail: 'E_NO_BROWSER 没有浏览器' });
  assert.equal(withDetail.body, 'E_NO_BROWSER 没有浏览器');
});

test('动作目录：每个原因都有至少一个动作，primary 唯一', () => {
  for (const reason of EMPTY_REASONS) {
    const actions = emptyActionsFor('workspace', reason, { lang: 'zh' });
    assert.ok(actions.length >= 1, reason + ' 没有动作');
    assert.equal(actions.filter((action) => action.primary).length <= 1, true);
    for (const action of actions) assert.ok(action.label.trim().length > 0);
  }
  const en = emptyActionsFor('workspace', 'no-match', { lang: 'en' });
  assert.equal(en[0].label, 'Clear filters');
});

test('图标/清除过滤建议/聚合优先级/计数器/目录', () => {
  assert.equal(iconFor('permission'), 'lock');
  assert.equal(iconFor('too-large'), 'scale');
  assert.equal(iconFor('needs-selection'), 'cursor');
  assert.equal(iconFor('first-run'), 'inbox');
  assert.equal(iconFor('weird'), 'inbox');
  assert.equal(shouldSuggestClearFilters('no-match'), true);
  assert.equal(shouldSuggestClearFilters('first-run'), false);
  assert.equal(aggregateEmptyReasons(['no-match', 'error', 'first-run']), 'error');
  assert.equal(aggregateEmptyReasons(['no-match', 'permission']), 'permission');
  assert.equal(aggregateEmptyReasons(['no-match', 'first-run']), 'no-match');
  assert.equal(aggregateEmptyReasons([]), 'first-run');
  assert.equal(aggregateEmptyReasons(['bogus']), 'first-run');
  assert.equal(emptyCounterText({ matched: 2, total: 9 }, 'zh'), '2 / 9 行');
  assert.equal(emptyCounterText({}, 'en'), '0 / 0 rows');

  const catalog = emptyStateCatalog();
  assert.deepEqual(Object.keys(catalog).sort(), [...EMPTY_REASONS].sort());
  for (const reason of EMPTY_REASONS) {
    assert.ok(catalog[reason].title.startsWith('empty.'));
    assert.ok(catalog[reason].tone);
  }
});

test('table model 映射：total/filtered/query 对应空态输入', () => {
  const input = emptyInputFromTable({ total: 20, filtered: 0, query: 'x' });
  assert.deepEqual(input, { total: 20, matched: 0, query: 'x' });
  const withExtra = emptyInputFromTable({ total: 1, filtered: 1 }, { selectionPending: true });
  assert.equal(withExtra.selectionPending, true);
  assert.equal(emptyInputFromTable(null).total, 0);
});
