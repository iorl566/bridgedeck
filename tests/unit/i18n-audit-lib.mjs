// ui/i18n-audit.js —— 12 语言覆盖门禁（纯函数，测试/CI 复用）。
//
// 覆盖四条“表面”（surface），任一表面缺 key/空值/RTL 语言只有英文都算失败：
//   ui       extension/ui/locales.js + i18n.js DICT（静态 UI 文案）
//   settings extension/ui/options.js 的动态提示文案（已保存/已恢复默认…）
//   overlay  extension/src/overlay-locales.js（浮层 12×56）
//   errors   extension/ui/error-hints.js（错误码提示 12 语言）
//   dialog   extension/ui/a11y-dialog.js DIALOG_TEXT（确认对话框）
//
// 门禁本身不读文件：测试把解析好的对象/文本传进来，便于负例直接构造“缺一条”的
// 数据证明门禁会失败。

/** 产品支持的 12 种语言（顺序与 locales.js 生成物一致）。 */
export const LANGUAGES = Object.freeze(['zh', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'it', 'pt', 'zh-TW', 'ar', 'he']);

/** 非拉丁文字语言：这些语言的“本地化”必须真的含有本语言字符，不能只是英文。 */
export const NON_LATIN_LANGUAGES = Object.freeze(['ja', 'ko', 'zh-TW', 'ar', 'he']);

/** 设置页动态提示（options.js 的 toast 文案必须走 translate()）。 */
export const SETTINGS_MESSAGE_KEYS = Object.freeze(['已保存', '已恢复默认', '已复制：', '复制失败，请手动复制：']);

const SCRIPT_PATTERNS = {
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  'zh-TW': /[\u4e00-\u9fff]/,
  ar: /[\u0600-\u06ff]/,
  he: /[\u0590-\u05ff]/,
};

/** 文本是否包含指定语言的文字（用于判断“是否只有英文”）。 */
export function hasScript(lang, text) {
  const pattern = SCRIPT_PATTERNS[lang];
  if (!pattern) return true;
  return pattern.test(String(text || ''));
}

/** 给本地化语言时，文本是否只有拉丁字母/数字（说明没翻译）。 */
export function isEnglishOnly(lang, text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (hasScript(lang, value)) return false;
  if (!SCRIPT_PATTERNS[lang]) return false;
  return true;
}

/** 从 i18n.js 源码里提取 DICT 对象（真实解析，不是正则凑 key）。 */
export function parseDictSource(sourceText) {
  const text = String(sourceText || '');
  const start = text.indexOf('const DICT = {');
  if (start < 0) throw new Error('i18n.js 里找不到 const DICT = {');
  const end = text.indexOf('\n};\nconst PATTERNS', start);
  if (end < 0) throw new Error('i18n.js 的 DICT 缺少结束标记');
  const literal = text.slice(start + 'const DICT = '.length, end + 2);
  return new Function('return (' + literal + ')')();
}

/** 从 HTML 文本里抽取所有静态中文（文本节点 + title/placeholder/aria-label）。 */
export function extractChineseStrings(htmlText) {
  const strings = new Set();
  for (const match of String(htmlText || '').matchAll(/>([^<>]*[\u4e00-\u9fa5][^<>]*)</g)) {
    strings.add(match[1].trim());
  }
  for (const match of String(htmlText || '').matchAll(/(?:title|placeholder|aria-label)="([^"]*[\u4e00-\u9fa5][^"]*)"/g)) {
    strings.add(match[1].trim());
  }
  return strings;
}

/** 取集合差（expected 有而 actual 没有）。 */
export function diffKeys(expected, actual) {
  const actualSet = actual instanceof Set ? actual : new Set(actual);
  return [...expected].filter((key) => !actualSet.has(key));
}

/** 检查语言列表是否完整（多/少都失败）。 */
export function auditLanguages(available, expected = LANGUAGES) {
  const set = new Set(available || []);
  const missing = expected.filter((lang) => !set.has(lang));
  const extra = [...set].filter((lang) => !expected.includes(lang));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

function failure(surface, lang, key, reason) {
  return { surface, lang, key, reason, message: '[' + surface + '] ' + lang + ' 缺 ' + key + '：' + reason };
}

/**
 * 通用词条表审计：每个 key 在每种语言都必须是非空字符串。
 * 中文是源语言（key 本身），表里没有 zh 列；因此 sourceLang 默认不计入语言列。
 * @param {Record<string, Record<string,string>>} table
 */
export function auditLocaleTable(table, surface, { languages = LANGUAGES, sourceLang = 'zh', allowEmptyEn = [] } = {}) {
  const failures = [];
  let checked = 0;
  const keys = Object.keys(table || {});
  const targetLangs = languages.filter((lang) => lang !== sourceLang);
  const available = new Set();
  for (const row of Object.values(table || {})) {
    if (row && typeof row === 'object') for (const lang of Object.keys(row)) available.add(lang);
  }
  const langReport = auditLanguages([...available], targetLangs);
  if (!langReport.ok) {
    for (const lang of langReport.missing) failures.push(failure(surface, lang, '(all)', '语言列缺失'));
    for (const lang of langReport.extra) failures.push(failure(surface, lang, '(all)', '出现未登记语言'));
  }
  for (const key of keys) {
    const row = table[key];
    if (!row || typeof row !== 'object') {
      failures.push(failure(surface, '(any)', key, '词条不是对象'));
      continue;
    }
    for (const lang of targetLangs) {
      const value = row[lang];
      if (typeof value !== 'string') {
        failures.push(failure(surface, lang, key, '不是字符串'));
        continue;
      }
      if (!value.trim()) {
        const allowEmpty = lang === 'en' && allowEmptyEn.includes(key);
        if (!allowEmpty) failures.push(failure(surface, lang, key, '空值'));
        continue;
      }
      checked += 1;
      if (NON_LATIN_LANGUAGES.includes(lang) && isEnglishOnly(lang, value)) {
        failures.push(failure(surface, lang, key, '只有英文/缺少本语言文字：' + JSON.stringify(value)));
      }
    }
  }
  return { ok: failures.length === 0, surface, checked, keys: keys.length, failures };
}

/** 审计 DICT（zh → en）与 12 语言词条表的交叉覆盖。 */
export function auditDictionary(dict, localeText, { allowEmptyEn = [] } = {}) {
  const failures = [];
  const dictKeys = Object.keys(dict || {});
  const missingLocale = diffKeys(dictKeys, Object.keys(localeText || {}));
  for (const key of missingLocale) {
    for (const lang of LANGUAGES.filter((lang) => lang !== 'zh')) {
      failures.push(failure('ui-dict', lang, key, 'DICT 有词条但 12 语言表缺失（非中文界面会残留中文）'));
    }
  }
  // DICT 的英文值必须与 localeText.en 一致（两套英文不能漂移）。
  const drift = [];
  for (const key of dictKeys) {
    const row = localeText && localeText[key];
    if (!row) continue;
    if (allowEmptyEn.includes(key)) continue;
    if (typeof row.en === 'string' && row.en.trim() && row.en !== dict[key]) {
      drift.push({ key, dict: dict[key], locale: row.en });
    }
  }
  for (const item of drift.slice(0, 20)) {
    failures.push(failure('ui-dict', 'en', item.key, 'DICT 英文与 localeText.en 不一致：' + JSON.stringify(item.dict) + ' != ' + JSON.stringify(item.locale)));
  }
  return {
    ok: failures.length === 0,
    surface: 'ui-dict',
    keys: dictKeys.length,
    missingLocale,
    drift,
    failures,
  };
}

/** HTML 静态中文必须同时进 DICT 与 12 语言表。 */
export function auditHtmlStrings(htmlStrings, dict, localeText) {
  const failures = [];
  const missingDict = [];
  const missingLocale = [];
  const keys = [...htmlStrings].filter(Boolean);
  for (const key of keys) {
    const normalized = key.replace(/\s+/g, ' ');
    const inDict = dict[key] !== undefined || dict[normalized] !== undefined;
    const localeRow = localeText[key] || localeText[normalized];
    if (!inDict) missingDict.push(key);
    if (!localeRow) missingLocale.push(key);
    else if (NON_LATIN_LANGUAGES.some((lang) => typeof localeRow[lang] !== 'string' || !localeRow[lang].trim())) {
      missingLocale.push(key);
    }  }
  for (const key of missingDict) failures.push(failure('ui-html', 'en', key, 'HTML 静态中文缺 DICT 英文词条'));
  for (const key of missingLocale) failures.push(failure('ui-html', '12-lang', key, 'HTML 静态中文缺 12 语言词条'));
  return { ok: failures.length === 0, surface: 'ui-html', keys: keys.length, missingDict, missingLocale, failures };
}

/** 浮层语言包：key 集一致、无空值、非拉丁语言必须本地化。 */
export function auditOverlayPacks(packs, { languages = LANGUAGES, base = 'en' } = {}) {
  const failures = [];
  const basePack = (packs || {})[base];
  if (!basePack) return { ok: false, surface: 'overlay', checked: 0, failures: [failure('overlay', base, '(all)', '缺少基准语言包')] };
  const baseKeys = Object.keys(basePack);
  let checked = 0;
  const langReport = auditLanguages(Object.keys(packs || {}), languages);
  for (const lang of langReport.missing) failures.push(failure('overlay', lang, '(all)', '缺少语言包'));
  for (const lang of languages) {
    const pack = packs[lang];
    if (!pack) continue;
    const missing = diffKeys(baseKeys, Object.keys(pack));
    for (const key of missing) failures.push(failure('overlay', lang, key, '键缺失'));
    for (const key of Object.keys(pack)) {
      const value = pack[key];
      if (typeof value !== 'string' || !value.trim()) {
        failures.push(failure('overlay', lang, key, '空值'));
        continue;
      }
      checked += 1;
      if (NON_LATIN_LANGUAGES.includes(lang) && isEnglishOnly(lang, value)) {
        failures.push(failure('overlay', lang, key, '只有英文/缺少本语言文字：' + JSON.stringify(value)));
      }
    }
  }
  return { ok: failures.length === 0, surface: 'overlay', checked, keys: baseKeys.length, failures };
}

/** 错误码提示：每个码 × 12 语言、非拉丁语言必须本地化、不能与英文完全相同。 */
export function auditErrorHints(hints, unknown, { languages = LANGUAGES, knownCodes } = {}) {
  const failures = [];
  const codes = knownCodes || Object.keys(hints || {});
  let checked = 0;
  if (!unknown || typeof unknown !== 'object') {
    failures.push(failure('errors', '(all)', 'UNKNOWN', '缺少未知错误兜底文案'));
  } else {
    const langReport = auditLanguages(Object.keys(unknown), languages);
    for (const lang of langReport.missing) failures.push(failure('errors', lang, 'UNKNOWN', '兜底文案缺该语言'));
    for (const lang of languages) {
      const value = unknown[lang];
      if (typeof value !== 'string' || !value.trim()) failures.push(failure('errors', lang, 'UNKNOWN', '兜底文案为空'));
      else if (NON_LATIN_LANGUAGES.includes(lang) && isEnglishOnly(lang, value)) {
        failures.push(failure('errors', lang, 'UNKNOWN', '兜底文案只有英文'));
      } else checked += 1;
    }
  }
  for (const code of codes) {
    const row = hints && hints[code];
    if (!row) {
      failures.push(failure('errors', '(any)', code, '错误码没有提示文案'));
      continue;
    }
    for (const lang of languages) {
      const value = row[lang];
      if (typeof value !== 'string' || !value.trim()) {
        failures.push(failure('errors', lang, code, '提示缺失或为空'));
        continue;
      }
      if (NON_LATIN_LANGUAGES.includes(lang)) {
        if (isEnglishOnly(lang, value)) failures.push(failure('errors', lang, code, '只有英文：' + JSON.stringify(value)));
        else if (row.en && value === row.en) failures.push(failure('errors', lang, code, '与英文完全相同'));
      }
      checked += 1;
    }
  }
  return { ok: failures.length === 0, surface: 'errors', checked, codes: codes.length, failures };
}

/** 对话框文案：keys × 12 语言。 */
export function auditDialogTexts(texts, keys, { languages = LANGUAGES } = {}) {
  const failures = [];
  const langReport = auditLanguages(Object.keys(texts || {}), languages);
  for (const lang of langReport.missing) failures.push(failure('dialog', lang, '(all)', '缺少语言'));
  let checked = 0;
  for (const lang of languages) {
    const row = texts[lang];
    if (!row) continue;
    for (const key of keys) {
      const value = row[key];
      if (typeof value !== 'string' || !value.trim()) failures.push(failure('dialog', lang, key, '文案缺失或为空'));
      else {
        checked += 1;
        if (NON_LATIN_LANGUAGES.includes(lang) && isEnglishOnly(lang, value)) failures.push(failure('dialog', lang, key, '只有英文：' + JSON.stringify(value)));
      }
    }
  }
  return { ok: failures.length === 0, surface: 'dialog', checked, failures };
}

/** 设置页动态提示：每一条都必须在 DICT 与 12 语言表里。 */
export function auditSettingsMessages(dict, localeText, keys = SETTINGS_MESSAGE_KEYS) {
  const failures = [];
  for (const key of keys) {
    if (dict[key] === undefined) failures.push(failure('settings', 'en', key, '设置页动态提示缺 DICT 英文'));
    const row = localeText[key];
    if (!row) {
      failures.push(failure('settings', '12-lang', key, '设置页动态提示缺 12 语言词条'));
      continue;
    }
    for (const lang of LANGUAGES.filter((item) => item !== 'zh')) {
      if (typeof row[lang] !== 'string' || !row[lang].trim()) failures.push(failure('settings', lang, key, '空值'));
      else if (NON_LATIN_LANGUAGES.includes(lang) && isEnglishOnly(lang, row[lang])) failures.push(failure('settings', lang, key, '只有英文'));
    }
  }
  return { ok: failures.length === 0, surface: 'settings', keys: keys.length, failures };
}

/** 汇总所有表面；任一失败则整体失败。 */
export function buildCoverageReport(surfaces) {
  const list = (surfaces || []).filter(Boolean);
  const failures = [];
  let checked = 0;
  for (const surface of list) {
    failures.push(...(surface.failures || []));
    checked += surface.checked || 0;
  }
  return { ok: failures.length === 0, checked, surfaces: list, failures };
}

/** 失败报告：逐条 surface/lang/key/reason；测试断言失败时直接打印。 */
export function formatCoverageReport(report, limit = 40) {
  if (report.ok) return 'i18n coverage: OK (' + report.checked + ' 条)';
  const lines = report.failures.slice(0, limit).map((item) => item.message);
  if (report.failures.length > limit) lines.push('…还有 ' + (report.failures.length - limit) + ' 条');
  return lines.join('\n');
}
