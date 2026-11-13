#!/usr/bin/env node
// tools/edge-publish.mjs —— 通过 Microsoft Edge Add-ons API 上传并发布扩展。
// 需要：EDGE_API_KEY、EDGE_CLIENT_ID、EDGE_PRODUCT_ID（Partner Center）。
// 用法：EDGE_API_KEY=... EDGE_CLIENT_ID=... EDGE_PRODUCT_ID=... node tools/edge-publish.mjs [--package dist/BridgeDeck-extension-0.1.2.zip] [--notes "..."]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const apiKey = process.env.EDGE_API_KEY || '';
const clientId = process.env.EDGE_CLIENT_ID || '';
const productId = process.env.EDGE_PRODUCT_ID || '';
if (!apiKey || !clientId || !productId) {
  throw new Error('需要 EDGE_API_KEY、EDGE_CLIENT_ID、EDGE_PRODUCT_ID');
}
if (!/^[0-9a-f-]{36}$/i.test(productId)) {
  throw new Error('EDGE_PRODUCT_ID 应是 Partner Center 的 GUID');
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const zip = path.resolve(ROOT, option('--package', path.join('dist', `BridgeDeck-extension-${pkg.version}.zip`)));
if (!fs.existsSync(zip)) throw new Error('扩展包不存在：' + zip);
const notes = option('--notes', 'BridgeDeck ' + pkg.version + '：修复弹窗连接设置默认展开、补充按步骤截图与 Trace 网络时间线。');
const base = `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}`;
const headers = {
  Authorization: `ApiKey ${apiKey}`,
  'X-ClientID': clientId,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${url}: ${response.status} ${text.slice(0, 500)}`);
  }
  return { response, body };
}

function operationId(response) {
  const location = response.headers.get('location') || '';
  const value = location.split('/').filter(Boolean).pop() || '';
  if (!value) throw new Error('响应缺少 Location/operationID');
  return value;
}

console.log(JSON.stringify({ step: 'upload', package: path.relative(ROOT, zip), bytes: fs.statSync(zip).size }, null, 2));
const upload = await call(`${base}/submissions/draft/package`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/zip' },
  body: fs.readFileSync(zip),
});
const uploadId = operationId(upload.response);
let uploadStatus = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(5000);
  const result = await call(`${base}/submissions/draft/package/operations/${uploadId}`);
  uploadStatus = result.body;
  console.log(JSON.stringify({ step: 'upload-status', status: uploadStatus.status, message: uploadStatus.message }, null, 2));
  if (uploadStatus.status === 'Succeeded' || uploadStatus.status === 'Failed') break;
}
if (!uploadStatus || uploadStatus.status !== 'Succeeded') {
  throw new Error('扩展包上传失败：' + JSON.stringify(uploadStatus));
}

console.log(JSON.stringify({ step: 'publish' }, null, 2));
const publish = await call(`${base}/submissions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ notes }),
});
const publishId = operationId(publish.response);
let publishStatus = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(5000);
  const result = await call(`${base}/submissions/operations/${publishId}`);
  publishStatus = result.body;
  console.log(JSON.stringify({ step: 'publish-status', status: publishStatus.status, message: publishStatus.message }, null, 2));
  if (publishStatus.status === 'Succeeded' || publishStatus.status === 'Failed') break;
}
if (!publishStatus || publishStatus.status !== 'Succeeded') {
  throw new Error('发布失败：' + JSON.stringify(publishStatus));
}
console.log(JSON.stringify({ ok: true, productId, uploadId, publishId, status: publishStatus.status }, null, 2));
