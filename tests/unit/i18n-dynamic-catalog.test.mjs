// tests/unit/i18n-dynamic-catalog.test.mjs —— 动态文案 catalog（拼接句子 12 语言）门禁。
//
// 覆盖五件事：
//   1. 数据源结构：150+ 条 × 12 语言、非拉丁语言真实本地化、占位符集合一致；
//   2. 生成物漂移：extension/src/overlay-dynamic-locales.js 必须与源逐字节一致；
//   3. 缺 key 门禁：声明表面里仍拼接的中文片段必须能对上模板（反向校验锚点，防止造词条）；
//   4. 负例：删词条 / 删语言 / 只写英文 / 新加拼接片段 都会让门禁失败（不是恒真断言）；
//   5. 统一查表入口：overlay-texts.js 的 overlayA11yTexts / overlayErrorText 与
//      overlay-locales、error-hints 共用同一套语言归一化与回退。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_LANGUAGES,
  GENERATED_PATH,
  auditDynamicCoverage,
  checkDynamicTexts,
  extractDynamicFragments,
  formatDynamic,
  loadDynamicTexts,
  placeholdersOf,
  renderDynamicFiles,
  renderDynamicModule,
  scanStringLiterals,
  shardPath,
  validateDynamicSource,
} from '../../translation/build-dynamic-texts.mjs';
import {
  DYNAMIC_KEYS,
  DYNAMIC_LANGS,
  DYNAMIC_TEXT,
  dynamicText,
  hasDynamicText,
  hasLocalizedDynamicText,
  missingDynamicKeys,
  normalizeDynamicLang,
} from '../../extension/src/overlay-dynamic-locales.js';
import {
  A11Y_TEXT_KEYS,
  overlayA11yTexts,
  overlayDynamicText,
  overlayErrorText,
  overlayLang,
  overlayTexts,
  overlayUnknownErrorText,
} from '../../extension/src/overlay-texts.js';
import { hintForCode } from '../../extension/ui/error-hints.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

const source = await loadDynamicTexts();
const keys = Object.keys(source.entries);
const NON_LATIN = ['ja', 'ko', 'zh-TW', 'ar', 'he'];
const SCRIPTS = {
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  'zh-TW': /[\u4e00-\u9fa5]/,
  ar: /[\u0600-\u06ff]/,
  he: /[\u0590-\u05ff]/,
};

test('动态文案：150+ 条 × 12 语言，非拉丁语言真实本地化且占位符一致', () => {
  assert.deepEqual(source.languages, [...CATALOG_LANGUAGES]);
  assert.ok(keys.length >= 143, '词条数量不足（目标约 143，实际 ' + keys.length + '）');
  const report = validateDynamicSource(source, { languages: source.languages });
  assert.equal(report.ok, true, report.failures.slice(0, 10).map((item) => item.message).join('\n'));

  for (const key of keys) {
    const row = source.entries[key];
    const expected = placeholdersOf(row.zh);
    for (const lang of NON_LATIN) {
      assert.match(row[lang], SCRIPTS[lang], key + '/' + lang + ' 没有本语言文字：' + JSON.stringify(row[lang]));
    }
    for (const lang of source.languages) {
      assert.deepEqual(placeholdersOf(row[lang]), expected, key + '/' + lang + ' 占位符与中文源不一致');
    }
    assert.notEqual(row.en, row.zh, key + ' 英文与中文完全相同（漏翻译）');
  }
  // 词条来源都必须声明（动态播报类可以 grounding:false，但同样要有来源模块）
  for (const key of keys) {
    assert.ok(Array.isArray(source.entries[key].source) && source.entries[key].source.length, key + ' 缺来源声明');
  }
});

test('生成物与数据源逐字节一致（手改生成物会被发现）', async () => {
  const drift = await checkDynamicTexts();
  assert.equal(drift.ok, true, 'extension/src/overlay-dynamic-locales.js 与源不一致，请运行 node translation/build-dynamic-texts.mjs --write');
  assert.equal(DYNAMIC_LANGS.length, 12);
  assert.deepEqual(DYNAMIC_KEYS, keys);
  assert.equal(Object.keys(DYNAMIC_TEXT).length, keys.length);
  for (const key of keys) {
    for (const lang of DYNAMIC_LANGS) assert.equal(DYNAMIC_TEXT[key][lang], source.entries[key][lang], key + '/' + lang + ' 生成值与源不一致');
  }
});

test('缺 key 门禁：声明表面里的拼接中文片段全部能对上模板', () => {
  const coverage = auditDynamicCoverage({ source, readFile: (file) => read(file) });
  assert.equal(coverage.ok, true, coverage.failures.slice(0, 10).map((item) => item.message).join('\n'));
  assert.ok(coverage.checked >= 100, '扫描到的拼接片段数量异常：' + coverage.checked);
  assert.equal(coverage.keys, keys.length);
});

test('负例 A：删掉一个词条 / 一种语言 / 只写英文，门禁都会失败', () => {
  const withoutKey = clone(source);
  const removed = withoutKey.entries['longshot.stitch.done'];
  assert.ok(removed, '前置条件：应有 longshot.stitch.done 词条');
  delete withoutKey.entries['longshot.stitch.done'];
  const coverage = auditDynamicCoverage({ source: withoutKey, readFile: (file) => read(file) });
  assert.equal(coverage.ok, false);
  assert.ok(coverage.failures.some((item) => /拼接中文片段没有 catalog 词条/.test(item.reason)), '删词条后缺 key 门禁没有报错');

  const withoutLang = clone(source);
  delete withoutLang.entries['audit.summary'].ja;
  const validation = validateDynamicSource(withoutLang, { languages: withoutLang.languages });
  assert.equal(validation.ok, false);
  assert.ok(validation.failures.some((item) => item.key === 'audit.summary' && item.lang === 'ja'), '删语言后结构校验没有报错');

  const englishOnly = clone(source);
  englishOnly.entries['longshot.saved'].ja = englishOnly.entries['longshot.saved'].en;
  const report = validateDynamicSource(englishOnly, { languages: englishOnly.languages });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((item) => item.key === 'longshot.saved' && item.lang === 'ja' && /没有本语言文字/.test(item.reason)), '只写英文时应报未本地化');

  const badPlaceholder = clone(source);
  badPlaceholder.entries['longshot.frame.count'].de = '{count} Bilder';
  const placeholderReport = validateDynamicSource(badPlaceholder, { languages: badPlaceholder.languages });
  assert.equal(placeholderReport.ok, true, '占位符相同不应失败');
  badPlaceholder.entries['longshot.frame.count'].de = 'Bilder';
  assert.equal(validateDynamicSource(badPlaceholder, { languages: badPlaceholder.languages }).ok, false, '缺占位符时应失败');
});

test('负例 B：新增拼接中文片段但没进 catalog → 门禁失败；死豁免也会失败', () => {
  const files = {
    'extension/ui/record.js': read('extension/ui/record.js') + "\nnote('新增的' + count + ' 条提示');\n",
  };
  const coverage = auditDynamicCoverage({
    source: { ...source, surfaces: ['extension/ui/record.js'] },
    readFile: (file) => files[file] ?? read(file),
  });
  assert.equal(coverage.ok, false);
  assert.ok(coverage.failures.some((item) => /"新增的"/.test(item.message)), '新增片段没有被拦下：' + coverage.failures.map((item) => item.message).join('；'));

  const withExemption = {
    ...source,
    surfaces: ['extension/ui/record.js'],
    exemptions: { 'extension/ui/record.js': [{ fragment: '已经不存在的片段', reason: '负例' }] },
  };
  const dead = auditDynamicCoverage({ source: withExemption, readFile: (file) => files[file] ?? read(file) });
  assert.equal(dead.ok, false);
  assert.ok(dead.failures.some((item) => /豁免片段已不在源码里/.test(item.reason)), '死豁免没有被发现');
});

test('扫描器：注释/字符串/模板/正则都不会把代码误判成文案', () => {
  const snippet = [
    '// log(\'注释里的中文\' + x);',
    '/* 块注释 \'中文\' */',
    "const a = '前缀' + value + '后缀';",
    "log('诊断日志' + value);",
    "console.warn('另一条日志' + value);",
    "const re = /^[\\u4e00-\\u9fa5]$/;",
    'const t = `第 ${n} 帧`;',
    "const s = '静态中文没有拼接';",
  ].join('\n');
  const fragments = extractDynamicFragments(snippet);
  assert.ok(fragments.includes('前缀'), '未识别拼接片段：' + JSON.stringify(fragments));
  assert.ok(fragments.includes('后缀'));
  assert.ok(!fragments.includes('诊断日志'), '诊断日志不应进用户文案清单：' + JSON.stringify(fragments));
  assert.ok(!fragments.includes('另一条日志'));
  assert.ok(!fragments.includes('注释里的中文'));
  assert.ok(!fragments.includes('静态中文没有拼接'));
  assert.ok(fragments.some((fragment) => /帧/.test(fragment)), '模板字符串没有被识别');

  // 字面量扫描返回调用栈上下文，便于诊断类调用被排除
  const literals = scanStringLiterals("log('日志' + x)");
  assert.equal(literals.length, 1);
  assert.equal(literals[0].callees[0], 'log');
});

test('查表入口：归一化/回退/渲染/缺词条，12 语言都可用', () => {
  assert.equal(dynamicText('zh', 'longshot.frame.count', { count: 3 }), '3 帧');
  assert.equal(dynamicText('en', 'longshot.frame.count', { count: 3 }), '3 frames');
  assert.equal(dynamicText('ar', 'longshot.frame.count', { count: 3 }).includes('3'), true);
  assert.equal(dynamicText('zh-Hant', 'longshot.saved', { name: 'a.png' }), source.entries['longshot.saved']['zh-TW'].replace('{name}', 'a.png'));
  assert.equal(dynamicText('he', 'no.such.key'), '', '未知词条应返回空串');
  assert.equal(dynamicText('xx', 'longshot.saved', { name: 'a.png' }), source.entries['longshot.saved'].en.replace('{name}', 'a.png'), '未知语言应回退英文');
  assert.equal(formatDynamic('{a} + {0} + {missing}', { a: 'A', 0: 'B' }), 'A + B + {missing}');
  assert.equal(hasDynamicText('longshot.saved'), true);
  assert.equal(hasDynamicText('nope'), false);
  assert.equal(normalizeDynamicLang('iw'), 'he');
  assert.equal(normalizeDynamicLang('zh-HK'), 'zh-TW');
  assert.equal(normalizeDynamicLang(''), 'en');

  for (const lang of DYNAMIC_LANGS) {
    assert.deepEqual(missingDynamicKeys(keys, lang), [], lang + ' 缺少词条');
    for (const key of keys) assert.equal(hasLocalizedDynamicText(key, lang), true, lang + '/' + key + ' 没有本地化文案');
  }
  assert.deepEqual(missingDynamicKeys(['no.such.key'], 'en'), ['no.such.key']);
});

test('统一入口：overlayA11yTexts 12 语言、覆盖全部浮层播报键', () => {
  for (const lang of DYNAMIC_LANGS) {
    const a11y = overlayA11yTexts(lang);
    assert.deepEqual(Object.keys(a11y), Object.keys(A11Y_TEXT_KEYS));
    for (const [surface, fields] of Object.entries(A11Y_TEXT_KEYS)) {
      for (const [field, key] of Object.entries(fields)) {
        assert.equal(typeof a11y[surface][field], 'string', lang + '/' + surface + '.' + field + ' 不是字符串');
        assert.ok(a11y[surface][field].trim(), lang + '/' + surface + '.' + field + ' 为空');
        assert.equal(a11y[surface][field], dynamicText(overlayLang(lang), key), lang + '/' + surface + '.' + field + ' 没走同一查表入口');
      }
    }
  }
  // 未登记语言回退英文，而不是空串
  const fallback = overlayA11yTexts('xx-unknown');
  assert.equal(fallback.takeover.label, source.entries['overlay.takeover.label'].en);
  assert.equal(overlayDynamicText('zh', 'overlay.record.escHint'), source.entries['overlay.record.escHint'].zh);
});

test('统一入口：overlayTexts 仍是 54 语义串，overlayErrorText 与 error-hints 同源', () => {
  const zh = overlayTexts('zh');
  assert.equal(zh.borrow.title, '允许借用标签页？');
  assert.equal(zh.record.finish, '结束');
  assert.equal(overlayTexts('xx-unknown').borrow.title, overlayTexts('en').borrow.title);
  assert.equal(overlayLang('zh-Hant'), 'zh-TW');
  assert.equal(overlayLang('iw'), 'he');
  // 三类文案共用一个语言归一化入口：错误码提示与 error-hints 的 hintForCode 完全一致。
  for (const lang of DYNAMIC_LANGS) {
    assert.equal(overlayErrorText('E_TIMEOUT', lang), hintForCode('E_TIMEOUT', overlayLang(lang)));
    assert.equal(overlayErrorText('E_NOT_A_REAL_CODE', lang), hintForCode('E_NOT_A_REAL_CODE', overlayLang(lang)));
    assert.ok(overlayUnknownErrorText(lang).trim(), lang + ' 缺未知错误兜底');
  }
});

test('渲染器：缺语言时直接抛错；生成物按分片存放且每个文件都在 1100 行预算内', () => {
  const broken = clone(source);
  delete broken.entries['preview.updated'].ar;
  assert.throws(() => renderDynamicFiles(broken), /缺语言 ar/);

  const files = renderDynamicFiles(source);
  assert.ok(files.size >= 4, '生成物应为主模块 + 多个数据分片：' + files.size);
  const main = files.get(GENERATED_PATH);
  assert.match(main, /export const DYNAMIC_TEXT = \{/);
  assert.match(main, /export function dynamicText\(lang, key, params\)/);
  assert.match(main, /from '\.\/overlay-dynamic-locales-1\.js'/);
  assert.ok(!/\bbsk\b/i.test(main), '生成物不得出现参考实现标识');
  for (const [file, text] of files) {
    const lines = text.split('\n').length;
    assert.ok(lines <= 1100, path.relative(ROOT, file) + ' 超过 src 文件复杂度预算（1100 行）：' + lines);
    assert.ok(!/\bbsk\b/i.test(text), path.relative(ROOT, file) + ' 生成物出现参考实现标识');
  }
  assert.equal(files.has(shardPath(0)), true);
  assert.equal(renderDynamicModule(source, 1).includes('DYNAMIC_TEXT_SHARD_2'), false);
});
