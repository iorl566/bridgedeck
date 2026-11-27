#!/usr/bin/env node
// docs/store-listing/build-paste-sheet.mjs — 把 13 个语言文案生成一页可直接复制粘贴的本地 HTML。
// 用法：node docs/store-listing/build-paste-sheet.mjs
// 产物：docs/store-listing/paste-sheet.html（file:// 打开即可，无外部依赖、无网络请求）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = [
  ['en-US', 'en', 'English (US)'],
  ['zh-CN', 'zh_CN', '简体中文'],
  ['zh-TW', 'zh_TW', '繁體中文'],
  ['ja-JP', 'ja', '日本語'],
  ['ko-KR', 'ko', '한국어'],
  ['de-DE', 'de', 'Deutsch'],
  ['fr-FR', 'fr', 'Français'],
  ['es-ES', 'es', 'Español'],
  ['it-IT', 'it', 'Italiano'],
  ['pt-BR', 'pt_BR', 'Português (Brasil)'],
  ['pt-PT', 'pt_PT', 'Português (Portugal)'],
  ['ar-SA', 'ar', 'العربية'],
  ['he-IL', 'he', 'עברית'],
];
const RTL = new Set(['ar-SA', 'he-IL']);

function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const rest = text.slice(start + heading.length + 4);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

const escapeHtml = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cards = [];
for (const [locale, pkg, label] of LOCALES) {
  const text = fs.readFileSync(path.join(DIR, `${locale}.md`), 'utf8');
  const description = section(text, 'Description');
  const termsBlock = section(text, 'Search terms');
  const terms = termsBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim());

  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, '..', '..', 'extension', '_locales', pkg, 'messages.json'), 'utf8'));
  const short = manifest.extDescription?.message ?? '';

  const dirAttr = RTL.has(locale) ? ' dir="rtl"' : '';
  const termsText = terms.join('\n');

  cards.push(`
  <section class="card${RTL.has(locale) ? ' rtl' : ''}" id="${locale}">
    <header>
      <h2>${escapeHtml(label)} <span class="locale">${locale}</span>
        <span class="counts">${[...description].length} chars · ${terms.length} terms</span></h2>
    </header>
    <div class="field">
      <div class="label">描述 Description（250–10,000 字符）
        <button class="copy" data-target="desc-${locale}">复制描述</button>
      </div>
      <textarea id="desc-${locale}"${dirAttr} readonly rows="12">${escapeHtml(description)}</textarea>
    </div>
    <div class="field">
      <div class="label">搜索词 Search terms（逐行粘贴，或整块粘贴后按行拆分）
        <button class="copy" data-target="terms-${locale}">复制搜索词</button>
      </div>
      <textarea id="terms-${locale}"${dirAttr} readonly rows="${Math.max(4, terms.length)}">${escapeHtml(termsText)}</textarea>
    </div>
    <div class="field">
      <div class="label">短描述 Short description（只读，来自 manifest，仅供核对）
        <button class="copy" data-target="short-${locale}">复制短描述</button>
      </div>
      <textarea id="short-${locale}"${dirAttr} readonly rows="2">${escapeHtml(short)}</textarea>
    </div>
  </section>`);
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>BridgeDeck — Edge 商店粘贴单（13 语言）</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; background: #f5f7fb; color: #141922; font: 15px/1.6 system-ui, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 28px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .tip { color: #475467; margin: 0 0 22px; }
  .steps { background: #fff; border: 1px solid #e4e8f0; border-radius: 12px; padding: 14px 18px; margin-bottom: 22px; }
  .steps ol { margin: 6px 0 0; padding-left: 22px; }
  .card { background: #fff; border: 1px solid #e4e8f0; border-radius: 12px; padding: 14px 18px 18px; margin-bottom: 16px; }
  .card h2 { font-size: 17px; margin: 0 0 4px; display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; }
  .locale { font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; color: #667085; background: #f2f4f7; border-radius: 6px; padding: 1px 6px; }
  .counts { font-size: 12px; color: #667085; font-weight: 400; }
  .field { margin-top: 12px; }
  .label { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; color: #344054; margin-bottom: 4px; }
  textarea { width: 100%; box-sizing: border-box; border: 1px solid #d0d5dd; border-radius: 8px; padding: 10px 12px; font: 13px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; resize: vertical; background: #fcfcfd; min-height: 120px; }
  .rtl textarea { font-family: "Segoe UI", Tahoma, "Noto Naskh Arabic", "Noto Sans Hebrew", sans-serif; }
  button.copy { border: 0; border-radius: 7px; background: #2f6fed; color: #fff; font-size: 12px; padding: 4px 10px; cursor: pointer; white-space: nowrap; }
  button.copy.ok { background: #15803d; }
  .assets { background: #fff; border: 1px solid #e4e8f0; border-radius: 12px; padding: 14px 18px; }
  .assets table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  .assets td, .assets th { text-align: left; border-bottom: 1px solid #eef1f6; padding: 6px 4px; vertical-align: top; }
  .assets code { font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    body { background: #10141c; color: #e6eaf2; }
    .steps, .card, .assets { background: #171c26; border-color: #2a3240; }
    .tip, .label { color: #9aa4b2; }
    textarea { background: #10141c; border-color: #2a3240; color: #e6eaf2; }
    .locale { background: #202634; color: #9aa4b2; }
  }
</style>
</head>
<body>
<main>
  <h1>BridgeDeck — Edge 商店粘贴单</h1>
  <p class="tip">Partner Center 登录会过期，按这份顺序一次做完：每填完一行就 <b>Save draft</b>，13 行全部 Complete 后再 Publish。</p>
  <div class="steps">
    <b>填写顺序</b>
    <ol>
      <li>Properties：Website 改成 <code>https://github.com/iorl566/bridgedeck</code>，Support 填 issues 页。</li>
      <li>Privacy：答案见 <code>docs/STORE-REVIEW.md</code>。</li>
      <li>Store listings：每个语言行 → Description（本页复制）→ Logo <code>icon-300.png</code> → 宣传图 → 5 张截图 → Search terms（本页复制）→ Save draft（图片只需在 en-US 行传一次，然后 Duplicate 到所有语言）。</li>
      <li>全部 Complete 后运行 <code>tools\\publish-edge.ps1</code> 提交审核。</li>
    </ol>
  </div>
  ${cards.join('\n')}
  <div class="assets">
    <h2 style="font-size:16px;margin:0">图片（每语言同一套，上传后 Duplicate）</h2>
    <table>
      <tr><th>用途</th><th>文件</th><th>规格</th></tr>
      <tr><td>Extension logo</td><td><code>docs/assets/store/icon-300.png</code></td><td>300×300</td></tr>
      <tr><td>Small promotional tile</td><td><code>docs/assets/store/promo-small-440x280.png</code></td><td>440×280</td></tr>
      <tr><td>Large promotional tile</td><td><code>docs/assets/store/promo-large-1400x560.png</code></td><td>1400×560</td></tr>
      <tr><td>截图 1–5（按顺序）</td><td><code>docs/assets/store/store-01.png</code> … <code>store-05.png</code></td><td>1280×800</td></tr>
    </table>
    <p class="tip" style="margin:10px 0 0">本文件由 <code>node docs/store-listing/build-paste-sheet.mjs</code> 从各语言 .md 生成，改文案后重新生成即可。</p>
  </div>
</main>
<script>
  document.querySelectorAll('button.copy').forEach((button) => {
    button.addEventListener('click', async () => {
      const field = document.getElementById(button.dataset.target);
      const value = field.value ?? field.textContent;
      let ok = false;
      try {
        await navigator.clipboard.writeText(value);
        ok = true;
      } catch (error) {
        field.removeAttribute('readonly');
        field.select();
        ok = document.execCommand('copy');
        field.setAttribute('readonly', '');
      }
      button.textContent = ok ? '已复制 ✓' : '复制失败，请手动选择';
      button.classList.toggle('ok', ok);
      setTimeout(() => {
        button.textContent = button.textContent.replace(ok ? '已复制 ✓' : '复制失败，请手动选择', button.dataset.label || '复制');
      }, 1600);
    });
    button.dataset.label = button.textContent;
  });
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(DIR, 'paste-sheet.html'), html, 'utf8');
console.log(`paste-sheet.html written: ${cards.length} locales, ${html.length} chars`);
