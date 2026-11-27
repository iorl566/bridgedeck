// tests/unit/ui-labels.test.mjs —— 新 UI 文案目录（extension/ui/lib/labels.js）门禁。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LABEL_LANGS,
  formatLabel,
  hasLabel,
  interpolate,
  labelCoverage,
  labelKeys,
  labelTemplate,
  labeler,
  normalizeLabelLang,
  placeholderMismatch,
} from '../../extension/ui/lib/labels.js';

test('语言归一化：中文（简/繁）走 zh，其余回退 en', () => {
  assert.equal(normalizeLabelLang(''), 'zh');
  assert.equal(normalizeLabelLang('zh'), 'zh');
  assert.equal(normalizeLabelLang('zh-TW'), 'zh');
  assert.equal(normalizeLabelLang('zh-HK'), 'zh');
  assert.equal(normalizeLabelLang('en'), 'en');
  assert.equal(normalizeLabelLang('en-US'), 'en');
  assert.equal(normalizeLabelLang('ja'), 'en', '未翻译语言回退英文');
  assert.equal(normalizeLabelLang('xx'), 'en');
  assert.deepEqual([...LABEL_LANGS], ['zh', 'en']);
});

test('目录完整：每个 key 中英双语齐全，占位符集合一致', () => {
  const keys = labelKeys();
  assert.ok(keys.length >= 80, '文案 key 太少：' + keys.length);
  const coverage = labelCoverage();
  assert.deepEqual(coverage.missingEn, [], 'zh 有而 en 缺的 key：' + coverage.missingEn.join(', '));
  assert.deepEqual(coverage.missingZh, [], 'en 有而 zh 缺的 key：' + coverage.missingZh.join(', '));
  assert.deepEqual(placeholderMismatch(), [], '占位符不一致：' + JSON.stringify(placeholderMismatch()));
  for (const key of keys) {
    assert.equal(typeof labelTemplate(key, 'zh'), 'string', key + ' 缺 zh');
    assert.equal(typeof labelTemplate(key, 'en'), 'string', key + ' 缺 en');
    assert.ok(labelTemplate(key, 'zh').trim(), key + ' zh 为空');
    assert.ok(labelTemplate(key, 'en').trim(), key + ' en 为空');
    assert.equal(hasLabel(key), true);
  }
  assert.equal(hasLabel('no.such.key'), false);
});

test('插值：占位符替换、缺参数保留、空值回退 key', () => {
  assert.equal(interpolate('{a} + {b}', { a: 'A', b: 'B' }), 'A + B');
  assert.equal(interpolate('{a} / {missing}', { a: 'A' }), 'A / {missing}', '缺参数时保留占位符便于排查');
  assert.equal(interpolate('{count} items', { count: 0 }), '0 items', '0 必须被当成有效值');
  assert.equal(interpolate('no placeholders', { a: 1 }), 'no placeholders');
  assert.equal(interpolate('', {}), '');
  assert.equal(interpolate(null, null), '');

  assert.equal(formatLabel('paging.page', { page: 2, pages: 5 }, 'zh'), '第 2 / 5 页');
  assert.equal(formatLabel('paging.page', { page: 2, pages: 5 }, 'en'), 'Page 2 of 5');
  assert.equal(formatLabel('paging.page', {}, 'zh'), '第 {page} / {pages} 页');
  assert.equal(formatLabel('list.selected', { count: 3 }, 'en'), '3 selected');
  assert.equal(formatLabel('no.such.key', {}, 'zh'), 'no.such.key', '未知 key 原样返回，页面能立刻发现');
  // 未翻译语言回退英文
  assert.equal(formatLabel('state.loading', {}, 'ja'), 'Loading…');
});

test('labeler 绑定语言，行为与 formatLabel 一致', () => {
  const zh = labeler('zh');
  const en = labeler('en');
  assert.equal(zh('compare.identical'), '两条记录没有差异');
  assert.equal(en('compare.identical'), 'The two records are identical');
  assert.equal(zh('compare.summary', { added: 1, removed: 2, changed: 3 }), '1 新增 / 2 移除 / 3 变化');
  const direct = labeler();
  assert.equal(direct('state.retry'), formatLabel('state.retry', {}, 'zh'));
});

test('关键页面能力的文案 key 都存在（防重命名后页面静默显示 key）', () => {
  const required = [
    'state.loading', 'state.error', 'state.empty', 'state.retry',
    'paging.previous', 'paging.next', 'paging.page', 'paging.range', 'paging.summary',
    'list.filter', 'list.filterNone', 'list.sortTime', 'list.keyboardHint',
    'timeline.title', 'timeline.bar', 'timeline.overview',
    'compare.title', 'compare.added', 'compare.removed', 'compare.changed', 'compare.needTwo',
    'diff.empty', 'a11y.list', 'a11y.sortable',
  ];
  for (const key of required) assert.equal(hasLabel(key), true, '缺文案 key：' + key);
  // 中文页面文案不能是英文占位（除了纯技术词），保证读起来是中文
  for (const key of required) {
    const zh = labelTemplate(key, 'zh');
    const words = zh.replace(/\{[a-zA-Z0-9_]+\}/g, '');
    if (/[A-Za-z]{4,}/.test(words) && !/HTTP|URL|JSON|API|RGB|ID|Enter|Esc|Tab|Space|Shift|Ctrl|Alt/.test(words)) {
      assert.fail(key + ' 的中文文案仍含英文单词：' + zh);
    }
  }
});
