import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERLAY_PACKS } from '../../extension/src/overlay-locales.js';

const langs = ['zh', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'it', 'pt', 'zh-TW', 'ar', 'he'];

test('浮层语言包 12 语言 × 56 键，空白/省略号语义保留', () => {
  const base = OVERLAY_PACKS.en;
  const keys = Object.keys(base);
  assert.equal(keys.length, 56);
  for (const lang of langs) {
    const pack = OVERLAY_PACKS[lang];
    assert.ok(pack, lang + ' 缺浮层语言包');
    assert.deepEqual(Object.keys(pack), keys, lang + ' 键集不一致');
    for (const key of keys) {
      assert.equal(typeof pack[key], 'string', lang + ' 的 ' + key + ' 不是字符串');
      assert.ok(pack[key].trim().length > 0, lang + ' 的 ' + key + ' 为空');
    }
    for (const key of ['borrowTarget', 'toastTarget']) assert.ok(pack[key].endsWith(' ') || pack[key].endsWith('：'), lang + ' 的 ' + key + ' 缺分隔');
    for (const key of ['borrowAutoDeny', 'manualFrames']) {
      if (lang === 'ko') continue;
      assert.ok(/^\s|\s$/.test(pack[key]), lang + ' 的 ' + key + ' 缺边界空格');
    }
  }
  for (const lang of langs) assert.ok(OVERLAY_PACKS[lang].takeoverStopping.includes('…'), lang + ' 的 stopping 缺省略号');
});
