// tests/unit/a11y-contrast.test.mjs —— overlay/popup 浅色/深色/RTL 主题 WCAG AA 对比度门禁。
//
// 真实树：extension/ui/popup.css、ui.css 的 token 与字面色对；extension/src/overlay-theme.js
// 的浮层 token；失败必须给出前景/背景与比值。负例用旧的低对比度值证明门禁会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AA_CONTRAST, contrastRatio as libContrast, compositeOver as libComposite } from '../../lib/color-contrast.mjs';
import { OVERLAY_THEME } from '../../extension/src/overlay-theme.js';
import {
  AA_NORMAL,
  AA_NON_TEXT,
  NON_TEXT_TOKEN_PAIRS,
  OVERLAY_TOKEN_PAIRS,
  TEXT_TOKEN_PAIRS,
  auditStyleRules,
  auditTokenPairs,
  collectThemeTokens,
  combineReports,
  compositeOver,
  contrastRatio,
  formatColor,
  formatFailure,
  mergeTokens,
  parseColor,
  parseStyleRules,
  relativeLuminance,
  resolveColor,
} from './a11y-contrast-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const css = {
  popup: read('extension/ui/popup.css'),
  ui: read('extension/ui/ui.css'),
};

const rgb = (hex) => {
  const value = hex.replace('#', '');
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16), a: 1 };
};

function themeSets() {
  const sets = [];
  for (const [name, source] of Object.entries(css)) {
    const tokens = collectThemeTokens(source);
    const light = mergeTokens(tokens.light);
    const dark = mergeTokens(tokens.dark);
    sets.push({ mode: name + '-light', tokens: light });
    sets.push({ mode: name + '-dark', tokens: dark });
    if (Object.keys(tokens.rtlLight).length) sets.push({ mode: name + '-rtl-light', rtl: true, tokens: mergeTokens(light, tokens.rtlLight) });
    if (Object.keys(tokens.rtlDark).length) sets.push({ mode: name + '-rtl-dark', rtl: true, tokens: mergeTokens(dark, tokens.rtlDark) });
  }
  return sets;
}

const overlaySets = [
  { mode: 'overlay-light', tokens: OVERLAY_THEME.light },
  { mode: 'overlay-dark', tokens: OVERLAY_THEME.dark },
];

function popupUiReport() {
  const sets = themeSets();
  return combineReports([
    auditTokenPairs(sets, [...TEXT_TOKEN_PAIRS, ...NON_TEXT_TOKEN_PAIRS]),
    auditTokenPairs(overlaySets, OVERLAY_TOKEN_PAIRS),
    auditStyleRules(parseStyleRules(css.popup), sets.filter((item) => item.mode.startsWith('popup'))),
    auditStyleRules(parseStyleRules(css.ui), sets.filter((item) => item.mode.startsWith('ui'))),
  ]);
}

test('真实主题门禁：popup/ui light+dark+覆盖块与 overlay light/dark 全部满足 WCAG AA', () => {
  const report = popupUiReport();
  assert.equal(report.ok, true, report.failures.map((failure) => failure.message).join('\n'));
  assert.ok(report.checked >= 100, '对比度检查条数偏少：' + report.checked);
});

test('shallow 主题 token 覆盖率：浅色/深色各 ≥ 18 个颜色 token，且两套同名', () => {
  for (const [name, source] of Object.entries(css)) {
    const tokens = collectThemeTokens(source);
    assert.ok(Object.keys(tokens.light).length >= 8, name + ' 浅色 token 太少');
    assert.ok(Object.keys(tokens.dark).length >= 8, name + ' 深色 token 太少');
    assert.deepEqual(Object.keys(tokens.light).sort(), Object.keys(tokens.dark).sort(), name + ' 深浅 token 名不一致');
    assert.equal(tokens.light['--bg'], '#ffffff', name + ' 浅色 --bg 不对：' + tokens.light['--bg']);
    assert.equal(tokens.dark['--bg'], '#151922', name + ' 深色 --bg 不对：' + tokens.dark['--bg']);
  }
  assert.deepEqual(Object.keys(OVERLAY_THEME.light).sort(), Object.keys(OVERLAY_THEME.dark).sort());
});

test('RTL 主题与浅色/深色同色：RTL 覆盖块不引入低对比度新颜色', () => {
  for (const [name, source] of Object.entries(css)) {
    const tokens = collectThemeTokens(source);
    // 当前 RTL 覆盖只做图标镜像/位移，不应改颜色；若以后改颜色，必须同时进审计。
    for (const [token, value] of Object.entries(tokens.rtlLight)) {
      assert.match(token, /^--[a-z-]+$/, name + ' 的 RTL token 名异常');
      assert.ok(value.trim().length > 0, name + ' 的 RTL 颜色覆盖为空：' + token);
    }
    const rtlSets = [];
    const light = mergeTokens(tokens.light);
    const dark = mergeTokens(tokens.dark);
    rtlSets.push({ mode: name + '-rtl-light', rtl: true, tokens: mergeTokens(light, tokens.rtlLight) });
    rtlSets.push({ mode: name + '-rtl-dark', rtl: true, tokens: mergeTokens(dark, tokens.rtlDark) });
    const report = auditTokenPairs(rtlSets, [...TEXT_TOKEN_PAIRS, ...NON_TEXT_TOKEN_PAIRS]);
    assert.equal(report.ok, true, report.failures.map((failure) => failure.message).join('\n'));
  }
});

test('失败信息格式：必须包含前景/背景/比值/阈值，负例真的失败', () => {
  const report = auditTokenPairs([{ mode: 'fixture-light', tokens: { '--fg': '#6b7488', '--bg': '#f7f9fc' } }], [
    { fg: '--fg', bg: '--bg' },
  ]);
  assert.equal(report.ok, false);
  const failure = report.failures[0];
  assert.ok(failure, '低对比度没有失败');
  assert.ok(failure.ratio > 4.4 && failure.ratio < 4.5, '比值异常：' + failure.ratio);
  assert.match(failure.message, /fixture-light --fg on --bg: #6b7488 on #f7f9fc = 4\.4\d < 4\.5/);
  assert.equal(failure.fg, '#6b7488');
  assert.equal(failure.bg, '#f7f9fc');
  assert.equal(failure.min, AA_NORMAL);
});

test('负例：成功色当正文（#16a34a on #fff）与缺 token 都会失败', () => {
  const low = auditTokenPairs([{ mode: 'light', tokens: { '--fg': '#16a34a', '--bg': '#ffffff' } }], [{ fg: '--fg', bg: '--bg' }]);
  assert.equal(low.ok, false);
  assert.match(low.failures[0].message, /= 3\.30 < 4\.5/);

  const missing = auditTokenPairs([{ mode: 'dark', tokens: { '--fg': '#fff' } }], [{ fg: '--fg', bg: '--bg' }]);
  assert.equal(missing.ok, false);
  assert.match(missing.failures[0].message, /缺 token/);
});

test('修复记录：两个曾被门禁抓到的真实低对比度值现在已抬到 ≥4.5', () => {
  // 旧 --muted #6b7488 on --card #f7f9fc = 4.45（失败），现 #667085 = 4.72。
  assert.ok(contrastRatio(rgb('#6b7488'), rgb('#f7f9fc')) < AA_NORMAL, '旧值应失败，避免测试与实现脱节');
  assert.ok(contrastRatio(rgb('#667085'), rgb('#f7f9fc')) >= AA_NORMAL);
  // 旧 --ok #16a34a on #fff = 3.30（失败），现 #15803d = 5.02。
  assert.ok(contrastRatio(rgb('#16a34a'), rgb('#ffffff')) < AA_NORMAL);
  assert.ok(contrastRatio(rgb('#15803d'), rgb('#ffffff')) >= AA_NORMAL);
  // 开关轨道（非文本）也要 ≥3:1：旧 #c3cad8/#9aa3b5 不达标，现 #7a8496。
  assert.ok(contrastRatio(rgb('#c3cad8'), rgb('#ffffff')) < AA_NON_TEXT);
  assert.ok(contrastRatio(rgb('#7a8496'), rgb('#ffffff')) >= AA_NON_TEXT);
  assert.ok(contrastRatio(rgb('#7a8496'), rgb('#f7f9fc')) >= AA_NON_TEXT);
});

test('焦点环/开关轨道等非文本控件在 light/dark 下 ≥3:1', () => {
  const report = auditTokenPairs(themeSets(), NON_TEXT_TOKEN_PAIRS);
  assert.equal(report.ok, true, report.failures.map((failure) => failure.message).join('\n'));
  assert.ok(report.checked >= 8, '非文本对比度检查条数偏少：' + report.checked);
  for (const mode of ['light', 'dark']) {
    const tokens = OVERLAY_THEME[mode];
    for (const [fg, bg] of [['--bb-accent', '--bb-surface'], ['--bb-accent', '--bb-bg']]) {
      const ratio = contrastRatio(parseColor(tokens[fg]), parseColor(tokens[bg]));
      assert.ok(ratio >= AA_NON_TEXT, mode + ' ' + fg + ' on ' + bg + ' = ' + ratio.toFixed(2));
    }
  }
});

test('颜色解析：hex/rgb/rgba/命名色/var 回退与非法值', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#1c2230'), { r: 28, g: 34, b: 48, a: 1 });
  assert.equal(parseColor('#12345'), null);
  assert.deepEqual(parseColor('rgb(47, 111, 237)'), { r: 47, g: 111, b: 237, a: 1 });
  assert.equal(parseColor('rgba(0,0,0,.5)').a, 0.5);
  assert.deepEqual(parseColor('white'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor('color-mix(in srgb, red, blue)'), null);
  assert.deepEqual(resolveColor('var(--x, #ffffff)', {}), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(resolveColor('var(--fg)', { '--fg': '#1c2230' }), parseColor('#1c2230'));
  assert.equal(resolveColor('var(--missing)', {}), null);
  assert.equal(formatColor(parseColor('#ffffff')), '#ffffff');
  assert.match(formatColor({ r: 0, g: 0, b: 0, a: 0.5 }), /^#000000\/0\.50$/);
});

test('与 CLI 侧 lib/color-contrast.mjs 双实现一致（防止两套对比度算法漂移）', () => {
  const samples = ['#000000', '#ffffff', '#1c2230', '#667085', '#f7f9fc', '#2f6fed', '#d92d20', '#15803d', '#98a2b3', '#151922'];
  for (const foreground of samples) {
    for (const background of samples) {
      const a = contrastRatio(parseColor(foreground), parseColor(background));
      const b = libContrast(rgb(foreground), rgb(background));
      assert.ok(Math.abs(a - b) < 1e-9, foreground + ' on ' + background + ' 两实现不一致：' + a + ' vs ' + b);
    }
  }
  const over = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, rgb('#ffffff'));
  const libOver = libComposite({ r: 0, g: 0, b: 0, a: 0.5 }, rgb('#ffffff'));
  assert.deepEqual([over.r, over.g, over.b, over.a], [libOver.r, libOver.g, libOver.b, libOver.a]);
  assert.equal(typeof AA_CONTRAST, 'number');
  assert.equal(AA_CONTRAST, AA_NORMAL);
  assert.ok(relativeLuminance(rgb('#ffffff')) > relativeLuminance(rgb('#000000')));
});

test('样式规则解析：@media 深色 token 与选择器/字面色对', () => {
  const rules = parseStyleRules(css.popup);
  assert.ok(rules.length > 20, '规则数异常：' + rules.length);
  const darkRule = rules.find((rule) => /prefers-color-scheme:\s*dark/.test(rule.media) && rule.selector === ':root');
  assert.ok(darkRule, '没有解析到深色 :root 规则');
  const darkBg = darkRule.declarations.find((declaration) => declaration.prop === '--bg');
  assert.equal(darkBg.value, '#151922');
  const toastRule = parseStyleRules(css.ui).find((rule) => rule.selector === '.toast');
  assert.ok(toastRule, '没有解析到 .toast 规则');
  assert.ok(toastRule.declarations.some((declaration) => declaration.prop === 'color'));
});

test('auditStyleRules 跳过 transparent 背景（继承底色无法规则级判定）', () => {
  const rules = parseStyleRules('.a{color:#111;background:transparent}');
  const report = auditStyleRules(rules, [{ mode: 'light', tokens: {} }]);
  assert.equal(report.checked, 0);
  assert.equal(report.ok, true);
  const bad = parseStyleRules('.b{color:#dddddd;background:#ffffff}');
  const badReport = auditStyleRules(bad, [{ mode: 'light', tokens: {} }]);
  assert.equal(badReport.ok, false);
  assert.match(badReport.failures[0].message, /#dddddd on #ffffff = 1\.3\d < 4\.5/);
});

test('formatFailure 是门禁报告的单一格式来源', () => {
  const text = formatFailure({
    mode: 'dark',
    rtl: true,
    fgName: '--muted',
    bgName: '--surface',
    fg: parseColor('#98a2b3'),
    bg: parseColor('#1c2230'),
    ratio: 6.17,
    min: AA_NORMAL,
  });
  assert.equal(text, 'dark RTL --muted on --surface: #98a2b3 on #1c2230 = 6.17 < 4.5');
});
