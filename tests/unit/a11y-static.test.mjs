// tests/unit/a11y-static.test.mjs —— 扩展 UI 静态可访问性门禁 + 运行时接线断言。
//
// 真实树：所有 extension/ui/*.html 与两个样式表必须零 findings；负例证明每条规则都会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditFocusCss,
  auditHtml,
  auditStatic,
  extractStyleBlocks,
  formatStaticReport,
} from './a11y-audit-lib.mjs';
import {
  collectThemeTokens,
  contrastRatio,
  mergeTokens,
  parseStyleRules,
  resolveColor,
} from './a11y-contrast-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const htmlFiles = fs.readdirSync(path.join(ROOT, 'extension', 'ui')).filter((file) => file.endsWith('.html')).sort();

function realSources() {
  const sources = [];
  for (const file of htmlFiles) {
    const text = read('extension/ui/' + file);
    sources.push({ file: 'extension/ui/' + file, text, kind: 'html' });
    // 内联 <style> 同样要过焦点可见性审计。
    extractStyleBlocks(text).forEach((style, index) => {
      sources.push({ file: 'extension/ui/' + file + '#style' + (index + 1), text: style, kind: 'css' });
    });
  }
  sources.push({ file: 'extension/ui/popup.css', text: read('extension/ui/popup.css'), kind: 'css' });
  sources.push({ file: 'extension/ui/ui.css', text: read('extension/ui/ui.css'), kind: 'css' });
  return sources;
}

test('真实树静态 a11y：12 个页面 + 内联样式 + 2 个样式表零 findings', () => {
  const result = auditStatic(realSources());
  assert.equal(result.ok, true, formatStaticReport(result));
  assert.equal(result.checked, realSources().length);
  assert.ok(htmlFiles.length >= 10, 'UI 页面太少：' + htmlFiles.length);
});

test('preview 内联主题 token：深色 primary 按钮正文满足 AA（--accent-fg 而非硬编码白字）', () => {
  const html = read('extension/ui/preview.html');
  assert.match(html, /button\.primary \{[^}]*color: var\(--accent-fg\)/, 'preview primary 按钮应使用 --accent-fg');
  const source = extractStyleBlocks(html).join('\n');
  const tokens = collectThemeTokens(source);
  const light = mergeTokens(tokens.light);
  const dark = mergeTokens(tokens.dark);
  for (const [mode, set] of [['light', light], ['dark', dark]]) {
    const fg = resolveColor(set['--accent-fg'], set);
    const bg = resolveColor(set['--accent'], set);
    assert.ok(fg && bg, mode + ' 缺 --accent-fg/--accent');
    const ratio = contrastRatio(fg, bg);
    assert.ok(ratio >= 4.5, mode + ' preview primary 按钮对比度 ' + ratio.toFixed(2) + ' < 4.5');
  }
  assert.ok(contrastRatio(resolveColor('#ffffff', dark), resolveColor(dark['--accent'], dark)) < 4.5, '负例：深色下硬编码白字应不达标');
  assert.ok(parseStyleRules(source).some((rule) => rule.selector === 'button.primary'));
});

test('每个页面都有 lang、title，并在样式前加载 direction.js 与 i18n.js', () => {
  for (const file of htmlFiles) {
    const text = read('extension/ui/' + file);
    assert.match(text, /<html lang="zh-CN">/, file + ' 缺 html lang');
    assert.match(text, /<title>[^<]+<\/title>/, file + ' 缺 title');
    assert.match(text, /<script src="direction\.js"><\/script>/, file + ' 缺同步 direction.js');
    assert.match(text, /<script type="module" src="i18n\.js"><\/script>/, file + ' 缺 i18n.js');
  }
});

test('动态状态区域带 aria-live/role=status（长截图/弹窗升级提示/Toast）', () => {
  const longshot = read('extension/ui/longshot.html');
  assert.match(longshot, /id="restoreList" role="status" aria-live="polite"/);
  assert.match(longshot, /id="note"[^>]*role="status" aria-live="polite"/);
  const popup = read('extension/ui/popup.html');
  assert.match(popup, /id="upgradeNotice"[^>]*role="status" aria-live="polite"/);
  const uiCss = read('extension/ui/ui.css');
  assert.match(uiCss, /\.toast\s*\{/, 'ui.css 缺 toast 样式');
});

test('开关控件：所有 role=switch 都有 aria-checked 与 aria-label', () => {
  const popup = read('extension/ui/popup.html');
  const switches = [...popup.matchAll(/<button\b[^>]*role="switch"[^>]*>/g)].map((match) => match[0]);
  assert.ok(switches.length >= 5, '弹窗开关数量异常：' + switches.length);
  for (const tag of switches) {
    assert.match(tag, /aria-checked="(true|false)"/, '开关缺 aria-checked：' + tag.slice(0, 80));
    assert.match(tag, /aria-label="[^"]+"/, '开关缺 aria-label：' + tag.slice(0, 80));
  }
  // 运行时代码必须同步 aria-checked（而不是只在 HTML 里写死）。
  assert.match(read('extension/ui/popup.js'), /setAttribute\('aria-checked', on \? 'true' : 'false'\)/);
  assert.match(read('extension/ui/panels/audit-panel.js'), /setAttribute\('aria-checked', String\(enabled\)\)/);
});

test('图标按钮/图片：内联 SVG 必须有 aria-hidden 或可访问名称，img 必须有 alt', () => {
  for (const file of htmlFiles) {
    const text = read('extension/ui/' + file);
    for (const match of text.matchAll(/<svg\b([^>]*)>/gi)) {
      const tag = match[0];
      const hidden = /aria-hidden="true"/.test(tag);
      const named = /aria-label="[^"]+"/.test(tag) || /role="img"/.test(tag);
      assert.ok(hidden || named, file + ' 的 SVG 既没 aria-hidden 也没名称：' + tag.slice(0, 100));
    }
    for (const match of text.matchAll(/<img\b([^>]*)>/gi)) {
      assert.match(match[0], /\balt=/, file + ' 的 img 缺 alt：' + match[0].slice(0, 100));
    }
  }
});

test('焦点可见性：两个样式表都有 :focus-visible 且 outline 用 token 颜色', () => {
  for (const file of ['extension/ui/popup.css', 'extension/ui/ui.css']) {
    const result = auditFocusCss({ file, text: read(file) });
    assert.deepEqual(result, [], file + ' 焦点样式问题：' + JSON.stringify(result));
    assert.match(read(file), /:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/, file + ' 缺 2px accent 焦点环');
  }
});

test('负例：缺 alt / 按钮无名称 / 正数 tabindex / 开关缺 aria-checked / 控件无 label 都会失败', () => {
  const html = [
    '<!doctype html><html><head><title>x</title></head><body>',
    '<img src="a.png">',
    '<button><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></button>',
    '<div tabindex="3">第三</div>',
    '<span role="switch" aria-label="开关"></span>',
    '<input id="lonely">',
    '</body></html>',
  ].join('\n');
  const findings = auditHtml({ file: 'fixture/bad.html', text: html });
  const rules = new Set(findings.map((finding) => finding.rule));
  for (const rule of ['html-lang', 'img-alt', 'button-name', 'tabindex-positive', 'switch-checked', 'control-name']) {
    assert.ok(rules.has(rule), '负例没有抓到规则 ' + rule + '：' + JSON.stringify([...rules]));
  }
  assert.ok(findings.every((finding) => /^fixture\/bad\.html:\d+ \[/.test(finding.message)), '失败信息缺文件/行号');
});

test('负例：outline:none 且没有替代焦点样式必须失败', () => {
  const findings = auditFocusCss({ file: 'fixture/bad.css', text: '.a:focus { outline: none; }' });
  assert.ok(findings.some((finding) => finding.rule === 'outline-none'), '没有抓到 outline:none');
  const none = auditFocusCss({ file: 'fixture/none.css', text: '.a { color: red; }' });
  assert.ok(none.some((finding) => finding.rule === 'focus-style'), '没有抓到缺焦点样式');
});

test('错误提示接线：UI 展示错误时使用 12 语言 error-hints，而不是英文原文', () => {
  assert.match(read('extension/ui/popup.js'), /import \{ describeError \} from '\.\/error-hints\.js'/);
  assert.match(read('extension/ui/popup.js'), /function setErrorNode/);
  assert.match(read('extension/ui/popup.js'), /describeError\(value, getLang\(\)\)/);
  assert.match(read('extension/ui/common.js'), /export function errorText/);
  assert.match(read('extension/ui/common.js'), /describeError\(value, getLang\(\)\)/);
  assert.match(read('extension/ui/audit.js'), /describeError\(error, getLang\(\)\)/);
  for (const panel of ['audit-panel', 'debug-panel', 'longshot-panel', 'ops-panel', 'video-panel']) {
    assert.match(read('extension/ui/panels/' + panel + '.js'), /errorText\(/, panel + ' 错误状态没有本地化');
  }
  assert.match(read('extension/ui/options.js'), /toast\(translate\('已保存'\)\)/);
  assert.match(read('extension/ui/options.js'), /toast\(translate\('已恢复默认'\)\)/);
});

test('无正数 tabindex / 无原生 confirm（UI 层）', () => {
  for (const file of fs.readdirSync(path.join(ROOT, 'extension', 'ui')).filter((name) => /\.(html|js)$/.test(name))) {
    const text = read('extension/ui/' + file);
    assert.doesNotMatch(text, /tabindex\s*=\s*["']?[1-9]/, file + ' 存在正数 tabindex');
    if (file.endsWith('.js') && !['i18n.js', 'locales.js', 'error-hints.js', 'a11y-audit.js', 'rtl-audit.js', 'contrast-audit.js', 'i18n-audit.js', 'a11y-dialog.js'].includes(file)) {
      assert.doesNotMatch(text, /(?<![\w.])window\.confirm\(|(?<![\w.])alert\(/, file + ' 使用阻塞式原生对话框');
    }
  }
});
