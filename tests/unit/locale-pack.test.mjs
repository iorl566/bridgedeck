import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALE_TEXT, SUPPORTED_LANGS } from '../../extension/ui/locales.js';

test('语言包包含 12 种语言，且每条都有非空翻译', () => {
  assert.deepEqual(SUPPORTED_LANGS, ['zh', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'it', 'pt', 'zh-TW', 'ar', 'he']);
  const entries = Object.entries(LOCALE_TEXT);
  assert.ok(entries.length >= 70, 'locale 词条太少：' + entries.length);
  for (const [source, row] of entries) {
    assert.equal(typeof row.en, 'string', source + ' 缺英文');
    if (source !== '可关闭。') assert.ok(row.en, source + ' 缺英文');
    for (const lang of ['ja', 'ko', 'de', 'es', 'fr', 'it', 'pt', 'zh-TW', 'ar', 'he']) {
      assert.equal(typeof row[lang], 'string', source + ' 缺 ' + lang);
      assert.ok(row[lang].length > 0, source + ' 的 ' + lang + ' 为空');
    }
  }
});
