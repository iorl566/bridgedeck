#!/usr/bin/env node
// tools/build-extension.mjs —— 把 extension/ 重新打包成 dist/BridgeDeck-extension-<version>.zip
// 并同步 dist/release.json 与 dist/SHA256SUMS（只更新存在的产物）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkRuntimeClassification,
  listExtensionFiles,
  readReferenceOnly,
} from './lib/extension-runtime.mjs';
import { assertReleaseWritable, parseBuildArgs } from './lib/release-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const options = parseBuildArgs(process.argv.slice(2));
const DIST = options.out ? path.resolve(ROOT, options.out) : path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const name = `BridgeDeck-extension-${pkg.version}.zip`;
const out = path.join(DIST, name);

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  throw new Error('extension/manifest.json 不存在');
}
const { runtime, problems } = checkRuntimeClassification(EXT);
if (problems.length) {
  throw new Error('运行时/参考模块分类不一致：\n  ' + problems.join('\n  '));
}
const referenceOnly = readReferenceOnly(EXT);

assertReleaseWritable(DIST, { force: options.force });
if (options.dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, out, files: [...listExtensionFiles(EXT)].length, version: pkg.version }, null, 2));
  process.exit(0);
}

fs.mkdirSync(DIST, { recursive: true });
fs.rmSync(out, { force: true });
const staging = path.join(DIST, '.extension-build');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
const excluded = [];
try {
  for (const file of listExtensionFiles(EXT)) {
    if (file === 'reference-only.json') continue;
    // 发布包用前缀压缩的 o200k_base.bin，原始 tiktoken 只留在仓库供生成/校验。
    if (file === 'vendor/o200k/o200k_base.tiktoken') { excluded.push(file); continue; }
    if (file.endsWith('.js') && !runtime.has(file)) {
      excluded.push(file);
      continue;
    }
    const dest = path.join(staging, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(EXT, file), dest);
  }
  if (!fs.existsSync(path.join(staging, 'manifest.json'))) throw new Error('staging 缺少 manifest.json');

  const psPath = (value) => String(value).replace(/'/g, "''");
  const script = `Compress-Archive -Path '${psPath(path.join(staging, '*'))}' -DestinationPath '${psPath(out)}' -Force`;
  const packed = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (packed.status !== 0) {
    throw new Error('Compress-Archive 失败：' + (packed.stderr || packed.stdout));
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

const listed = spawnSync('tar', ['-tf', out], { encoding: 'utf8' });
if (listed.status !== 0) throw new Error('无法读取 zip 列表：' + (listed.stderr || listed.stdout));
const entries = new Set(String(listed.stdout).split(/\r?\n/).filter(Boolean));
for (const required of ['manifest.json', 'background.js', 'content/human-watch.js', 'injected/page-lib.js', 'ui/popup.html', 'offscreen.html']) {
  if (!entries.has(required)) throw new Error('扩展 zip 缺少文件：' + required);
}
for (const file of Object.keys(referenceOnly)) {
  if (entries.has(file)) throw new Error('参考镜像文件被打进 zip：' + file);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bytes = fs.statSync(out).size;

const releasePath = path.join(DIST, 'release.json');
let release = { version: pkg.version, generatedAt: new Date().toISOString(), artifacts: [] };
if (fs.existsSync(releasePath)) {
  try {
    release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  } catch {
    // 损坏时重建
  }
}
release.version = pkg.version;
release.generatedAt = new Date().toISOString();
// artifacts 变了，旧签名必然失效；保留它会让 update stage 直接拒绝清单。
// 发布前用 tools/release.mjs --sign-ed25519 <private.pem> 重新签名。
if (release.signature) {
  console.error('[build-extension] release.json 旧签名已移除；正式发布前请重新签名。');
}
delete release.signature;
release.artifacts = Array.isArray(release.artifacts) ? release.artifacts : [];
const artifact = {
  name,
  file: path.relative(ROOT, out).replace(/\\/g, '/'),
  bytes,
  sha256: sha256(out),
};
const index = release.artifacts.findIndex((item) => item && item.name === name);
if (index >= 0) release.artifacts[index] = artifact;
else release.artifacts.push(artifact);
release.artifacts = release.artifacts.map((item) => {
  if (!item || !item.file) return item;
  const file = path.join(ROOT, item.file);
  if (!fs.existsSync(file)) return item;
  return { ...item, bytes: fs.statSync(file).size, sha256: sha256(file) };
});
fs.writeFileSync(releasePath, JSON.stringify(release, null, 2) + '\n', 'utf8');
fs.writeFileSync(
  path.join(DIST, 'SHA256SUMS'),
  release.artifacts.map((item) => item.sha256 + '  ' + item.name).join('\n') + '\n',
  'utf8',
);

console.log(JSON.stringify({
  ok: true,
  name,
  bytes,
  sha256: artifact.sha256,
  entries: entries.size,
  runtimeJs: runtime.size,
  excludedReferenceJs: excluded.length,
}, null, 2));
