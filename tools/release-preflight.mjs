#!/usr/bin/env node
// tools/release-preflight.mjs —— 发布前只读检查：制品哈希、版本混合、签名状态。
// 不签名、不上传；只把阻塞项列清楚。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'dist', 'release.json');
const args = process.argv.slice(2);
const json = args.includes('--json');
const keyPath = (() => {
  const index = args.indexOf('--key');
  return index >= 0 ? args[index + 1] : process.env.BB_RELEASE_PRIVATE_KEY || '';
})();

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const blockers = [];
const warnings = [];
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (error) {
  blockers.push('release.json 不存在或不是合法 JSON：' + ((error && error.message) || error));
}

const artifacts = [];
if (manifest) {
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) blockers.push('release.json 没有 artifacts');
  const versions = new Set();
  for (const item of manifest.artifacts || []) {
    const file = path.resolve(ROOT, item.file || '');
    const record = { name: item.name || path.basename(file), file: item.file, version: item.version || null };
    if (!fs.existsSync(file)) {
      blockers.push('缺少制品：' + (item.file || item.name));
      artifacts.push({ ...record, exists: false });
      continue;
    }
    const bytes = fs.statSync(file).size;
    const hash = sha256(file);
    record.exists = true;
    record.bytes = bytes;
    record.sha256 = hash;
    record.bytesMatch = Number(item.bytes) === bytes;
    record.hashMatch = String(item.sha256 || '').toLowerCase() === hash;
    if (!record.bytesMatch) blockers.push('大小不一致：' + item.name + ' 期望 ' + item.bytes + '，实际 ' + bytes);
    if (!record.hashMatch) blockers.push('sha256 不一致：' + item.name);
    const match = /(\d+\.\d+\.\d+)/.exec(item.name || '');
    if (match) versions.add(match[1]);
    artifacts.push(record);
  }
  if (versions.size > 1) blockers.push('制品版本混合：' + [...versions].join(', '));
  if (manifest.version && versions.size && !versions.has(String(manifest.version))) {
    blockers.push('release.json 版本 ' + manifest.version + ' 与制品版本不一致');
  }
  if (!manifest.signature) blockers.push('release.json 缺少签名（先运行 node tools/release.mjs --sign-ed25519 <key.pem>）');
  else if (manifest.signature.alg !== 'ed25519' && manifest.signature.alg !== 'hmac-sha256') {
    blockers.push('未知签名算法：' + manifest.signature.alg);
  }
}

if (keyPath) {
  if (!fs.existsSync(keyPath)) blockers.push('私钥不存在：' + keyPath);
  else {
    try {
      const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
      if (key.asymmetricKeyType !== 'ed25519') warnings.push('私钥不是 Ed25519：' + key.asymmetricKeyType);
    } catch (error) {
      blockers.push('私钥无法解析：' + ((error && error.message) || error));
    }
  }
}

const result = {
  ok: blockers.length === 0,
  version: manifest && manifest.version,
  generatedAt: manifest && manifest.generatedAt,
  signed: Boolean(manifest && manifest.signature),
  artifacts,
  warnings,
  blockers,
};
if (json) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  console.log('release preflight v' + (result.version || '?'));
  for (const artifact of artifacts) {
    console.log('  ' + (artifact.exists && artifact.hashMatch ? '[ok]' : '[!!]') + ' ' + artifact.name + ' ' + (artifact.bytes || 0) + 'B');
  }
  for (const warning of warnings) console.log('  warn: ' + warning);
  for (const blocker of blockers) console.log('  blocker: ' + blocker);
  console.log(result.ok ? 'PREFLIGHT PASS' : 'PREFLIGHT BLOCKED');
}
process.exit(result.ok ? 0 : 1);
