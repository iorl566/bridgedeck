#!/usr/bin/env node
// tools/release.mjs —— 生成/校验 dist 发布清单（SHA256 + 字节数 + 可选签名）。
//
// 用法：
//   node tools/release.mjs                                  # 写入 dist/release.json
//   node tools/release.mjs --sign-key <secret>              # HMAC-SHA256
//   node tools/release.mjs --sign-ed25519 <private.pem>     # Ed25519（推荐公开分发）
//   node tools/release.mjs --check [--public-key <pem>]     # 校验现有清单
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ed25519PublicKeyFromPrivate,
  signRelease,
  signReleaseEd25519,
  verifyReleaseSignature,
} from '../lib/release-sign.mjs';
import { RELEASE_PUBLIC_KEY } from '../lib/release-public-key.mjs';

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

function option(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const artifacts = collect();
const manifest = {
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  artifacts,
};

const signKeyPath = option('--sign-key');
const ed25519KeyPath = option('--sign-ed25519');
const publicKeyPath = option('--public-key');
if (signKeyPath && ed25519KeyPath) {
  console.error('--sign-key 与 --sign-ed25519 只能二选一');
  process.exit(1);
}

let signKey = '';
let ed25519Key = '';
if (signKeyPath) signKey = readFileSync(path.resolve(signKeyPath), 'utf8').trim();
if (ed25519KeyPath) ed25519Key = readFileSync(path.resolve(ed25519KeyPath), 'utf8').trim();
if (signKey) manifest.signature = signRelease(manifest, signKey);
if (ed25519Key) {
  manifest.signature = signReleaseEd25519(manifest, ed25519Key);
  const publicPem = ed25519PublicKeyFromPrivate(ed25519Key);
  writeFileSync(path.join(DIST, 'release-public.pem'), publicPem, 'utf8');
  console.log(`ed25519 keyId: ${manifest.signature.keyId}（公钥已写入 dist/release-public.pem）`);
}

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

  let verifyKey = '';
  if (publicKeyPath) verifyKey = readFileSync(path.resolve(publicKeyPath), 'utf8').trim();
  else if (signKeyPath) verifyKey = signKey;
  else if (existing.signature && existing.signature.alg === 'ed25519') verifyKey = RELEASE_PUBLIC_KEY;

  if (existing.signature) {
    if (!verifyKey) {
      console.log('note: release.json 含签名；提供 --public-key <pem> 或 --sign-key <secret> 可校验');
    } else if (!verifyReleaseSignature(existing, verifyKey)) {
      problems.push('signature mismatch');
    }
  } else if (verifyKey) {
    problems.push('missing signature');
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
