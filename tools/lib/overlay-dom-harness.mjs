// tools/lib/overlay-dom-harness.mjs —— 在真实 Chromium DOM 里跑内联浮层组件测试。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(process.cwd());

/** 找一个可用于 headless 的 Chromium 浏览器；找不到返回 null。 */
export function findBrowser() {
  const candidates = [];
  if (process.env.BRIDGE_EDGE) candidates.push(process.env.BRIDGE_EDGE);
  if (process.env.BRIDGE_CHROME) candidates.push(process.env.BRIDGE_CHROME);
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium');
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/**
 * 启动静态服务器并用 headless 浏览器跑一个页面，返回 <title>。
 * @param {string} pagePath 仓库内页面路径（例如 tests/browser/overlay-dom.html）
 * @param {{ timeoutMs?: number }} [options]
 */
export async function runHeadlessPage(pagePath, options = {}) {
  const browser = findBrowser();
  if (!browser) throw new Error('未找到 Edge/Chrome；设置 BRIDGE_EDGE 或 BRIDGE_CHROME 后重试');
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const target = normalize(join(ROOT, path));
    if (!target.startsWith(ROOT) || !existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveDone) => server.listen(0, '127.0.0.1', resolveDone));
  const { port } = server.address();
  try {
    const profile = join(tmpdir(), `bb-dom-${randomUUID()}`);
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=' + String(options.timeoutMs ?? 15000),
      '--dump-dom',
      `http://127.0.0.1:${port}/${pagePath.replace(/^\/+/, '')}`,
    ];
    const result = await new Promise((resolveDone, reject) => {
      const child = spawn(browser, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => resolveDone({ code, stdout, stderr }));
    });
    const title = /<title>([^<]*)<\/title>/i.exec(result.stdout)?.[1] ?? '';
    return { title, code: result.code, stdout: result.stdout, stderr: result.stderr };
  } finally {
    server.close();
  }
}

/** 跑真实内联浮层 DOM 组件测试，返回 { title, ... }。 */
export function runOverlayDomTests(options = {}) {
  return runHeadlessPage('tests/browser/overlay-dom.html', options);
}
