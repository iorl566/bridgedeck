// tests/unit/overlay-locale-coverage.test.mjs —— 浮层语言包单一数据源与 12 语言覆盖。
//
// 校验 translation/overlay-*.json ↔ extension/src/overlay-locales.js ↔ overlay-texts.js
// 三层一致：键集、顺序、值逐字节相同；并保证 56 个语义串全部被 shape() 消费。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OVERLAY_PACKS } from '../../extension/src/overlay-locales.js';
import { overlayTexts } from '../../extension/src/overlay-texts.js';
import { LANGUAGES, NON_LATIN_LANGUAGES, auditOverlayPacks, isEnglishOnly } from './i18n-audit-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const json = (file) => JSON.parse(read(file));

const worklist = json('translation/overlay-worklist.json');
const langFiles = LANGUAGES.filter((lang) => lang !== 'zh' && lang !== 'en').map((lang) => ({
  lang,
  file: 'translation/overlay-' + lang + '.json',
  data: json('translation/overlay-' + lang + '.json'),
}));

test('浮层语言包 12 语言 × 56 键且非拉丁语言真实本地化', () => {
  assert.deepEqual(Object.keys(OVERLAY_PACKS), LANGUAGES);
  const report = auditOverlayPacks(OVERLAY_PACKS, { languages: LANGUAGES });
  assert.equal(report.ok, true, report.failures.map((failure) => failure.message).join('\n'));
  assert.equal(report.keys, 56);
  assert.equal(report.checked, 56 * LANGUAGES.length);
});

test('translation/overlay-worklist.json 是键序与中英文源（56 键，无空值）', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'translation/overlay-worklist.json')));
  assert.deepEqual(Object.keys(worklist), Object.keys(OVERLAY_PACKS.en), 'overlay-worklist 键序与 en 语言包不一致');
  assert.equal(Object.keys(worklist).length, 56);
  for (const [key, row] of Object.entries(worklist)) {
    assert.equal(typeof row.zh, 'string', key + ' 缺中文源');
    assert.equal(typeof row.en, 'string', key + ' 缺英文源');
    assert.ok(row.zh.trim(), key + ' 中文源为空');
    assert.ok(row.en.trim(), key + ' 英文源为空');
    assert.equal(row.en, OVERLAY_PACKS.en[key], key + ' worklist.en 与 en 语言包不一致');
    assert.equal(row.zh, OVERLAY_PACKS.zh[key], key + ' worklist.zh 与 zh 语言包不一致');
  }
});

test('translation/overlay-<lang>.json 与语言包逐键一致（10 个语言文件）', () => {
  assert.equal(langFiles.length, 10);
  for (const { lang, file, data } of langFiles) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), lang + ' 缺 overlay 翻译文件');
    assert.deepEqual(Object.keys(data), Object.keys(OVERLAY_PACKS[lang]), lang + ' 键序与语言包不一致');
    for (const key of Object.keys(data)) {
      assert.equal(typeof data[key], 'string', lang + '/' + key + ' 不是字符串');
      assert.equal(data[key], OVERLAY_PACKS[lang][key], lang + '/' + key + ' 与 overlay-locales.js 不一致');
    }
  }
});

test('负例：语言包与翻译文件漂移会被发现', () => {
  const pack = structuredClone(OVERLAY_PACKS);
  pack.ja.borrowTitle = '改坏的标题';
  const diffs = Object.keys(pack.ja).filter((key) => pack.ja[key] !== langFiles.find((item) => item.lang === 'ja').data[key]);
  assert.deepEqual(diffs, ['borrowTitle']);

  const missing = structuredClone(OVERLAY_PACKS);
  delete missing.de.toastAllow;
  const report = auditOverlayPacks(missing, { languages: LANGUAGES });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((failure) => failure.lang === 'de' && failure.key === 'toastAllow'));
});

test('overlay-texts.js shape 消费全部 56 个语义串（无静默丢弃的翻译）', () => {
  const expected = {
    borrow: ['title', 'body', 'target', 'deny', 'allow', 'autoDeny'],
    toast: ['title', 'target', 'allow', 'deny', 'close'],
    help: ['defaultTitle', 'defaultReason', 'collapse', 'placeholder', 'cancel', 'done', 'expand'],
    record: ['label', 'finish'],
    manual: ['label', 'frame', 'done', 'cancel', 'frames'],
  };
  const takeoverStates = ['ready', 'acting', 'syncing', 'held', 'human', 'editing', 'yielding', 'unavailable'];
  const takeoverSingles = ['borrowed', 'pause', 'resume', 'stop', 'confirmStop', 'stopConfirmSub', 'stopping', 'mini', 'project', 'session', 'badge', 'controlling', 'reading'];
  for (const lang of LANGUAGES) {
    const texts = overlayTexts(lang);
    for (const [group, keys] of Object.entries(expected)) {
      for (const key of keys) {
        assert.equal(typeof texts[group][key], 'string', lang + ' 的 ' + group + '.' + key + ' 不是字符串');
        assert.ok(texts[group][key].trim().length > 0, lang + ' 的 ' + group + '.' + key + ' 为空');
      }
    }
    for (const state of takeoverStates) {
      assert.ok(Array.isArray(texts.takeover[state]) && texts.takeover[state].length === 2, lang + ' 的 takeover.' + state + ' 不是二元组');
      for (const value of texts.takeover[state]) assert.ok(String(value).trim(), lang + ' 的 takeover.' + state + ' 有空值');
    }
    for (const key of takeoverSingles) {
      assert.equal(typeof texts.takeover[key], 'string', lang + ' 的 takeover.' + key + ' 缺失');
      assert.ok(texts.takeover[key].trim(), lang + ' 的 takeover.' + key + ' 为空');
    }
  }
  // 逐叶统计：56 个键 = 6+5+7+2+5 + (8×2 状态 + 13 单值)。
  let leaves = 0;
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    else leaves += 1;
  };
  walk(overlayTexts('en'));
  assert.equal(leaves, 56, 'overlay-texts shape 消费的叶子数不是 56：' + leaves);
});

test('浮层未知语言回退英文，ar/he 为 RTL 语言且文案不是英文占位', () => {
  assert.deepEqual(overlayTexts('xx-unknown'), overlayTexts('en'));
  for (const lang of ['ar', 'he']) {
    const pack = OVERLAY_PACKS[lang];
    for (const key of ['borrowTitle', 'borrowBody', 'toastTitle', 'takeoverReadyTitle', 'helpTitle']) {
      assert.equal(isEnglishOnly(lang, pack[key]), false, lang + '/' + key + ' 只有英文');
    }
  }
  for (const lang of NON_LATIN_LANGUAGES) {
    assert.ok(OVERLAY_PACKS[lang], lang + ' 缺浮层语言包');
  }
});

test('技术 token / 占位符在翻译中保留（不翻译 $1/URL/命令）', () => {
  const tokenPattern = /\$1|\{\w+\}|wss?:\/\/|bridge\s+[a-z.]+|fulfill|block|modify/g;
  for (const { lang, data } of langFiles) {
    for (const [key, value] of Object.entries(data)) {
      const source = worklist[key];
      const sourceTokens = (String(source.en).match(tokenPattern) || []).sort();
      const targetTokens = (String(value).match(tokenPattern) || []).sort();
      assert.deepEqual(targetTokens, sourceTokens, lang + '/' + key + ' 技术 token 不一致：' + JSON.stringify(value));
    }
  }
});
