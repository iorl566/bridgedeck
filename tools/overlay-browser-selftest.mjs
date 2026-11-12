import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const repo = process.cwd();
const root = join(repo, 'tests', 'browser', 'dist-overlays');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

const vite = readdirSync(join(repo, 'node_modules', '.pnpm'))
  .filter((name) => /^vite@/.test(name))
  .map((name) => join(repo, 'node_modules', '.pnpm', name, 'node_modules', 'vite', 'bin', 'vite.js'))
  .find(existsSync);
if (!vite) throw new Error('vite CLI not found');
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [vite, 'build', '--config', 'vite.overlay.config.mjs'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  child.on('error', reject);
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`vite build failed: ${code}`))));
});

const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const target = normalize(join(root, path));
  if (!target.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const edge = process.env.BRIDGE_EDGE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!existsSync(edge)) throw new Error(`browser not found: ${edge}`);
const profile = join(tmpdir(), `bb-overlay-${randomUUID()}`);
const result = await new Promise((resolve, reject) => {
  const child = spawn(edge, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--virtual-time-budget=8000', '--dump-dom', `http://127.0.0.1:${port}/tests/browser/overlays.html`], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('exit', (code) => resolve({ code, stdout, stderr }));
});
server.close();
const title = /<title>([^<]*)<\/title>/.exec(result.stdout)?.[1] ?? '';
if (!title.startsWith('OVERLAY_OK')) {
  console.error(result.stdout.slice(0, 1500));
  throw new Error(`overlay browser selftest failed: ${title || `exit ${result.code}`}`);
}
console.log('overlay browser selftest OK: render + Help collapse/drag/rect-refresh + actions + auto-deny');
