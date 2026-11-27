// tests/unit/i18n-rtl-audit.test.mjs —— ar/he RTL 逻辑属性审计门禁。
//
// 真实树：extension/ui（CSS/HTML/JS）+ extension/src 浮层（只读审计）不得出现未豁免的
// 物理方向属性；负例用内存 CSS/JS 片段证明门禁会失败；豁免表必须真实命中且不过期。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_EXEMPTIONS,
  auditRtlSources,
  findExemption,
  formatFinding,
  formatReport,
  parseCssStatements,
  scanSource,
} from './rtl-audit-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
// 门禁库自身包含规则/夹具字符串（例如 “left:” 检测正则），不作为被审计源码。
// 生成的语言数据文件只含翻译文本，也不审计。
const GENERATED_DATA = new Set(['locales.js', 'error-hints.js', 'rtl-audit.js', 'contrast-audit.js', 'i18n-audit.js']);
const AUDIT_EXT = /\.(css|html|js)$/;

function realSources() {
  const sources = [];
  for (const file of fs.readdirSync(path.join(ROOT, 'extension', 'ui'))) {
    if (!AUDIT_EXT.test(file) || GENERATED_DATA.has(file)) continue;
    const rel = 'extension/ui/' + file;
    sources.push({ file: rel, text: read(rel) });
  }
  for (const rel of [
    'extension/src/overlay-ui.js',
    'extension/src/record-overlay.js',
    'extension/src/manual-overlay.js',
    'extension/src/target-marker.js',
    'extension/src/overlay-theme.js',
  ]) {
    sources.push({ file: rel, text: read(rel) });
  }
  return sources;
}

test('真实树 RTL 审计：0 条未豁免物理方向属性，豁免表全部命中且无过期项', () => {
  const result = auditRtlSources(realSources());
  assert.equal(result.findings.length, 0, formatReport(result));
  assert.equal(result.staleExemptions.length, 0, '存在未命中的过期豁免：' + result.staleExemptions.join(', '));
  assert.ok(result.exempted.length >= 20, '豁免命中数异常：' + result.exempted.length);
  assert.ok(result.scannedFiles >= 30, '扫描文件太少：' + result.scannedFiles);
  const ids = new Set(result.exempted.map((item) => item.exemption));
  assert.ok(ids.has('switch-knob-mirror'));
  assert.ok(ids.has('overlay-page-coords-left'));
  assert.ok(ids.has('target-marker-page-coords'));
  assert.ok(ids.has('record-overlay-page-coords'));
});

test('UI 页面不再有物理 inline style（left/right/margin-left/padding-left）', () => {
  for (const file of fs.readdirSync(path.join(ROOT, 'extension', 'ui')).filter((name) => name.endsWith('.html'))) {
    const rel = 'extension/ui/' + file;
    const findings = scanSource({ file: rel, text: read(rel), kind: 'html' })
      .filter((finding) => finding.category.startsWith('physical'));
    assert.deepEqual(findings.map(formatFinding), [], rel + ' 仍有物理方向属性');
  }
});

test('UI CSS 使用逻辑属性：inset-inline-*、text-align 逻辑值与 inline 边距', () => {
  let combined = '';
  for (const file of ['extension/ui/popup.css', 'extension/ui/ui.css']) {
    const css = read(file);
    combined += '\n' + css;
    assert.match(css, /inset-inline-(start|end)/, file + ' 缺 inset-inline-*');
    assert.match(css, /text-align:\s*(start|center|end)/, file + ' 缺 text-align 逻辑值');
    assert.match(css, /\[dir="rtl"\]/, file + ' 缺 RTL 覆盖块');
    assert.doesNotMatch(css, /(?<![-a-z])(left|right)\s*:\s*\d/, file + ' 仍有物理 left/right 定位');
    assert.doesNotMatch(css, /margin-left\s*:/, file + ' 仍有 margin-left');
    assert.doesNotMatch(css, /padding-left\s*:/, file + ' 仍有 padding-left');
  }
  assert.match(combined, /margin-inline-(start|end)/, '两个 UI 样式表都没有 margin-inline-*');
});

test('RTL 语言清单：direction.js 与 i18n.js 都覆盖 ar/he 且支持 ?dir 覆盖', () => {
  const direction = read('extension/ui/direction.js');
  assert.match(direction, /RTL_LANGS\s*=\s*\/\^\(ar\|he\|/);
  for (const lang of ['ar', 'he']) assert.ok(direction.includes(lang), 'direction.js 缺 RTL 语言 ' + lang);
  assert.match(direction, /URLSearchParams\(location\.search\)\.get\('dir'\)/);
  assert.match(direction, /root\.dir = forced/);
  assert.match(direction, /data-bb-dir/);
  const i18n = read('extension/ui/i18n.js');
  assert.match(i18n, /RTL_LANG = \/\^\(ar\|he\|/);
  assert.match(i18n, /document\.documentElement\.dir = dir/);
});

test('负例：未豁免的物理属性必须失败并给出文件/行号', () => {
  const css = [
    ':root { --bg: #fff; }',
    '.card {',
    '  left: 12px;',
    '  margin-left: 4px;',
    '  padding-right: 8px;',
    '  text-align: left;',
    '}',
  ].join('\n');
  const result = auditRtlSources([{ file: 'extension/ui/bad.css', text: css, kind: 'css' }]);
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 4, formatReport(result));
  const reported = result.findings.map(formatFinding).join('\n');
  assert.match(reported, /extension\/ui\/bad\.css:3 left: 12px/);
  assert.match(reported, /margin-left/);
  assert.match(reported, /padding-right/);
  assert.match(reported, /text-align: left/);
});

test('负例：JS 里 .style.left 写入与 translateX(非 0) 也必须被审计', () => {
  const js = [
    'function place(el) {',
    "  el.style.left = rect.left + 'px';",
    "  el.style.marginRight = '4px';",
    '  el.style.transform = "translateX(16px)";',
    '}',
  ].join('\n');
  const result = auditRtlSources([{ file: 'extension/ui/bad.js', text: js, kind: 'js' }]);
  assert.equal(result.ok, false);
  const props = result.findings.map((finding) => finding.prop).sort();
  assert.deepEqual(props, ['left', 'margin-right', 'transform']);
  assert.ok(result.findings.some((finding) => finding.category === 'directional-transform'));
});

test('正例：逻辑属性/中心对称/成对镜像不产生命中', () => {
  const css = [
    '.card {',
    '  inset-inline-start: 8px;',
    '  margin-inline-end: 4px;',
    '  padding-inline-start: 12px;',
    '  text-align: start;',
    '  border-inline-start: 1px solid #ccc;',
    '  transform: translateX(0);',
    '}',
    '[dir="rtl"] .card { inset-inline-start: auto; inset-inline-end: 8px; }',
  ].join('\n');
  const result = auditRtlSources([{ file: 'extension/ui/good.css', text: css, kind: 'css' }], { exemptions: [] });
  assert.equal(result.ok, true, formatReport(result));
  assert.equal(result.findings.length, 0);
});

test('豁免表：精确文件匹配、可拒绝不匹配文件、过期豁免会被报告', () => {
  const css = '.target { left: 10px; }';
  const finding = scanSource({ file: 'extension/src/other.js', text: css, kind: 'js' })
    .find((item) => item.prop === 'left');
  assert.ok(finding, '夹具没有产生 left 命中');
  assert.equal(findExemption(finding), null, '其它文件不应命中 target-marker 豁免');

  const exemption = {
    id: 'fixture-exempt',
    file: 'extension/ui/bad.css',
    prop: 'left',
    reason: '夹具豁免',
  };
  const matched = findExemption({ file: 'extension/ui/bad.css', prop: 'left', value: '10px' }, [exemption]);
  assert.ok(matched && matched.id === 'fixture-exempt');

  const used = auditRtlSources([{ file: 'extension/ui/ok.css', text: '.a{inset-inline-start:0}', kind: 'css' }], {
    exemptions: [exemption],
  });
  assert.deepEqual(used.staleExemptions, ['fixture-exempt'], '未命中的豁免应被报告为过期');
  assert.equal(used.ok, false);

  // 真实豁免表每条都有理由，防止“豁免表变垃圾桶”。
  for (const rule of DEFAULT_EXEMPTIONS) {
    assert.ok(rule.id, '豁免缺 id');
    assert.ok(rule.reason && rule.reason.length >= 8, '豁免缺理由：' + rule.id);
    assert.ok(rule.prop || rule.category, '豁免缺匹配条件：' + rule.id);
  }
});

test('CSS 声明解析：伪元素/媒体查询/多行声明都能提取到', () => {
  const css = [
    '@media (prefers-color-scheme: dark) {',
    '  :root { --bg: #000; }',
    '  [dir="rtl"] details summary::before { content: "◂"; margin-inline-start: 4px; }',
    '}',
    '.a::after { left: 2px; }',
  ].join('\n');
  const declarations = parseCssStatements(css);
  const left = declarations.find((declaration) => declaration.prop === 'left');
  assert.ok(left, '没有解析到 left');
  assert.equal(left.line, 5);
  assert.ok(declarations.some((declaration) => declaration.prop === 'content'));
  assert.ok(declarations.some((declaration) => declaration.prop === '--bg'));
});
