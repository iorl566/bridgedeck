#!/usr/bin/env node
// tools/verify-extension-package.mjs —— 解压发布 zip，验证裁剪后仍能加载 service worker，
// 并检查所有静态 import / HTML script 引用都存在。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collectRuntimeFiles,
  listExtensionFiles,
  listExtensionJs,
} from './lib/extension-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const zip = path.join(ROOT, 'dist', `BridgeDeck-extension-${pkg.version}.zip`);
if (!fs.existsSync(zip)) throw new Error('发布包不存在：' + zip);

const staging = path.join(ROOT, 'dist', '.verify-extension');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
try {
  const unpack = spawnSync('tar', ['-xf', zip, '-C', staging], { encoding: 'utf8' });
  if (unpack.status !== 0) throw new Error('解压失败：' + (unpack.stderr || unpack.stdout));

  const files = new Set(listExtensionFiles(staging));
  for (const required of [
    'manifest.json',
    'background.js',
    'content/human-watch.js',
    'content/record-capture.js',
    'injected/page-lib.js',
    'injected/main-console.js',
    'injected/main-console-restore.js',
    'ui/popup.html',
    'offscreen.html',
  ]) {
    if (!files.has(required)) throw new Error('发布包缺少：' + required);
  }

  const runtime = collectRuntimeFiles(staging);
  const jsFiles = listExtensionJs(staging);
  const unexpected = jsFiles.filter((file) => !runtime.has(file));
  if (unexpected.length) throw new Error('发布包含不可达 JS：' + unexpected.join(', '));

  const missing = [];
  for (const file of jsFiles) {
    const source = fs.readFileSync(path.join(staging, file), 'utf8');
    const specs = [];
    for (const match of source.matchAll(/(?:import|export)\s+[^'";]*?from\s+['"]([^'"]+)['"]/g)) specs.push(match[1]);
    for (const match of source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.push(match[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!path.posix.extname(target)) target += '.js';
      if (!files.has(target)) missing.push(file + ' -> ' + target);
    }
  }
  for (const file of files) {
    if (!file.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(staging, file), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (!files.has(target)) missing.push(file + ' -> ' + target);
    }
  }
  if (missing.length) throw new Error('发布包缺少静态引用：\n  ' + missing.join('\n  '));

  const loaded = spawnSync(process.execPath, ['tests/extension/module-load.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, BB_EXT_ROOT: staging },
  });
  if (loaded.status !== 0) throw new Error('发布包 service worker 加载失败：\n' + (loaded.stdout || '') + (loaded.stderr || ''));
  const sha = spawnSync(process.execPath, ['-e', `
    const fs=require('fs'),crypto=require('crypto');
    const p=process.argv[1];
    console.log(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
  `, zip], { encoding: 'utf8' }).stdout.trim();

  console.log(JSON.stringify({
    ok: true,
    zip: path.relative(ROOT, zip),
    bytes: fs.statSync(zip).size,
    entries: files.size,
    runtimeJs: runtime.size,
    sha256: sha,
  }, null, 2));
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
