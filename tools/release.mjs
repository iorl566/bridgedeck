#!/usr/bin/env node
// tools/release.mjs —— 生成/校验 dist 发布清单（SHA256 + 字节数）。
//
// 用法：
//   node tools/release.mjs            # 写入 dist/release.json
//   node tools/release.mjs --check    # 校验现有清单与 dist 文件一致
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRelease, verifyReleaseSignature } from '../lib/release-sign.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const MANIFEST = path.join(DIST, 'release.json');
const CHECKSUMS = path.join(DIST, 'SHA256SUMS');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function collect() {
  if (!existsSync(DIST)) return [];
  return readdirSync(DIST)
    .filter((name) => /\.(zip|tar\.gz|pkg|exe)$/.test(name))
    .sort()
    .map((name) => {
      const file = path.join(DIST, name);
      return { name, file: 'dist/' + name, bytes: statSync(file).size, sha256: sha256(file) };
    });
}

const artifacts = collect();
const manifest = {
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  artifacts,
};
const signKeyIndex = process.argv.indexOf('--sign-key');
const signKeyPath = signKeyIndex >= 0 ? process.argv[signKeyIndex + 1] : '';
const signKey = signKeyPath ? readFileSync(path.resolve(signKeyPath), 'utf8').trim() : '';
if (signKey) manifest.signature = signRelease(manifest, signKey);

if (process.argv.includes('--check')) {
  if (!existsSync(MANIFEST)) {
    console.error('release.json 不存在；先运行 node tools/release.mjs');
    process.exit(1);
  }
  const existing = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const problems = [];
  if (existing.version !== manifest.version) problems.push(`version ${existing.version} != ${manifest.version}`);
  const byName = new Map((existing.artifacts || []).map((item) => [item.name, item]));
  if (byName.size !== artifacts.length) problems.push(`artifact count ${byName.size} != ${artifacts.length}`);
  for (const artifact of artifacts) {
    const recorded = byName.get(artifact.name);
    if (!recorded) problems.push(`missing ${artifact.name}`);
    else if (recorded.sha256 !== artifact.sha256 || recorded.bytes !== artifact.bytes) problems.push(`changed ${artifact.name}`);
  }
  if (signKey) {
    if (!existing.signature) problems.push('missing signature');
    else if (!verifyReleaseSignature(existing, signKey)) problems.push('signature mismatch');
  } else if (existing.signature) {
    console.log('note: release.json 含签名；加 --sign-key <file> 可校验');
  }
  if (!existsSync(CHECKSUMS)) {
    problems.push('missing SHA256SUMS');
  } else {
    const recorded = new Map(readFileSync(CHECKSUMS, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
      return match ? [match[2], match[1]] : ['', ''];
    }));
    for (const artifact of artifacts) {
      if (recorded.get(artifact.name) !== artifact.sha256) problems.push(`checksum changed ${artifact.name}`);
    }
  }
  if (problems.length) {
    console.error('release 校验失败：');
    for (const line of problems) console.error('  - ' + line);
    process.exit(1);
  }
  console.log(`release ok: v${manifest.version}，${artifacts.length} 个 artifact`);
  process.exit(0);
}

writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
writeFileSync(CHECKSUMS, artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join('\n') + '\n', 'utf8');
console.log(`release.json 已写入：v${manifest.version}，${artifacts.length} 个 artifact`);
for (const artifact of artifacts) console.log('  ' + artifact.name + '  ' + artifact.bytes + 'B  ' + artifact.sha256.slice(0, 16) + '…');
