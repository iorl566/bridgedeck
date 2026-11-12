import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';

const root = process.cwd();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
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

const debugPort = await new Promise((resolve) => {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
});
const edge = process.env.BRIDGE_EDGE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!existsSync(edge)) throw new Error(`browser not found: ${edge}`);
const profile = join(tmpdir(), `bb-clock-${randomUUID()}`);
const child = spawn(edge, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, `http://127.0.0.1:${port}/tests/browser/cooperation-capture.html`], { windowsHide: true });

async function target() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === 'page' && item.url.includes('cooperation-capture.html'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* browser still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('CDP page target not available');
}

const socket = new WebSocket(await target());
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
};
function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

try {
  await command('Page.navigate', { url: `http://127.0.0.1:${port}/tests/browser/cooperation-capture.html` });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await evaluate(`(async () => {
    let handler;
    window.chrome = { runtime: { id: 'ext', getURL: (path) => location.origin + '/' + path, sendMessage: async () => ({}), onMessage: { addListener(fn) { handler = fn; }, removeListener() {} } } };
    const { attachCooperationCapture } = await import('http://127.0.0.1:${port}/extension/src/content/cooperation-capture.js');
    window.__dispose = attachCooperationCapture();
    window.__read = (lease) => new Promise((resolve) => handler({ kind: 'cooperation.read', lease }, {}, resolve));
    window.__arm = (input) => handler({ kind: 'cooperation.arm', lease: 'clock', input }, {}, () => {});
    const field = document.body.appendChild(document.createElement('input'));
    field.id = 'clock-field';
    field.focus();
    return true;
  })()`);
  await evaluate(`window.__read('clock')`);
  await evaluate(`window.__arm({ type: 'keydown', key: 'a', timestamp: Date.now() })`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const state = await evaluate(`window.__read('clock')`);
  const ok = state?.human >= 1 && state.events?.some((event) => ['input', 'keydown'].includes(event.type));
  if (!ok) throw new Error(`trusted input attribution missing: ${JSON.stringify(state)}`);
  const box = await evaluate(`(() => { const r = document.getElementById('clock-field').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const clicked = await evaluate(`window.__read('clock')`);
  if (!(clicked?.human >= 2 && clicked.events?.some((event) => event.type === 'click'))) {
    throw new Error(`trusted click attribution missing: ${JSON.stringify(clicked)}`);
  }
  await evaluate(`window.__arm({ type: 'pointerdown', x: ${box.x + 300}, y: ${box.y + 300}, timestamp: Date.now() })`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const mismatched = await evaluate(`window.__read('clock')`);
  const lastClick = [...(mismatched?.events ?? [])].reverse().find((event) => event.type === 'click');
  if (!lastClick?.attribution || lastClick.attribution.expected_type !== 'pointerdown') {
    throw new Error(`clock attribution missing: ${JSON.stringify(mismatched)}`);
  }
  const beforeHuman = mismatched.human;
  await evaluate(`window.__arm({ type: 'pointerdown', x: ${box.x}, y: ${box.y}, timestamp: Date.now() })`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const matched = await evaluate(`window.__read('clock')`);
  if (!(matched.human === beforeHuman && matched.pending === false)) {
    throw new Error(`matched clock window was not attributed to the agent: ${JSON.stringify(matched)}`);
  }
  console.log('cooperation input selftest OK: trusted key/click + clock mismatch attribution + matched agent click');
} finally {
  try { socket.close(); } catch { /* ignore */ }
  child.kill();
  server.close();
}
