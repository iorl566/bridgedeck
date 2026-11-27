#!/usr/bin/env node
// tools/unused-extension-modules.mjs —— 静态扫描扩展 src 的未引用模块（advisory）。
//
// 从 manifest 声明的入口（service worker / content scripts / popup / options）和这些入口
// 引用的 HTML 里的 <script> 出发，跟踪相对 import/export-from/动态 import，
// 报告 extension/src 下未被引用的 .js。工具脚本/测试不进这个图。
//
// 用法：node tools/unused-extension-modules.mjs [--json] [--fail]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'extension');
const SRC = path.join(EXT, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const jsonMode = process.argv.includes('--json');
const failMode = process.argv.includes('--fail');

const roots = new Set();
const addRoot = (rel) => {
  if (!rel) return;
  const full = path.resolve(EXT, String(rel));
  if (fs.existsSync(full)) roots.add(full);
};
addRoot(manifest.background && (manifest.background.service_worker || manifest.background.scripts && manifest.background.scripts[0]));
for (const block of manifest.content_scripts || []) {
  for (const file of block.js || []) addRoot(file);
}
addRoot(manifest.action && manifest.action.default_popup);
addRoot(manifest.options_ui && manifest.options_ui.page);
addRoot(manifest.options_page);
addRoot('preview.html');
addRoot('offscreen.html');
// 扩展 src 里的共享模块也会被 CLI/daemon/MCP 直接 import（如 controller-info），这些入口必须算已引用。
for (const shared of ['cli/bridge.mjs', 'daemon/server.mjs', 'mcp/server.mjs', 'sdk/index.mjs']) {
  const full = path.resolve(ROOT, shared);
  if (fs.existsSync(full)) roots.add(full);
}
// 单测/reference 也会直接 import 扩展模块（如 controller-info 的校验/配色），算已引用。
for (const dir of ['tests/unit', 'tests/reference']) {
  const full = path.resolve(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const item of fs.readdirSync(full)) {
    if (item.endsWith('.test.mjs')) roots.add(path.join(full, item));
  }
}

// HTML 里的 <script src> 也视为入口（内容/弹窗页面）。
const htmlFiles = [];
for (const item of [...roots]) if (String(item).endsWith('.html')) htmlFiles.push(item);
for (const html of htmlFiles) {
  let text = '';
  try { text = fs.readFileSync(html, 'utf8'); } catch { continue; }
  const re = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(text))) {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(match[1])) continue;
    addRoot(path.relative(EXT, path.resolve(path.dirname(html), match[1])));
  }
}

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\b[\s\S]{0,400}?from\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
const BARE_RE = /(?:^|[\s;])import\s*["']([^"']+)["']/g;

function importsOf(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const specs = new Set();
  for (const re of [IMPORT_RE, DYNAMIC_RE, BARE_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      const spec = match[1];
      if (spec && spec.startsWith('.')) specs.add(path.resolve(path.dirname(file), spec));
    }
  }
  return [...specs];
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile() && item.name.endsWith('.js')) out.push(full);
    }
  }
  return out;
}

const all = walk(SRC);
const seen = new Set();
const stack = [...roots];
while (stack.length) {
  const file = stack.pop();
  const resolved = path.resolve(file);
  if (seen.has(resolved)) continue;
  if (!fs.existsSync(resolved)) continue;
  seen.add(resolved);
  for (const dep of importsOf(resolved)) {
    if (!fs.existsSync(dep) && fs.existsSync(dep + '.js')) stack.push(dep + '.js');
    else stack.push(dep);
  }
}

const unused = all.filter((file) => !seen.has(file)).sort();
const relative = unused.map((file) => path.relative(ROOT, file).split(path.sep).join('/'));

if (jsonMode) {
  process.stdout.write(JSON.stringify({
    roots: [...roots].map((file) => path.relative(ROOT, file).split(path.sep).join('/')),
    total: all.length,
    used: seen.size,
    unused: relative,
  }) + '\n');
} else {
  console.log('roots=' + roots.size + ' modules=' + all.length + ' used=' + seen.size + ' unused=' + unused.length);
  for (const item of relative) console.log('  ' + item);
}
if (failMode && unused.length) process.exit(1);
