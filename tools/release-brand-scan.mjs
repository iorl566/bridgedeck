#!/usr/bin/env node
// tools/release-brand-scan.mjs —— 发布物品牌词扫描：发布产物/发行源码中不得出现对标产品品牌字眼。
//
// 扫描范围：extension（除 vendor）、cli、daemon、lib、sdk、mcp、dsh-plugin、installer、bin、
// translation、apps、README.md；以及 dist 下已构建的扩展/CLI/插件压缩包（解压后扫描）。
// 命中即 exit 1，输出文件与行号；第三方 vendor 目录跳过。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['extension', 'cli', 'daemon', 'lib', 'sdk', 'mcp', 'dsh-plugin', 'installer', 'bin', 'translation', 'apps', 'skill'];
const EXTS = /\.(js|mjs|cjs|ts|tsx|json|html|css|md|py|sh|ps1)$/i;
const SKIP_DIR = /^(vendor|node_modules|\.git|dist|target|\.output|\.wxt|build|out)$/;
const RE = /BSK|BrowserSkill|参考实现|上游|\bbsk\b/gi;
const hits = [];

function scanText(file, text) {
  for (const [index, line] of text.split('\n').entries()) {
    if (RE.test(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 160)}`);
    RE.lastIndex = 0;
  }
}
function scanFile(file) {
  scanText(file, fs.readFileSync(file, 'utf8'));
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue;
      walk(p);
    } else if (EXTS.test(entry.name)) {
      scanFile(p);
    }
  }
}

for (const root of ROOTS) {
  const abs = path.join(ROOT, root);
  if (fs.existsSync(abs)) walk(abs);
}
for (const file of ['README.md', 'package.json', 'AGENT_INSTALL.md', 'install.ps1', 'install.sh', 'install-online.ps1', 'install-online.sh', 'uninstall.ps1', 'uninstall.sh']) {
  const abs = path.join(ROOT, file);
  if (fs.existsSync(abs)) scanFile(abs);
}

// 已构建产物：解压后扫描（zip/tar.gz 由 bsdtar 解压）
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  for (const name of fs.readdirSync(dist)) {
    if (!/^BridgeDeck-(extension|cli|cli-bundle|dsh-plugin)-.*\.(zip|tar\.gz)$/.test(name)) continue;
    const archive = path.join(dist, name);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-scan-'));
    let r = spawnSync('tar', ['-xf', archive, '-C', tmp], { windowsHide: true });
    if (r.status !== 0 && /\.zip$/i.test(name)) {
      // Linux runner 的 GNU tar 不支持 zip；回退到 unzip。
      r = spawnSync('unzip', ['-q', archive, '-d', tmp], { windowsHide: true });
    }
    if (r.status === 0) walk(tmp);
    else hits.push(`dist/${name}: 解压失败，无法扫描`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (hits.length) {
  console.error(`release brand scan FAILED：${hits.length} 处`);
  for (const hit of hits.slice(0, 80)) console.error('  ' + hit);
  process.exit(1);
}
console.log('release brand scan PASS：发布范围无对标产品品牌字眼');
