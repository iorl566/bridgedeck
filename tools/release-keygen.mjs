#!/usr/bin/env node
// tools/release-keygen.mjs —— 生成发布清单的 Ed25519 密钥对。
//
// 用法：
//   node tools/release-keygen.mjs                       # dist/signing/{release-private,release-public}.pem
//   node tools/release-keygen.mjs --write-public-key    # 同时写入 lib/release-public-key.mjs（需要提交）
//   node tools/release-keygen.mjs --out <dir> --force
//
// 私钥只放 CI Secret（RELEASE_SIGNING_PRIVATE_KEY），不要提交。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyId } from '../lib/release-sign.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const outDir = path.resolve(ROOT, option('--out', path.join('dist', 'signing')));
const force = flag('--force');
const privatePath = path.join(outDir, 'release-private.pem');
const publicPath = path.join(outDir, 'release-public.pem');
const modulePath = path.join(ROOT, 'lib', 'release-public-key.mjs');

if (fs.existsSync(privatePath) && !force) {
  console.error('私钥已存在：' + privatePath + '（加 --force 覆盖）');
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const keyId = publicKeyId(publicKey);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
fs.writeFileSync(publicPath, publicPem, { mode: 0o644 });

if (flag('--write-public-key')) {
  let existing = '';
  try { existing = fs.readFileSync(modulePath, 'utf8'); } catch { /* new file */ }
  const match = /RELEASE_PUBLIC_KEY\s*=\s*['"]([^'"]*)['"]/.exec(existing);
  if (match && match[1] && !force) {
    console.error('lib/release-public-key.mjs 已有公钥；加 --force 覆盖');
    process.exit(1);
  }
  const content = [
    '// 发布清单 Ed25519 公钥（由 tools/release-keygen.mjs --write-public-key 写入）。',
    '// 私钥只保存在发布机/CI Secret 中，不要提交。',
    'export const RELEASE_PUBLIC_KEY = ' + JSON.stringify(publicPem) + ';',
    '',
    'export const RELEASE_PUBLIC_KEY_ID = ' + JSON.stringify(keyId) + ';',
    '',
  ].join('\n');
  fs.writeFileSync(modulePath, content, 'utf8');
  console.log('已写入公钥：' + modulePath + '（提交这个文件）');
}

console.log('private: ' + privatePath + '（不要提交）');
console.log('public : ' + publicPath);
console.log('keyId  : ' + keyId);
console.log('');
console.log('下一步：');
console.log('  1) 把私钥内容设置到 GitHub Secret RELEASE_SIGNING_PRIVATE_KEY');
console.log('  2) 提交 lib/release-public-key.mjs（如使用了 --write-public-key）');
console.log('  3) 发布时用 node tools/release.mjs --sign-ed25519 ' + privatePath);
