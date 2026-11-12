import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

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
const profile = join(tmpdir(), `bb-content-${randomUUID()}`);
const url = `http://127.0.0.1:${port}/tests/browser/cooperation-capture.html`;
const result = await new Promise((resolve, reject) => {
  const child = spawn(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, '--virtual-time-budget=5000', '--dump-dom', url], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('exit', (code) => resolve({ code, stdout, stderr }));
});
server.close();
const title = /<title>([^<]*)<\/title>/.exec(result.stdout)?.[1] ?? '';
if (!title.startsWith('CONTENT_OK')) {
  console.error(result.stdout.slice(0, 2000));
  console.error(result.stderr.slice(0, 1000));
  throw new Error(`content browser selftest failed: ${title || `exit ${result.code}`}`);
}
console.log('content browser selftest OK: cooperation fields/media/progress + record capture + hover-surface');
