/** Publish the workspace as a single commit and create a GitHub release.
 *
 * Requires GITHUB_TOKEN with contents + releases permission.
 * Usage: GITHUB_TOKEN=... node tools/github-publish.mjs --repo owner/name --tag v0.1.1
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

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

async function api(path, init = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'BridgeDeck-Release',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (response.ok) return response.json();
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

const files = walk(root);
const entries = await pool(files, async (file) => {
  const content = readFileSync(file).toString('base64');
  const blob = await api(`/repos/${repo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content, encoding: 'base64' }) });
  const path = relative(root, file).split(sep).join('/');
  return { path, mode: '100644', type: 'blob', sha: blob.sha };
}, 1);
const tree = await api(`/repos/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree: entries }),
});
const message = option('--message', 'BridgeDeck ' + version);
const commit = await api(`/repos/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents: [] }),
});
try {
  await api(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }),
  });
} catch {
  await api(`/repos/${repo}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
}
if (!existsSync(notesPath)) throw new Error('release notes not found: ' + notesPath);
const body = readFileSync(notesPath, 'utf8');
const release = await api(`/repos/${repo}/releases`, {
  method: 'POST',
  body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false, target_commitish: 'main' }),
});
for (const name of readdirSync(dist)) {
  if (!/\.(zip|tar\.gz|pkg|exe)$/.test(name)) continue;
  const content = readFileSync(join(dist, name));
  const response = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
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
console.log(JSON.stringify({ repo, commit: commit.sha, release: release.html_url, files: files.length, bytes: files.reduce((sum, file) => sum + statSync(file).size, 0) }));
