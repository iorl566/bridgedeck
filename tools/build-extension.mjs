#!/usr/bin/env node
// tools/build-extension.mjs —— 把 extension/ 重新打包成 dist/BridgeDeck-extension-<version>.zip
// 并同步 dist/release.json 与 dist/SHA256SUMS（只更新存在的产物）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const name = `BridgeDeck-extension-${pkg.version}.zip`;
const out = path.join(DIST, name);

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  throw new Error('extension/manifest.json 不存在');
}
fs.mkdirSync(DIST, { recursive: true });
fs.rmSync(out, { force: true });

const psPath = (value) => String(value).replace(/'/g, "''");
const script = `Compress-Archive -Path '${psPath(path.join(EXT, '*'))}' -DestinationPath '${psPath(out)}' -Force`;
const packed = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
if (packed.status !== 0) {
  throw new Error('Compress-Archive 失败：' + (packed.stderr || packed.stdout));
}

const listed = spawnSync('tar', ['-tf', out], { encoding: 'utf8' });
if (listed.status !== 0) throw new Error('无法读取 zip 列表：' + (listed.stderr || listed.stdout));
const entries = new Set(String(listed.stdout).split(/\r?\n/).filter(Boolean));
for (const required of ['manifest.json', 'background.js', 'content/human-watch.js', 'injected/page-lib.js']) {
  if (!entries.has(required)) throw new Error('扩展 zip 缺少文件：' + required);
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

console.log(JSON.stringify({ ok: true, name, bytes, sha256: artifact.sha256, entries: entries.size }, null, 2));
