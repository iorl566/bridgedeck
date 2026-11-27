// tests/unit/i18n-coverage-gate.test.mjs —— 12 语言覆盖门禁（UI/设置/浮层/错误提示/对话框）。
//
// 门禁口径：任一表面缺 key、空值、非拉丁语言只有英文，都算失败；负例测试用内存里
// 复制出来的坏数据证明门禁真的会失败（不是恒真断言）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALE_TEXT, SUPPORTED_LANGS } from '../../extension/ui/locales.js';
import { OVERLAY_PACKS } from '../../extension/src/overlay-locales.js';
import {
  ERROR_HINTS,
  ERROR_HINT_CODES,
  UNKNOWN_HINTS,
  HINT_LANGS,
  describeError,
  errorCodeOf,
  hintForCode,
  normalizeHintLang,
  unknownHint,
} from '../../extension/ui/error-hints.js';
import { DIALOG_TEXT, DIALOG_TEXT_KEYS } from '../../extension/ui/a11y-dialog.js';
import {
  LANGUAGES,
  NON_LATIN_LANGUAGES,
  SETTINGS_MESSAGE_KEYS,
  auditDictionary,
  auditDialogTexts,
  auditErrorHints,
  auditHtmlStrings,
  auditLocaleTable,
  auditOverlayPacks,
  auditSettingsMessages,
  buildCoverageReport,
  extractChineseStrings,
  formatCoverageReport,
  hasScript,
  isEnglishOnly,
  parseDictSource,
} from './i18n-audit-lib.mjs';
import { checkErrorHints, loadErrorHints, renderErrorHintsModule } from '../../translation/build-error-hints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const clone = (value) => structuredClone(value);

const dict = parseDictSource(read('extension/ui/i18n.js'));
const htmlStrings = new Set();
for (const file of fs.readdirSync(path.join(ROOT, 'extension', 'ui')).filter((name) => name.endsWith('.html'))) {
  for (const text of extractChineseStrings(read('extension/ui/' + file))) htmlStrings.add(text);
}

function fullReport() {
  return buildCoverageReport([
    auditLocaleTable(LOCALE_TEXT, 'ui', { allowEmptyEn: ['可关闭。'] }),
    auditDictionary(dict, LOCALE_TEXT, { allowEmptyEn: ['可关闭。'] }),
    auditHtmlStrings(htmlStrings, dict, LOCALE_TEXT),
    auditSettingsMessages(dict, LOCALE_TEXT),
    auditOverlayPacks(OVERLAY_PACKS, { languages: LANGUAGES }),
    auditErrorHints(ERROR_HINTS, UNKNOWN_HINTS, { knownCodes: ERROR_HINT_CODES }),
    auditDialogTexts(DIALOG_TEXT, DIALOG_TEXT_KEYS),
  ]);
}

test('12 语言覆盖门禁：UI/HTML/设置/浮层/错误提示/对话框全量通过', () => {
  const report = fullReport();
  assert.equal(report.ok, true, formatCoverageReport(report));
  assert.ok(report.checked > 3000, '门禁覆盖条数偏少：' + report.checked);
  const surfaces = report.surfaces.map((surface) => surface.surface).sort();
  assert.deepEqual(surfaces, ['dialog', 'errors', 'overlay', 'settings', 'ui', 'ui-dict', 'ui-html']);
});

test('门禁负例：UI 词条缺语言、空值、非拉丁语言只有英文都会失败', () => {
  const missing = clone(LOCALE_TEXT);
  delete missing['已连接'].ja;
  const missingReport = buildCoverageReport([auditLocaleTable(missing, 'ui')]);
  assert.equal(missingReport.ok, false);
  assert.ok(missingReport.failures.some((item) => item.lang === 'ja' && item.key === '已连接'), '缺 ja 没有被抓到');

  const empty = clone(LOCALE_TEXT);
  empty['已连接'].ar = '   ';
  const emptyReport = buildCoverageReport([auditLocaleTable(empty, 'ui')]);
  assert.equal(emptyReport.ok, false);
  assert.ok(emptyReport.failures.some((item) => item.lang === 'ar' && /空值/.test(item.reason)), '空值没有被抓到');

  const englishOnly = clone(LOCALE_TEXT);
  englishOnly['已连接'].he = 'Connected';
  const englishReport = buildCoverageReport([auditLocaleTable(englishOnly, 'ui')]);
  assert.equal(englishReport.ok, false);
  assert.ok(englishReport.failures.some((item) => item.lang === 'he' && /只有英文/.test(item.reason)), '英文冒充希伯来语没有被抓到');
});

test('门禁负例：DICT 有词条但 12 语言表缺失、英文漂移都会失败', () => {
  const missing = clone(LOCALE_TEXT);
  delete missing['当前任务'];
  const report = auditDictionary(dict, missing);
  assert.equal(report.ok, false);
  assert.ok(report.missingLocale.includes('当前任务'));

  const drifted = clone(LOCALE_TEXT);
  drifted['当前任务'].en = 'Totally different English';
  const driftReport = auditDictionary(dict, drifted);
  assert.equal(driftReport.ok, false);
  assert.ok(driftReport.drift.some((item) => item.key === '当前任务'), 'DICT/locale 英文漂移没有被抓到');
});

test('门禁负例：HTML 静态中文缺词条会失败', () => {
  const badHtml = new Set([...htmlStrings, '这个字符串只存在于测试里没有翻译']);
  const report = auditHtmlStrings(badHtml, dict, LOCALE_TEXT);
  assert.equal(report.ok, false);
  assert.ok(report.missingDict.includes('这个字符串只存在于测试里没有翻译'));
});

test('门禁负例：设置页动态提示缺 key 会失败', () => {
  const report = auditSettingsMessages(dict, LOCALE_TEXT, [...SETTINGS_MESSAGE_KEYS, '未登记的设置提示']);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((item) => item.surface === 'settings' && item.key === '未登记的设置提示'));
});

test('门禁负例：浮层语言包缺 key / 缺语言 / RTL 只有英文都会失败', () => {
  const missingKey = clone(OVERLAY_PACKS);
  delete missingKey.ja.borrowTitle;
  const keyReport = auditOverlayPacks(missingKey, { languages: LANGUAGES });
  assert.equal(keyReport.ok, false);
  assert.ok(keyReport.failures.some((item) => item.lang === 'ja' && item.key === 'borrowTitle'));

  const missingLang = clone(OVERLAY_PACKS);
  delete missingLang.ar;
  const langReport = auditOverlayPacks(missingLang, { languages: LANGUAGES });
  assert.equal(langReport.ok, false);
  assert.ok(langReport.failures.some((item) => item.lang === 'ar' && /缺少语言包/.test(item.reason)));

  const english = clone(OVERLAY_PACKS);
  english.he.borrowAllow = 'Allow';
  const englishReport = auditOverlayPacks(english, { languages: LANGUAGES });
  assert.equal(englishReport.ok, false);
  assert.ok(englishReport.failures.some((item) => item.lang === 'he' && /只有英文/.test(item.reason)));
});

test('错误码提示：36 个码 × 12 语言，非拉丁语言不是英文占位', () => {
  assert.ok(ERROR_HINT_CODES.length >= 30, '错误码提示覆盖太少：' + ERROR_HINT_CODES.length);
  for (const code of ERROR_HINT_CODES) {
    assert.match(code, /^E_[A-Z0-9_]+$/, '错误码格式不对：' + code);
    for (const lang of HINT_LANGS) {
      const value = ERROR_HINTS[code][lang];
      assert.equal(typeof value, 'string', code + ' 缺 ' + lang);
      assert.ok(value.trim().length > 3, code + '/' + lang + ' 文案太短');
      if (NON_LATIN_LANGUAGES.includes(lang)) {
        assert.ok(hasScript(lang, value), code + '/' + lang + ' 只有英文：' + value);
        assert.notEqual(value, ERROR_HINTS[code].en, code + '/' + lang + ' 与英文相同');
      }
    }
  }
});

test('错误码提示：关键用户可见错误码全部收录', () => {
  const required = [
    'E_TIMEOUT', 'E_BORROW_DENIED', 'E_BORROW_CONFLICT', 'E_BORROW_TIMEOUT', 'E_HELP_DISABLED',
    'E_NO_BROWSER', 'E_NO_SESSION', 'E_PAIR_INVALID', 'E_PAIR_REQUIRED', 'E_AUTH_FAILED',
    'E_FORBIDDEN', 'E_READ_ONLY', 'E_INPUT_BUSY', 'E_SESSION_PAUSED', 'E_TOO_LARGE',
    'E_DOWNLOAD_FAILED', 'E_NO_DOWNLOAD', 'E_STALE_REF', 'E_OBSERVATION_STALE', 'E_UNKNOWN_METHOD',
  ];
  const missing = required.filter((code) => !ERROR_HINT_CODES.includes(code));
  assert.deepEqual(missing, []);
});

test('错误码提示：门禁负例（缺语言/英文冒充/兜底缺失）会失败', () => {
  const hints = clone(ERROR_HINTS);
  delete hints.E_TIMEOUT.ko;
  const missing = auditErrorHints(hints, UNKNOWN_HINTS, { knownCodes: Object.keys(hints) });
  assert.equal(missing.ok, false);
  assert.ok(missing.failures.some((item) => item.key === 'E_TIMEOUT' && item.lang === 'ko'));

  const english = clone(ERROR_HINTS);
  english.E_FORBIDDEN.ar = 'Blocked by policy';
  const englishReport = auditErrorHints(english, UNKNOWN_HINTS, { knownCodes: Object.keys(english) });
  assert.equal(englishReport.ok, false);
  assert.ok(englishReport.failures.some((item) => item.key === 'E_FORBIDDEN' && item.lang === 'ar'));

  const noUnknown = auditErrorHints(ERROR_HINTS, null, { knownCodes: ERROR_HINT_CODES });
  assert.equal(noUnknown.ok, false);
  assert.ok(noUnknown.failures.some((item) => item.key === 'UNKNOWN'));
});

test('错误码提示：运行时查找/归一化/兜底真实可用', () => {
  assert.equal(normalizeHintLang('zh-tw'), 'zh-TW');
  assert.equal(normalizeHintLang('zh-Hant-TW'), 'zh-TW');
  assert.equal(normalizeHintLang('iw'), 'he');
  assert.equal(normalizeHintLang('de-DE'), 'de');
  assert.equal(normalizeHintLang('xx'), 'en');
  assert.equal(hintForCode('E_TIMEOUT', 'ja'), ERROR_HINTS.E_TIMEOUT.ja);
  assert.equal(hintForCode('e_timeout', 'zh'), ERROR_HINTS.E_TIMEOUT.zh);
  assert.equal(hintForCode('E_TOTALLY_UNKNOWN', 'zh-TW'), UNKNOWN_HINTS['zh-TW']);
  assert.equal(unknownHint('he'), UNKNOWN_HINTS.he);
  assert.equal(errorCodeOf({ code: 'e_bad_arg' }), 'E_BAD_ARG');
  assert.equal(errorCodeOf('daemon 返回 E_PAIR_REQUIRED，请配对'), 'E_PAIR_REQUIRED');
  assert.equal(errorCodeOf('no code here'), null);

  const described = describeError({ code: 'E_NO_BROWSER', message: 'no browser connected' }, 'de');
  assert.equal(described.code, 'E_NO_BROWSER');
  assert.equal(described.hint, ERROR_HINTS.E_NO_BROWSER.de);
  assert.match(described.text, /E_NO_BROWSER/);
  assert.match(described.text, /Browser verbunden|Browser/i);
  const noCode = describeError('普通失败信息', 'zh');
  assert.equal(noCode.text, '普通失败信息');
});

test('对话框文案：12 语言 × 全部 key（含破坏性操作确认）', () => {
  assert.ok(DIALOG_TEXT_KEYS.length >= 11);
  const report = auditDialogTexts(DIALOG_TEXT, DIALOG_TEXT_KEYS);
  assert.equal(report.ok, true, formatCoverageReport(buildCoverageReport([report])));
  for (const lang of LANGUAGES) {
    assert.ok(DIALOG_TEXT[lang], lang + ' 缺对话框文案');
    for (const key of DIALOG_TEXT_KEYS) assert.ok(DIALOG_TEXT[lang][key].trim(), lang + '/' + key + ' 为空');
  }
  // 负例：把 RTL 文案换成英文必须失败。
  const bad = clone(DIALOG_TEXT);
  bad.ar.revokeTitle = 'Revoke all paired devices?';
  const badReport = auditDialogTexts(bad, DIALOG_TEXT_KEYS);
  assert.equal(badReport.ok, false);
});

test('locales.js 与 SUPPORTED_LANGS 的 12 语言顺序一致且覆盖全部语言', () => {
  assert.deepEqual(SUPPORTED_LANGS, [...LANGUAGES]);
  const rows = Object.values(LOCALE_TEXT);
  const langs = new Set();
  for (const row of rows) for (const lang of Object.keys(row)) langs.add(lang);
  assert.deepEqual([...langs].sort(), LANGUAGES.filter((lang) => lang !== 'zh').sort());
  assert.ok(rows.length >= 240, '语言表词条数异常：' + rows.length);
});

test('生成物无漂移：extension/ui/error-hints.js 与 translation/error-hints.json 一致', () => {
  const result = checkErrorHints();
  assert.equal(result.ok, true, 'error-hints.js 与源不一致，请运行 node translation/build-error-hints.mjs --write');
  const source = loadErrorHints();
  assert.deepEqual(source.languages, HINT_LANGS);
  const rendered = renderErrorHintsModule(source);
  assert.equal(result.actual, rendered);
  assert.ok(rendered.includes('export const ERROR_HINTS'));
});

test('翻译源文件：新增 12 语言词条在 worklist 与语言文件中顺序一致', () => {
  const worklist = JSON.parse(read('translation/missing-worklist.json'));
  const keys = Object.keys(worklist);
  for (const key of SETTINGS_MESSAGE_KEYS) assert.ok(keys.includes(key), 'missing-worklist 缺设置提示：' + key);
  for (const key of ['本地分片', '扫描', '恢复最新', '尚未扫描', '没有本地分片', '没有可恢复的本地分片']) {
    assert.ok(keys.includes(key), 'missing-worklist 缺长截图分片词条：' + key);
  }
  for (const lang of LANGUAGES.filter((item) => item !== 'zh' && item !== 'en')) {
    const file = JSON.parse(read('translation/missing-' + lang + '.json'));
    assert.deepEqual(Object.keys(file), keys, 'missing-' + lang + '.json 键序与 missing-worklist 不一致');
    for (const key of keys) {
      assert.equal(typeof file[key], 'string', lang + '/' + key + ' 不是字符串');
      assert.ok(file[key].trim(), lang + '/' + key + ' 为空');
    }
  }
});

test('isEnglishOnly/hasScript 的判定不会把中文/日文/韩文/阿拉伯/希伯来误判成英文', () => {
  assert.equal(isEnglishOnly('ja', '接続済み'), false);
  assert.equal(isEnglishOnly('ko', '연결됨'), false);
  assert.equal(isEnglishOnly('ar', 'متصل'), false);
  assert.equal(isEnglishOnly('he', 'מחובר'), false);
  assert.equal(isEnglishOnly('zh-TW', '已連線'), false);
  assert.equal(isEnglishOnly('ja', 'Connected'), true);
  assert.equal(hasScript('ar', 'متصل'), true);
  assert.equal(hasScript('de', 'Verbunden'), true);
});
