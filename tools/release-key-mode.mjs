#!/usr/bin/env node
// tools/release-key-mode.mjs —— 切换仓库内置发布公钥（lib/release-public-key.mjs）的“生产 / 本地验证”模式。
//
// 为什么需要：本地链路验证用临时密钥签 dist 清单时，内置公钥必须与之一致（CLI update 校验才会通过）；
// 真实 CI 发布必须用生产私钥签名，内置公钥也必须切回生产公钥（keyId c7b5e21301f91a2d）。
// 本工具只改 lib/release-public-key.mjs，不动 dist、不联网、不上传。
//
// 用法：
//   node tools/release-key-mode.mjs --check                # 输出当前模式与 keyId
//   node tools/release-key-mode.mjs --mode production      # 切回生产公钥（tools/release-public-key.production.pem）
//   node tools/release-key-mode.mjs --mode local-verify    # 对齐当前 dist 清单所用的（临时）公钥
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(ROOT, 'lib', 'release-public-key.mjs');
const PRODUCTION_PEM = path.join(ROOT, 'tools', 'release-public-key.production.pem');
const DIST_PUBLIC = path.join(ROOT, 'dist', 'release-public.pem');
const DIST_MANIFEST = path.join(ROOT, 'dist', 'release.json');

function publicKeyId(pem) {
  const key = crypto.createPublicKey(pem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}
function readModule() {
  const text = fs.readFileSync(MODULE, 'utf8');
  const key = /RELEASE_PUBLIC_KEY\s*=\s*("(?:[^"\\]|\\.)*")/.exec(text);
  const id = /RELEASE_PUBLIC_KEY_ID\s*=\s*"([^"]+)"/.exec(text);
  return { text, pem: key ? JSON.parse(key[1]) : '', keyId: id ? id[1] : null };
}
function writeModule(pem, keyId) {
  const text = `// 发布清单 Ed25519 公钥（由 tools/release-key-mode.mjs / release.mjs --write-public-key 写入）。\n// 生产签名私钥只存 CI Secret RELEASE_SIGNING_PRIVATE_KEY；签名轮换时同步更新本文件。\nexport const RELEASE_PUBLIC_KEY = ${JSON.stringify(pem)};\n\nexport const RELEASE_PUBLIC_KEY_ID = ${JSON.stringify(keyId)};\n`;
  fs.writeFileSync(MODULE, text, 'utf8');
}
function currentMode() {
  const { pem, keyId } = readModule();
  if (!pem) return { mode: 'unknown', keyId };
  const id = publicKeyId(pem);
  let productionId = null;
  if (fs.existsSync(PRODUCTION_PEM)) productionId = publicKeyId(fs.readFileSync(PRODUCTION_PEM, 'utf8'));
  let distId = null;
  if (fs.existsSync(DIST_PUBLIC)) distId = publicKeyId(fs.readFileSync(DIST_PUBLIC, 'utf8'));
  const mode = productionId && id === productionId ? 'production' : distId && id === distId ? 'local-verify' : 'custom';
  return { mode, keyId: id, productionId, distKeyId: distId };
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const modeIndex = args.indexOf('--mode');
const mode = modeIndex >= 0 ? String(args[modeIndex + 1] || '') : '';

if (check || !mode) {
  const info = currentMode();
  console.log(JSON.stringify({ ok: true, ...info }, null, 2));
  process.exit(0);
}

if (mode === 'production') {
  if (!fs.existsSync(PRODUCTION_PEM)) {
    console.error('缺少生产公钥：' + PRODUCTION_PEM);
    process.exit(2);
  }
  const pem = fs.readFileSync(PRODUCTION_PEM, 'utf8').trim();
  writeModule(pem, publicKeyId(pem));
  console.log(JSON.stringify({ ok: true, mode: 'production', keyId: publicKeyId(pem) }, null, 2));
  process.exit(0);
}
if (mode === 'local-verify') {
  if (!fs.existsSync(DIST_PUBLIC) || !fs.existsSync(DIST_MANIFEST)) {
    console.error('dist 清单/公钥不存在，无法对齐本地验证模式');
    process.exit(2);
  }
  const pem = fs.readFileSync(DIST_PUBLIC, 'utf8').trim();
  const manifest = JSON.parse(fs.readFileSync(DIST_MANIFEST, 'utf8'));
  writeModule(pem, manifest.signature && manifest.signature.keyId ? manifest.signature.keyId : publicKeyId(pem));
  console.log(JSON.stringify({ ok: true, mode: 'local-verify', keyId: publicKeyId(pem) }, null, 2));
  process.exit(0);
}
console.error('未知 --mode：' + mode + '（可选 production / local-verify）');
process.exit(2);
