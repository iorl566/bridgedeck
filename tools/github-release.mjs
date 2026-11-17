#!/usr/bin/env node
// tools/github-release.mjs —— 只创建/更新 GitHub Release 并上传 dist 制品；不改 git 历史。
// 默认创建 draft；未签名 manifest 必须显式 --allow-unsigned。
// 用法：GITHUB_TOKEN=... node tools/github-release.mjs [--repo owner/name] [--tag v0.1.8] [--publish] [--allow-unsigned]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
if (!token) throw new Error('需要 GITHUB_TOKEN');
const repo = option('--repo', 'iorl566/bridgedeck');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'release.json'), 'utf8'));
const tag = option('--tag', 'v' + manifest.version);
const publish = args.includes('--publish');
const allowUnsigned = args.includes('--allow-unsigned');
if (!manifest.signature && !allowUnsigned) throw new Error('release.json 未签名；加 --allow-unsigned 才能准备 draft');
const notesPath = path.join(ROOT, 'docs', 'releases', manifest.version + '.md');
const body = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : ('BridgeDeck ' + manifest.version);

async function api(url, init = {}) {
  const response = await fetch('https://api.github.com' + url, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'User-Agent': 'BridgeDeck-Release',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error((init.method || 'GET') + ' ' + url + ': ' + response.status + ' ' + text.slice(0, 500));
  return data;
}

let release = null;
const existing = await api('/repos/' + repo + '/releases?per_page=100');
release = existing.find((item) => item.tag_name === tag) || null;
if (!release) {
  const ref = await api('/repos/' + repo + '/git/ref/heads/main');
  release = await api('/repos/' + repo + '/releases', {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body,
      draft: !publish,
      prerelease: false,
      target_commitish: ref.object.sha,
    }),
  });
  console.log('created release ' + release.html_url + ' draft=' + release.draft);
} else {
  console.log('existing release ' + release.html_url + ' draft=' + release.draft);
}

const assets = new Map((release.assets || []).map((item) => [item.name, item]));
for (const artifact of manifest.artifacts) {
  const file = path.resolve(ROOT, artifact.file);
  const name = path.basename(file);
  if (!fs.existsSync(file)) { console.log('skip missing ' + name); continue; }
  if (assets.has(name)) { console.log('exists ' + name); continue; }
  const content = fs.readFileSync(file);
  const response = await fetch('https://uploads.github.com/repos/' + repo + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'User-Agent': 'BridgeDeck-Release',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
    },
    body: content,
  });
  if (!response.ok) throw new Error('upload ' + name + ': ' + response.status + ' ' + (await response.text()).slice(0, 500));
  console.log('uploaded ' + name + ' ' + content.length + 'B');
}
console.log(JSON.stringify({ ok: true, repo, tag, release: release.html_url, draft: release.draft, signed: Boolean(manifest.signature) }));
