/** 用当前工作区重发同一个 tag：更新 main 的源码提交，并替换该 release 的附件与说明。
 *
 * 适用场景：版本号不变，只改了源码/构建产物（例如 UI 修复）。
 * 用法：GITHUB_TOKEN=... node tools/github-republish.mjs --repo owner/name --tag v0.1.2
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required');
const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const repo = option('--repo', 'iorl566/bridgedeck');
const tag = option('--tag', 'v' + pkg.version);
const version = tag.replace(/^v/, '');
const notesPath = option('--notes', join(root, 'docs', 'releases', version + '.md'));
const dist = join(root, 'dist');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (['node_modules', '.ref', 'ref', '.git', 'dist'].includes(name)) continue;
    if (name.startsWith('DSH-会话恢复-') || name.startsWith('t.slice(')) continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

async function request(url, init) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function api(path, init = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await request(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'BridgeDeck-Release',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (response.ok) {
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    const detail = await response.text();
    if ((response.status === 403 || response.status === 429) && /rate limit/i.test(detail)) {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      continue;
    }
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${detail}`);
  }
  throw new Error(`${path}: rate limit retries exhausted`);
}

async function pool(items, worker, size = 6) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

// 1) 源码提交（与 github-publish 一致：单提交覆盖 main）；--skip-commit 时跳过
let commit = { sha: 'skipped' };
let fileCount = 'skipped';
if (!args.includes('--skip-commit')) {
  const files = walk(root);
  fileCount = files.length;
  const entries = await pool(files, async (file) => {
    const content = readFileSync(file).toString('base64');
    const blob = await api(`/repos/${repo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content, encoding: 'base64' }) });
    return { path: relative(root, file).split(sep).join('/'), mode: '100644', type: 'blob', sha: blob.sha };
  }, 1);
  const tree = await api(`/repos/${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ tree: entries }) });
  const message = option('--message', 'BridgeDeck ' + version);
  commit = await api(`/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [] }),
  });
  try {
    await api(`/repos/${repo}/git/refs/heads/main`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true }) });
  } catch {
    await api(`/repos/${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }) });
  }
}

// 2) 找到 release，替换附件与说明
if (args.includes('--commit-only')) {
  console.log(JSON.stringify({ repo, commit: commit.sha, files: fileCount, assets: 'skipped' }));
  process.exit(0);
}
const body = readFileSync(notesPath, 'utf8');
let release;
try {
  release = await api(`/repos/${repo}/releases/tags/${tag}`);
} catch {
  release = await api(`/repos/${repo}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false, target_commitish: 'main' }) });
}
release = await api(`/repos/${repo}/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });

for (const asset of release.assets || []) {
  await api(`/repos/${repo}/releases/assets/${asset.id}`, { method: 'DELETE' });
}

const assets = readdirSync(dist).filter((name) => name.endsWith('.zip') || name.endsWith('.exe'));
for (const name of assets) {
  const content = readFileSync(join(dist, name));
  const response = await request(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'BridgeDeck-Release',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/octet-stream',
    },
    body: content,
  });
  if (!response.ok) throw new Error(`upload ${name}: ${response.status} ${await response.text()}`);
  console.log(`uploaded ${name}`);
}
console.log(JSON.stringify({ repo, commit: commit.sha, release: release.html_url, files: fileCount, assets }));
