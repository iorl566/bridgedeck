#!/usr/bin/env node
// tools/make-brand-icons.mjs —— 从矢量品牌 mark 生成清晰的扩展图标（16/32/48/128，透明背景）。
//
// 无新增依赖：用有头/无头 Edge 的 --screenshot 把 SVG 以精确尺寸栅格化。
// 注：headless Edge 不需要扩展即可渲染本地 HTML；--default-background-color=00000000 保留透明底。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'extension', 'ui', 'assets', 'brand-mark.svg');
const OUT = path.join(ROOT, 'extension', 'icons');
const EDGE = [process.env.BB_BROWSER_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => existsSync(p));
const SIZES = [16, 32, 48, 128];
if (!EDGE) { console.error('找不到 Edge'); process.exit(2); }
if (!existsSync(SVG)) { console.error('缺少矢量 mark：' + SVG); process.exit(2); }
mkdirSync(OUT, { recursive: true });

function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

const work = mkdtempSync(path.join(tmpdir(), 'bd-icons-'));
let failed = 0;
const results = [];
for (const size of SIZES) {
  const html = path.join(work, 'icon-' + size + '.html');
  const svgUrl = 'file:///' + SVG.replace(/\\/g, '/');
  writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block;width:${size}px;height:${size}px}</style></head><body><img src="${svgUrl}" width="${size}" height="${size}" alt=""></body></html>`, 'utf8');
  const out = path.join(OUT, 'icon' + size + '.png');
  const shot = path.join(work, 'shot-' + size + '.png');
  const run = spawnSync(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--default-background-color=00000000',
    '--window-size=' + size + ',' + size,
    '--screenshot=' + shot,
    '--user-data-dir=' + path.join(work, 'profile-' + size),
    'file:///' + html.replace(/\\/g, '/'),
  ], { encoding: 'utf8', timeout: 60000 });
  if (!existsSync(shot)) {
    console.error('icon' + size + ' 渲染失败：' + (run.stderr || run.stdout || '').slice(0, 200));
    failed += 1;
    continue;
  }
  const info = pngSize(shot);
  if (info.width !== size || info.height !== size) {
    console.error('icon' + size + ' 尺寸不符：' + info.width + 'x' + info.height);
    failed += 1;
    continue;
  }
  copyFileSync(shot, out);
  results.push({ size, bytes: info.bytes, file: 'extension/icons/icon' + size + '.png' });
  console.log('icon' + size + '.png: ' + info.bytes + ' bytes');
}
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ ok: failed === 0, failed, icons: results }, null, 2));
if (failed) process.exitCode = 1;
